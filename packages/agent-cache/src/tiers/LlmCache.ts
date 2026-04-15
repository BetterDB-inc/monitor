import type { Valkey, LlmCacheParams, LlmStoreOptions, LlmCacheResult, ModelCost } from '../types';
import type { Telemetry } from '../telemetry';
import { ValkeyCommandError } from '../errors';
import { llmCacheHash, escapeGlobPattern } from '../utils';
import { clusterScan } from '../cluster';

export interface LlmCacheConfig {
  client: Valkey;
  name: string;
  defaultTtl: number | undefined;
  tierTtl: number | undefined;
  costTable: Record<string, ModelCost> | undefined;
  telemetry: Telemetry;
  statsKey: string;
}

interface StoredLlmEntry {
  response: string;
  model: string;
  storedAt: number;
  tokens?: { input: number; output: number };
  cost?: number;
}

export class LlmCache {
  private readonly client: Valkey;
  private readonly name: string;
  private readonly defaultTtl: number | undefined;
  private readonly tierTtl: number | undefined;
  private readonly costTable: Record<string, ModelCost> | undefined;
  private readonly telemetry: Telemetry;
  private readonly statsKey: string;

  constructor(config: LlmCacheConfig) {
    this.client = config.client;
    this.name = config.name;
    this.defaultTtl = config.defaultTtl;
    this.tierTtl = config.tierTtl;
    this.costTable = config.costTable;
    this.telemetry = config.telemetry;
    this.statsKey = config.statsKey;
  }

  private buildKey(hash: string): string {
    return `${this.name}:llm:${hash}`;
  }

  async check(params: LlmCacheParams): Promise<LlmCacheResult> {
    const startTime = Date.now();

    return this.telemetry.tracer.startActiveSpan('agent_cache.llm.check', async (span) => {
      try {
        const hash = llmCacheHash(params);
        const key = this.buildKey(hash);

        span.setAttribute('cache.key', key);
        span.setAttribute('cache.model', params.model);

        let raw: string | null;
        try {
          raw = await this.client.get(key);
        } catch (err) {
          throw new ValkeyCommandError('GET', err);
        }

        const duration = (Date.now() - startTime) / 1000;
        this.telemetry.metrics.operationDuration
          .labels(this.name, 'llm', 'check')
          .observe(duration);

        if (raw) {
          let entry: StoredLlmEntry;
          try {
            entry = JSON.parse(raw);
          } catch {
            // Corrupt cache entry - await delete to guarantee cleanup before returning miss
            await this.client.del(key).catch(() => {});
            try {
              const statsPipeline = this.client.pipeline();
              statsPipeline.hincrby(this.statsKey, 'llm:misses', 1);
              await statsPipeline.exec();
            } catch {
              // Stats update failure should not break the cache
            }
            this.telemetry.metrics.requestsTotal
              .labels(this.name, 'llm', 'miss', '')
              .inc();
            span.setAttribute('cache.hit', false);
            span.setAttribute('cache.corrupt', true);
            span.end();
            return { hit: false, tier: 'llm' as const };
          }

          // Record hit + cost savings in a single pipeline to reduce round-trips
          try {
            const statsPipeline = this.client.pipeline();
            statsPipeline.hincrby(this.statsKey, 'llm:hits', 1);
            if (entry.cost !== undefined) {
              const costMicros = Math.round(entry.cost * 1_000_000);
              statsPipeline.hincrby(this.statsKey, 'cost_saved_micros', costMicros);
            }
            await statsPipeline.exec();
          } catch {
            // Stats update failure should not break the cache
          }

          // Track cost in Prometheus (outside pipeline since it's local)
          if (entry.cost !== undefined) {
            this.telemetry.metrics.costSaved
              .labels(this.name, 'llm', entry.model, '')
              .inc(entry.cost);
          }

          this.telemetry.metrics.requestsTotal
            .labels(this.name, 'llm', 'hit', '')
            .inc();

          span.setAttribute('cache.hit', true);
          span.end();

          return {
            hit: true,
            response: entry.response,
            key,
            tier: 'llm' as const,
          };
        }

        // Record miss via pipeline for consistency with hit path and tool cache
        try {
          const statsPipeline = this.client.pipeline();
          statsPipeline.hincrby(this.statsKey, 'llm:misses', 1);
          await statsPipeline.exec();
        } catch {
          // Stats update failure should not break the cache
        }

        this.telemetry.metrics.requestsTotal
          .labels(this.name, 'llm', 'miss', '')
          .inc();

        span.setAttribute('cache.hit', false);
        span.end();

        return {
          hit: false,
          tier: 'llm' as const,
        };
      } catch (err) {
        span.recordException(err as Error);
        span.end();
        throw err;
      }
    });
  }

  async store(params: LlmCacheParams, response: string, options?: LlmStoreOptions): Promise<string> {
    const startTime = Date.now();

    return this.telemetry.tracer.startActiveSpan('agent_cache.llm.store', async (span) => {
      try {
        const hash = llmCacheHash(params);
        const key = this.buildKey(hash);

        span.setAttribute('cache.key', key);
        span.setAttribute('cache.model', params.model);

        const entry: StoredLlmEntry = {
          response,
          model: params.model,
          storedAt: Date.now(),
          tokens: options?.tokens,
        };

        // Calculate and store cost if costTable and tokens are provided
        // Cost tracking happens at check() time on hit, not here at store() time
        if (this.costTable && options?.tokens) {
          const modelCost = this.costTable[params.model];
          if (modelCost) {
            const inputCost = (options.tokens.input / 1000) * modelCost.inputPer1k;
            const outputCost = (options.tokens.output / 1000) * modelCost.outputPer1k;
            entry.cost = inputCost + outputCost;
          }
        }

        const valueJson = JSON.stringify(entry);

        // Use SET with EX option for atomic set+expire to prevent orphaned keys
        const ttl = options?.ttl ?? this.tierTtl ?? this.defaultTtl;
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
          .labels(this.name, 'llm')
          .inc(byteLength);

        const duration = (Date.now() - startTime) / 1000;
        this.telemetry.metrics.operationDuration
          .labels(this.name, 'llm', 'store')
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

  async invalidateByModel(model: string): Promise<number> {
    return this.telemetry.tracer.startActiveSpan('agent_cache.llm.invalidateByModel', async (span) => {
      try {
        span.setAttribute('cache.model', model);

        // Escape cache name in case it contains glob metacharacters
        const pattern = `${escapeGlobPattern(this.name)}:llm:*`;
        let deletedCount = 0;

        await clusterScan(this.client, pattern, async (keys, nodeClient) => {
          // Batch GET all keys in this SCAN page using pipeline
          const getPipeline = nodeClient.pipeline();
          for (const key of keys) {
            getPipeline.get(key);
          }

          let getResults: Array<[Error | null, string | null]>;
          try {
            getResults = await getPipeline.exec() as Array<[Error | null, string | null]>;
          } catch (err) {
            throw new ValkeyCommandError('GET (pipeline)', err);
          }

          // Collect keys that match the model
          const keysToDelete: string[] = [];
          for (let i = 0; i < keys.length; i++) {
            const [err, raw] = getResults[i];
            if (err || !raw) continue;

            try {
              const entry: StoredLlmEntry = JSON.parse(raw);
              if (entry.model === model) {
                keysToDelete.push(keys[i]);
              }
            } catch {
              // Skip corrupt entries
            }
          }

          // Batch DEL matching keys
          if (keysToDelete.length > 0) {
            try {
              const deleted = await nodeClient.del(...keysToDelete);
              deletedCount += deleted;
            } catch (err) {
              throw new ValkeyCommandError('DEL', err);
            }
          }
        });

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
}
