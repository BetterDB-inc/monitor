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
import { createAnalytics, NOOP_ANALYTICS, type Analytics } from './analytics';
import { ValkeyCommandError } from './errors';
import { escapeGlobPattern } from './utils';
import { clusterScan } from './cluster';

export class AgentCache {
  public readonly llm: LlmCache;
  public readonly tool: ToolCache;
  public readonly session: SessionStore;

  private readonly client: Valkey;
  private readonly name: string;
  private readonly statsKey: string;
  private readonly defaultTtl: number | undefined;
  private readonly toolTierTtl: number | undefined;
  private analytics: Analytics = NOOP_ANALYTICS;
  private statsTimer: ReturnType<typeof setInterval> | undefined;
  private shutdownCalled = false;

  constructor(options: AgentCacheOptions) {
    this.client = options.client;
    this.name = options.name ?? 'betterdb_ac';
    this.statsKey = `${this.name}:__stats`;
    this.defaultTtl = options.defaultTtl;
    this.toolTierTtl = options.tierDefaults?.tool?.ttl;

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

    // Fire-and-forget: initialize product analytics
    const analyticsOpts = options.analytics;
    createAnalytics({
      apiKey: analyticsOpts?.apiKey,
      host: analyticsOpts?.host,
      disabled: analyticsOpts?.disabled,
    })
      .then((a) => {
        if (this.shutdownCalled) {
          // If shutdown won the race, ensure the late-created analytics client
          // is also torn down so its internal timers do not keep the process alive.
          return a.shutdown();
        }
        this.analytics = a;
        const configProps: Record<string, unknown> = {
          defaultTtl: options.defaultTtl,
          llmTtl: options.tierDefaults?.llm?.ttl,
          toolTtl: options.tierDefaults?.tool?.ttl,
          sessionTtl: options.tierDefaults?.session?.ttl,
          hasCostTable: !!options.costTable,
        };
        return a.init(this.client, this.name, configProps);
      })
      .then(() => {
        if (this.shutdownCalled) return;
        const intervalMs = analyticsOpts?.statsIntervalMs ?? 300_000;
        if (intervalMs > 0) {
          this.statsTimer = setInterval(() => this.captureStatsSnapshot(), intervalMs);
          this.statsTimer.unref();
        }
      })
      .catch(() => {});
  }

  async stats(): Promise<AgentCacheStats> {
    let raw: Record<string, string>;
    try {
      raw = await this.client.hgetall(this.statsKey) ?? {};
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
    for (const perToolEntry of Object.values(perTool)) {
      perToolEntry.hitRate = computeHitRate(perToolEntry.hits, perToolEntry.misses);
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

      // Resolve effective TTL through full hierarchy: policy -> tierTtl -> defaultTtl
      const policyTtl = this.tool.getPolicy(toolName)?.ttl;
      const effectiveTtl = policyTtl ?? this.toolTierTtl ?? this.defaultTtl;

      // Generate recommendation based on hit rate and effective TTL
      let recommendation: ToolRecommendation;

      if (toolStats.hitRate > 0.8) {
        // High hit rate - consider increasing TTL (unless already > 1 hour or no TTL)
        if (effectiveTtl !== undefined && effectiveTtl < 3600) {
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

  private captureStatsSnapshot(): void {
    this.stats()
      .then((s) => {
        this.analytics.capture('stats_snapshot', {
          llm_hits: s.llm.hits,
          llm_misses: s.llm.misses,
          llm_hit_rate: s.llm.hitRate,
          tool_hits: s.tool.hits,
          tool_misses: s.tool.misses,
          tool_hit_rate: s.tool.hitRate,
          session_reads: s.session.reads,
          session_writes: s.session.writes,
          cost_saved_micros: s.costSavedMicros,
          tool_count: Object.keys(s.perTool).length,
        });
      })
      .catch(() => {});
  }

  async shutdown(): Promise<void> {
    this.shutdownCalled = true;
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = undefined;
    }
    await this.analytics.shutdown();
  }

  async flush(): Promise<void> {
    // Escape cache name in case it contains glob metacharacters
    const pattern = `${escapeGlobPattern(this.name)}:*`;

    try {
      await clusterScan(this.client, pattern, async (keys, nodeClient) => {
        try {
          await nodeClient.del(...keys);
        } catch (err) {
          throw new ValkeyCommandError('DEL', err);
        }
      });
    } finally {
      // Always reset in-memory state even on partial failure — leaving stale
      // sessions or policies after some keys were deleted would be worse than
      // resetting eagerly and requiring a reload on the next operation.
      this.session.resetTracker();
      this.tool.resetPolicies();
      this.analytics.capture('cache_flush');
    }
  }
}
