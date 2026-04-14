import type { Valkey, ToolStoreOptions, ToolCacheResult, ToolPolicy } from '../types';
import type { Telemetry } from '../telemetry';
import { ValkeyCommandError, AgentCacheUsageError } from '../errors';
import { toolCacheHash, escapeGlobPattern, validateNoGlobChars } from '../utils';

/**
 * Validate that tool name doesn't contain colons, which are used as key delimiters.
 * Tool names with colons would break stats parsing in AgentCache.stats().
 */
function validateToolName(toolName: string): void {
  if (toolName.includes(':')) {
    throw new AgentCacheUsageError(
      `Tool name "${toolName}" contains colon (:). ` +
      `Colons are not allowed in tool names as they are used as key delimiters.`
    );
  }
}

export interface ToolCacheConfig {
  client: Valkey;
  name: string;
  defaultTtl: number | undefined;
  tierTtl: number | undefined;
  telemetry: Telemetry;
  statsKey: string;
}

interface StoredToolEntry {
  response: string;
  toolName: string;
  args: unknown;
  storedAt: number;
  cost?: number;
}

export class ToolCache {
  private readonly client: Valkey;
  private readonly name: string;
  private readonly defaultTtl: number | undefined;
  private readonly tierTtl: number | undefined;
  private readonly telemetry: Telemetry;
  private readonly statsKey: string;
  private readonly policies: Map<string, ToolPolicy> = new Map();
  private readonly policiesKey: string;

  constructor(config: ToolCacheConfig) {
    this.client = config.client;
    this.name = config.name;
    this.defaultTtl = config.defaultTtl;
    this.tierTtl = config.tierTtl;
    this.telemetry = config.telemetry;
    this.statsKey = config.statsKey;
    this.policiesKey = `${this.name}:__tool_policies`;
  }

  private buildKey(toolName: string, hash: string): string {
    return `${this.name}:tool:${toolName}:${hash}`;
  }

  async check(toolName: string, args: unknown): Promise<ToolCacheResult> {
    validateToolName(toolName);
    const startTime = Date.now();

    return this.telemetry.tracer.startActiveSpan('agent_cache.tool.check', async (span) => {
      try {
        const hash = toolCacheHash(args);
        const key = this.buildKey(toolName, hash);

        span.setAttribute('cache.key', key);
        span.setAttribute('cache.tool_name', toolName);

        let raw: string | null;
        try {
          raw = await this.client.get(key);
        } catch (err) {
          throw new ValkeyCommandError('GET', err);
        }

        const duration = (Date.now() - startTime) / 1000;
        this.telemetry.metrics.operationDuration
          .labels(this.name, 'tool', 'check')
          .observe(duration);

        if (raw) {
          let entry: StoredToolEntry;
          try {
            entry = JSON.parse(raw);
          } catch {
            // Corrupt cache entry - treat as miss (batch into pipeline)
            try {
              const statsPipeline = this.client.pipeline();
              statsPipeline.hincrby(this.statsKey, 'tool:misses', 1);
              statsPipeline.hincrby(this.statsKey, `tool:${toolName}:misses`, 1);
              await statsPipeline.exec();
            } catch {
              // Stats update failure should not break the cache
            }
            this.telemetry.metrics.requestsTotal
              .labels(this.name, 'tool', 'miss', toolName)
              .inc();
            span.setAttribute('cache.hit', false);
            span.setAttribute('cache.corrupt', true);
            span.end();
            return { hit: false, tier: 'tool' as const, toolName };
          }

          // Record tier-level and per-tool hit + cost savings in a single pipeline
          try {
            const statsPipeline = this.client.pipeline();
            statsPipeline.hincrby(this.statsKey, 'tool:hits', 1);
            statsPipeline.hincrby(this.statsKey, `tool:${toolName}:hits`, 1);
            if (entry.cost !== undefined) {
              const costMicros = Math.round(entry.cost * 1_000_000);
              statsPipeline.hincrby(this.statsKey, 'cost_saved_micros', costMicros);
              statsPipeline.hincrby(this.statsKey, `tool:${toolName}:cost_saved_micros`, costMicros);
            }
            await statsPipeline.exec();
          } catch {
            // Stats update failure should not break the cache
          }

          // Track cost in Prometheus (outside pipeline since it's local)
          if (entry.cost !== undefined) {
            this.telemetry.metrics.costSaved
              .labels(this.name, 'tool', '', toolName)
              .inc(entry.cost);
          }

          this.telemetry.metrics.requestsTotal
            .labels(this.name, 'tool', 'hit', toolName)
            .inc();

          span.setAttribute('cache.hit', true);
          span.end();

          return {
            hit: true,
            response: entry.response,
            key,
            tier: 'tool' as const,
            toolName,
          };
        }

        // Record tier-level and per-tool miss (batch into pipeline)
        try {
          const statsPipeline = this.client.pipeline();
          statsPipeline.hincrby(this.statsKey, 'tool:misses', 1);
          statsPipeline.hincrby(this.statsKey, `tool:${toolName}:misses`, 1);
          await statsPipeline.exec();
        } catch {
          // Stats update failure should not break the cache
        }

        this.telemetry.metrics.requestsTotal
          .labels(this.name, 'tool', 'miss', toolName)
          .inc();

        span.setAttribute('cache.hit', false);
        span.end();

        return {
          hit: false,
          tier: 'tool' as const,
          toolName,
        };
      } catch (err) {
        span.recordException(err as Error);
        span.end();
        throw err;
      }
    });
  }

  async store(toolName: string, args: unknown, response: string, options?: ToolStoreOptions): Promise<string> {
    validateToolName(toolName);
    const startTime = Date.now();

    return this.telemetry.tracer.startActiveSpan('agent_cache.tool.store', async (span) => {
      try {
        const hash = toolCacheHash(args);
        const key = this.buildKey(toolName, hash);

        span.setAttribute('cache.key', key);
        span.setAttribute('cache.tool_name', toolName);

        // Store cost in entry - cost tracking happens at check() time on hit, not here
        const entry: StoredToolEntry = {
          response,
          toolName,
          args,
          storedAt: Date.now(),
          cost: options?.cost,
        };

        const valueJson = JSON.stringify(entry);

        // TTL resolution order: per-call -> policy -> tier -> default
        const policy = this.policies.get(toolName);
        const ttl = options?.ttl ?? policy?.ttl ?? this.tierTtl ?? this.defaultTtl;

        // Use SET with EX option for atomic set+expire to prevent orphaned keys
        try {
          if (ttl !== undefined) {
            await this.client.set(key, valueJson, 'EX', ttl);
          } else {
            await this.client.set(key, valueJson);
          }
        } catch (err) {
          throw new ValkeyCommandError('SET', err);
        }

        // Track stored bytes (measure valueJson, not just response, since that's what's stored)
        const byteLength = Buffer.byteLength(valueJson, 'utf8');
        this.telemetry.metrics.storedBytes
          .labels(this.name, 'tool')
          .inc(byteLength);

        const duration = (Date.now() - startTime) / 1000;
        this.telemetry.metrics.operationDuration
          .labels(this.name, 'tool', 'store')
          .observe(duration);

        span.setAttribute('cache.ttl', ttl ?? -1);
        span.setAttribute('cache.bytes', byteLength);
        span.end();

        return key;
      } catch (err) {
        span.recordException(err as Error);
        span.end();
        throw err;
      }
    });
  }

  async setPolicy(toolName: string, policy: ToolPolicy): Promise<void> {
    validateToolName(toolName);
    this.policies.set(toolName, policy);

    // Persist to Valkey
    try {
      await this.client.hset(this.policiesKey, toolName, JSON.stringify(policy));
    } catch (err) {
      throw new ValkeyCommandError('HSET', err);
    }
  }

  getPolicy(toolName: string): ToolPolicy | undefined {
    return this.policies.get(toolName);
  }

  async invalidateByTool(toolName: string): Promise<number> {
    // Reject glob metacharacters to prevent matching unintended keys
    validateNoGlobChars(toolName, 'toolName');

    return this.telemetry.tracer.startActiveSpan('agent_cache.tool.invalidateByTool', async (span) => {
      try {
        span.setAttribute('cache.tool_name', toolName);

        // Escape cache name in case it contains glob metacharacters
        const pattern = `${escapeGlobPattern(this.name)}:tool:${toolName}:*`;
        let cursor = '0';
        let deletedCount = 0;

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
              const deleted = await this.client.del(...keys);
              deletedCount += deleted;
            } catch (err) {
              throw new ValkeyCommandError('DEL', err);
            }
          }
        } while (cursor !== '0');

        span.setAttribute('cache.deleted_count', deletedCount);
        span.end();

        return deletedCount;
      } catch (err) {
        span.recordException(err as Error);
        span.end();
        throw err;
      }
    });
  }

  async invalidate(toolName: string, args: unknown): Promise<boolean> {
    const hash = toolCacheHash(args);
    const key = this.buildKey(toolName, hash);

    try {
      const deleted = await this.client.del(key);
      return deleted > 0;
    } catch (err) {
      throw new ValkeyCommandError('DEL', err);
    }
  }

  async loadPolicies(): Promise<void> {
    try {
      const raw = await this.client.hgetall(this.policiesKey);
      if (raw) {
        for (const [toolName, policyJson] of Object.entries(raw)) {
          try {
            const policy: ToolPolicy = JSON.parse(policyJson);
            this.policies.set(toolName, policy);
          } catch {
            // Skip corrupt policy entries
          }
        }
      }
    } catch {
      // Non-blocking: failure to load policies should not break initialization.
      // Silently swallow - libraries should not write to console.
    }
  }

  /**
   * Clear in-memory tool policies. Called by AgentCache.flush() to stay in sync
   * after all Valkey keys (including __tool_policies) are deleted.
   */
  resetPolicies(): void {
    this.policies.clear();
  }
}
