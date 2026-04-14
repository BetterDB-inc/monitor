import type {
  Valkey,
  AgentCacheOptions,
  AgentCacheStats,
  ToolEffectivenessEntry,
  ToolRecommendation,
  TierStats,
  SessionStats,
  ToolStats,
} from './types';
import { LlmCache } from './tiers/LlmCache';
import { ToolCache } from './tiers/ToolCache';
import { SessionStore } from './tiers/SessionStore';
import { createTelemetry } from './telemetry';
import { ValkeyCommandError } from './errors';

export class AgentCache {
  public readonly llm: LlmCache;
  public readonly tool: ToolCache;
  public readonly session: SessionStore;

  private readonly client: Valkey;
  private readonly name: string;
  private readonly statsKey: string;

  constructor(options: AgentCacheOptions) {
    this.client = options.client;
    this.name = options.name ?? 'betterdb_ac';
    this.statsKey = `${this.name}:__stats`;

    const telemetry = createTelemetry({
      prefix: options.telemetry?.metricsPrefix ?? 'agent_cache',
      tracerName: options.telemetry?.tracerName ?? '@betterdb/agent-cache',
      registry: options.telemetry?.registry,
    });

    const defaultTtl = options.defaultTtl;

    this.llm = new LlmCache({
      client: this.client,
      name: this.name,
      defaultTtl,
      tierTtl: options.tierDefaults?.llm?.ttl,
      costTable: options.costTable,
      telemetry,
      statsKey: this.statsKey,
    });

    this.tool = new ToolCache({
      client: this.client,
      name: this.name,
      defaultTtl,
      tierTtl: options.tierDefaults?.tool?.ttl,
      telemetry,
      statsKey: this.statsKey,
    });

    this.session = new SessionStore({
      client: this.client,
      name: this.name,
      defaultTtl,
      tierTtl: options.tierDefaults?.session?.ttl,
      telemetry,
      statsKey: this.statsKey,
    });

    // Fire-and-forget: load persisted tool policies from Valkey
    this.tool.loadPolicies().catch(() => {});
  }

  async stats(): Promise<AgentCacheStats> {
    let raw: Record<string, string>;
    try {
      raw = await this.client.hgetall(this.statsKey);
    } catch (err) {
      throw new ValkeyCommandError('HGETALL', err);
    }

    const getInt = (field: string): number => {
      const val = raw[field];
      return val ? parseInt(val, 10) : 0;
    };

    const computeHitRate = (hits: number, misses: number): number => {
      const total = hits + misses;
      return total > 0 ? hits / total : 0;
    };

    // LLM tier stats
    const llmHits = getInt('llm:hits');
    const llmMisses = getInt('llm:misses');
    const llmTotal = llmHits + llmMisses;
    const llmStats: TierStats = {
      hits: llmHits,
      misses: llmMisses,
      total: llmTotal,
      hitRate: computeHitRate(llmHits, llmMisses),
    };

    // Tool tier stats
    const toolHits = getInt('tool:hits');
    const toolMisses = getInt('tool:misses');
    const toolTotal = toolHits + toolMisses;
    const toolStats: TierStats = {
      hits: toolHits,
      misses: toolMisses,
      total: toolTotal,
      hitRate: computeHitRate(toolHits, toolMisses),
    };

    // Session stats
    const sessionStats: SessionStats = {
      reads: getInt('session:reads'),
      writes: getInt('session:writes'),
    };

    // Cost saved
    const costSavedMicros = getInt('cost_saved_micros');

    // Per-tool stats
    const perTool: Record<string, ToolStats> = {};
    const toolPattern = /^tool:([^:]+):(hits|misses|cost_saved_micros)$/;

    for (const [key, value] of Object.entries(raw)) {
      const match = key.match(toolPattern);
      if (match) {
        const toolName = match[1];
        const statType = match[2];
        const numValue = parseInt(value, 10);

        if (!perTool[toolName]) {
          perTool[toolName] = {
            hits: 0,
            misses: 0,
            hitRate: 0,
            ttl: this.tool.getPolicy(toolName)?.ttl,
            costSavedMicros: 0,
          };
        }

        if (statType === 'hits') {
          perTool[toolName].hits = numValue;
        } else if (statType === 'misses') {
          perTool[toolName].misses = numValue;
        } else if (statType === 'cost_saved_micros') {
          perTool[toolName].costSavedMicros = numValue;
        }
      }
    }

    // Compute hit rates for per-tool stats
    for (const toolStats of Object.values(perTool)) {
      toolStats.hitRate = computeHitRate(toolStats.hits, toolStats.misses);
    }

    return {
      llm: llmStats,
      tool: toolStats,
      session: sessionStats,
      costSavedMicros,
      perTool,
    };
  }

  async toolEffectiveness(): Promise<ToolEffectivenessEntry[]> {
    // Reuse data already fetched by stats() to avoid N+1 queries
    const stats = await this.stats();
    const entries: ToolEffectivenessEntry[] = [];

    for (const [toolName, toolStats] of Object.entries(stats.perTool)) {
      // Cost saved is already computed in perTool from the single HGETALL call (microdollars -> dollars)
      const costSaved = toolStats.costSavedMicros / 1_000_000;

      // Generate recommendation based on hit rate
      let recommendation: ToolRecommendation;
      const ttl = this.tool.getPolicy(toolName)?.ttl;

      if (toolStats.hitRate > 0.8) {
        // High hit rate - consider increasing TTL (unless already > 1 hour)
        if (ttl !== undefined && ttl < 3600) {
          recommendation = 'increase_ttl';
        } else {
          recommendation = 'optimal';
        }
      } else if (toolStats.hitRate >= 0.4) {
        recommendation = 'optimal';
      } else {
        recommendation = 'decrease_ttl_or_disable';
      }

      entries.push({
        tool: toolName,
        hitRate: toolStats.hitRate,
        costSaved,
        recommendation,
      });
    }

    // Sort by costSaved descending
    entries.sort((a, b) => b.costSaved - a.costSaved);

    return entries;
  }

  async flush(): Promise<void> {
    const pattern = `${this.name}:*`;
    let cursor = '0';

    do {
      let scanResult: [string, string[]];
      try {
        scanResult = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      } catch (err) {
        throw new ValkeyCommandError('SCAN', err);
      }

      cursor = scanResult[0];
      const keys = scanResult[1];

      if (keys.length > 0) {
        try {
          await this.client.del(...keys);
        } catch (err) {
          throw new ValkeyCommandError('DEL', err);
        }
      }
    } while (cursor !== '0');
  }
}
