import type { Valkey, LlmCacheParams, LlmStoreOptions, LlmCacheResult, ModelCost } from '../types';
import type { Telemetry } from '../telemetry';
import { ValkeyCommandError } from '../errors';
import { llmCacheHash } from '../utils';

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
          const entry: StoredLlmEntry = JSON.parse(raw);

          // Record hit
          try {
            await this.client.hincrby(this.statsKey, 'llm:hits', 1);
          } catch {
            // Stats update failure should not break the cache
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

        // Record miss
        try {
          await this.client.hincrby(this.statsKey, 'llm:misses', 1);
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

        // Calculate cost if costTable and tokens are provided
        if (this.costTable && options?.tokens) {
          const modelCost = this.costTable[params.model];
          if (modelCost) {
            const inputCost = (options.tokens.input / 1000) * modelCost.inputPer1k;
            const outputCost = (options.tokens.output / 1000) * modelCost.outputPer1k;
            entry.cost = inputCost + outputCost;

            // Track cost saved in stats (cents)
            const costCents = Math.round(entry.cost * 100);
            try {
              await this.client.hincrby(this.statsKey, 'cost_saved_cents', costCents);
            } catch {
              // Stats update failure should not break the cache
            }

            this.telemetry.metrics.costSaved
              .labels(this.name, 'llm', params.model, '')
              .inc(entry.cost);
          }
        }

        const valueJson = JSON.stringify(entry);

        try {
          await this.client.set(key, valueJson);
        } catch (err) {
          throw new ValkeyCommandError('SET', err);
        }

        // Set TTL if configured
        const ttl = options?.ttl ?? this.tierTtl ?? this.defaultTtl;
        if (ttl !== undefined) {
          try {
            await this.client.expire(key, ttl);
          } catch (err) {
            throw new ValkeyCommandError('EXPIRE', err);
          }
        }

        // Track stored bytes
        const byteLength = Buffer.byteLength(response, 'utf8');
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

        const pattern = `${this.name}:llm:*`;
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

          for (const key of keys) {
            try {
              const raw = await this.client.get(key);
              if (raw) {
                const entry: StoredLlmEntry = JSON.parse(raw);
                if (entry.model === model) {
                  await this.client.del(key);
                  deletedCount++;
                }
              }
            } catch {
              // Skip corrupt entries
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
}
