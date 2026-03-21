import { randomUUID } from 'crypto';
import { SpanStatusCode } from '@opentelemetry/api';
import type {
  SemanticCacheOptions,
  CacheCheckOptions,
  CacheStoreOptions,
  CacheCheckResult,
  CacheConfidence,
  CacheStats,
  IndexInfo,
  InvalidateResult,
  Valkey,
  EmbedFn,
} from './types';
import {
  SemanticCacheUsageError,
  EmbeddingError,
  ValkeyCommandError,
} from './errors';
import { createTelemetry, type Telemetry } from './telemetry';
import { encodeFloat32, parseFtSearchResponse } from './utils';

export class SemanticCache {
  private readonly client: Valkey;
  private readonly embedFn: EmbedFn;
  private readonly name: string;
  private readonly indexName: string;
  private readonly entryPrefix: string;
  private readonly statsKey: string;
  private readonly defaultThreshold: number;
  private readonly defaultTtl: number | undefined;
  private readonly categoryThresholds: Record<string, number>;
  private readonly uncertaintyBand: number;
  private readonly telemetry: Telemetry;

  private _initialized = false;
  private _dimension = 0;
  private _initPromise: Promise<void> | null = null;

  /**
   * Creates a new SemanticCache instance.
   *
   * The caller owns the iovalkey client lifecycle. SemanticCache does not
   * close or disconnect the client when it is done. Call client.quit() or
   * client.disconnect() yourself when the application shuts down.
   *
   * Call initialize() before using check() or store().
   */
  constructor(options: SemanticCacheOptions) {
    this.client = options.client;
    this.embedFn = options.embedFn;
    this.name = options.name ?? 'betterdb_scache';
    this.indexName = `${this.name}:idx`;
    this.entryPrefix = `${this.name}:entry:`;
    this.statsKey = `${this.name}:__stats`;
    this.defaultThreshold = options.defaultThreshold ?? 0.1;
    this.defaultTtl = options.defaultTtl;
    this.categoryThresholds = options.categoryThresholds ?? {};
    this.uncertaintyBand = options.uncertaintyBand ?? 0.05;

    this.telemetry = createTelemetry({
      prefix: options.telemetry?.metricsPrefix ?? 'semantic_cache',
      tracerName: options.telemetry?.tracerName ?? '@betterdb/semantic-cache',
      registry: options.telemetry?.registry,
    });
  }

  async initialize(): Promise<void> {
    if (!this._initPromise) {
      this._initPromise = this._doInitialize().catch((err) => {
        this._initPromise = null; // allow retry on failure
        throw err;
      });
    }
    return this._initPromise;
  }

  private async _doInitialize(): Promise<void> {
    const startTime = performance.now();
    return this.telemetry.tracer.startActiveSpan('semantic_cache.initialize', async (span) => {
      try {
        try {
          const info = (await this.client.call('FT.INFO', this.indexName)) as unknown[];
          this._dimension = this.parseDimensionFromInfo(info);

          // If we couldn't parse dimension from FT.INFO (e.g. unexpected schema
          // variant), fall back to a probe embedding rather than initializing
          // with dimension 0 which would make every store() fail.
          if (this._dimension === 0) {
            let probeVec: number[];
            try {
              probeVec = await this.embedFn('probe');
            } catch (embedErr) {
              throw new EmbeddingError(
                `embedFn failed during dimension probe: ${embedErr instanceof Error ? embedErr.message : String(embedErr)}`,
                embedErr,
              );
            }
            this._dimension = probeVec.length;
          }

          this._initialized = true;
        } catch (err: unknown) {
          const message =
            err instanceof Error ? err.message : String(err);
          // Valkey Search 1.2 returns "Index with name '...' not found in database 0"
          // rather than "Unknown Index name" (Redis/RediSearch convention) or
          // "no such index". We check all three patterns for cross-compatibility.
          if (
            message.toLowerCase().includes('unknown index name') ||
            message.toLowerCase().includes('no such index') ||
            message.toLowerCase().includes('not found')
          ) {
            let probeVec: number[];
            try {
              probeVec = await this.embedFn('probe');
            } catch (embedErr) {
              throw new EmbeddingError(
                `embedFn failed: ${embedErr instanceof Error ? embedErr.message : String(embedErr)}`,
                embedErr,
              );
            }

            this._dimension = probeVec.length;

            try {
              await this.client.call(
                'FT.CREATE',
                this.indexName,
                'ON',
                'HASH',
                'PREFIX',
                '1',
                this.entryPrefix,
                'SCHEMA',
                'prompt',
                'TEXT',
                'NOSTEM',
                'response',
                'TEXT',
                'NOSTEM',
                'model',
                'TAG',
                'category',
                'TAG',
                'inserted_at',
                'NUMERIC',
                'SORTABLE',
                'embedding',
                'VECTOR',
                'HNSW',
                '6',
                'TYPE',
                'FLOAT32',
                'DIM',
                String(this._dimension),
                'DISTANCE_METRIC',
                'COSINE',
              );
            } catch (createErr) {
              throw new ValkeyCommandError('FT.CREATE', createErr);
            }

            this._initialized = true;
          } else {
            throw new ValkeyCommandError('FT.INFO', err);
          }
        }

        span.setStatus({ code: SpanStatusCode.OK });
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
        throw err;
      } finally {
        span.end();
        const duration = (performance.now() - startTime) / 1000;
        this.telemetry.metrics.operationDuration
          .labels({ cache_name: this.name, operation: 'initialize' })
          .observe(duration);
      }
    });
  }

  async check(prompt: string, options?: CacheCheckOptions): Promise<CacheCheckResult> {
    if (!this._initialized) {
      throw new SemanticCacheUsageError(
        'SemanticCache.initialize() must be called before check() or store().',
      );
    }

    const startTime = performance.now();
    return this.telemetry.tracer.startActiveSpan('semantic_cache.check', async (span) => {
      try {
        const category = options?.category ?? '';
        const k = options?.k ?? 1;
        const threshold =
          options?.threshold ??
          (category && this.categoryThresholds[category] !== undefined
            ? this.categoryThresholds[category]
            : this.defaultThreshold);

        // Embed the prompt
        const embedStart = performance.now();
        let embedding: number[];
        try {
          embedding = await this.embedFn(prompt);
        } catch (err) {
          throw new EmbeddingError(
            `embedFn failed: ${err instanceof Error ? err.message : String(err)}`,
            err,
          );
        }
        const embedDuration = (performance.now() - embedStart) / 1000;
        this.telemetry.metrics.embeddingDuration
          .labels({ cache_name: this.name })
          .observe(embedDuration);

        // Build query and search
        const searchStart = performance.now();
        const filter = options?.filter;
        const query = `${filter ? `(${filter})` : '*'}=>[KNN ${k} @embedding $vec AS __score]`;
        const encodedVec = encodeFloat32(embedding);

        let rawResult: unknown;
        try {
          // Omit RETURN and SORTBY: Valkey Search 1.2 rejects computed KNN
          // aliases (e.g. __score) in both clauses. Without RETURN, all stored
          // fields plus __score are returned automatically. KNN results are
          // already sorted by distance (nearest first).
          rawResult = await this.client.call(
            'FT.SEARCH',
            this.indexName,
            query,
            'PARAMS',
            '2',
            'vec',
            encodedVec,
            'LIMIT',
            '0',
            String(k),
            'DIALECT',
            '2',
          );
        } catch (err) {
          throw new ValkeyCommandError('FT.SEARCH', err);
        }

        const parsed = parseFtSearchResponse(rawResult);

        const categoryLabel = category || 'none';

        if (parsed.length === 0) {
          // Batch the two HINCRBY calls into a single pipeline send.
          // Note: pipelines are NOT atomic — they batch network round-trips,
          // not operations. Use MULTI/EXEC if atomicity is required.
          // For stats counters, eventual consistency is acceptable.
          const pipeline = this.client.pipeline();
          pipeline.hincrby(this.statsKey, 'total', 1);
          pipeline.hincrby(this.statsKey, 'misses', 1);
          await pipeline.exec();

          this.telemetry.metrics.requestsTotal
            .labels({ cache_name: this.name, result: 'miss', category: categoryLabel })
            .inc();

          const searchDurationMiss = (performance.now() - searchStart) / 1000;
          span.setAttributes({
            'cache.hit': false,
            'cache.name': this.name,
            'cache.category': categoryLabel,
            'embedding_latency_ms': embedDuration * 1000,
            'search_latency_ms': searchDurationMiss * 1000,
          });
          span.setStatus({ code: SpanStatusCode.OK });

          return { hit: false, confidence: 'miss' as const };
        }

        const firstResult = parsed[0];
        const scoreStr = firstResult.fields['__score'];
        const score = scoreStr !== undefined ? parseFloat(scoreStr) : NaN;

        if (!isNaN(score)) {
          this.telemetry.metrics.similarityScore
            .labels({ cache_name: this.name, category: categoryLabel })
            .observe(score);
        }

        if (isNaN(score) || score > threshold) {
          // Miss with a candidate
          const pipeline = this.client.pipeline();
          pipeline.hincrby(this.statsKey, 'total', 1);
          pipeline.hincrby(this.statsKey, 'misses', 1);
          await pipeline.exec();

          this.telemetry.metrics.requestsTotal
            .labels({ cache_name: this.name, result: 'miss', category: categoryLabel })
            .inc();

          const searchDurationNearMiss = (performance.now() - searchStart) / 1000;
          span.setAttributes({
            'cache.hit': false,
            'cache.name': this.name,
            'cache.category': categoryLabel,
            'embedding_latency_ms': embedDuration * 1000,
            'search_latency_ms': searchDurationNearMiss * 1000,
            ...(isNaN(score) ? {} : { 'cache.similarity': score, 'cache.threshold': threshold }),
          });
          span.setStatus({ code: SpanStatusCode.OK });

          const result: CacheCheckResult = { hit: false, confidence: 'miss' as const };
          if (!isNaN(score)) {
            result.similarity = score;
            result.nearestMiss = {
              similarity: score,
              deltaToThreshold: score - threshold,
            };
          }
          return result;
        }

        // Hit path
        const confidence: CacheConfidence =
          score >= threshold - this.uncertaintyBand ? 'uncertain' : 'high';

        const pipeline = this.client.pipeline();
        pipeline.hincrby(this.statsKey, 'total', 1);
        pipeline.hincrby(this.statsKey, 'hits', 1);
        await pipeline.exec();

        const metricResult = confidence === 'uncertain' ? 'uncertain_hit' : 'hit';
        this.telemetry.metrics.requestsTotal
          .labels({ cache_name: this.name, result: metricResult, category: categoryLabel })
          .inc();

        // Sliding TTL refresh
        const matchedKey = firstResult.key;
        if (this.defaultTtl !== undefined && matchedKey) {
          await this.client.expire(matchedKey, this.defaultTtl);
        }

        const searchDuration = (performance.now() - searchStart) / 1000;
        span.setAttributes({
          'cache.hit': true,
          'cache.similarity': score,
          'cache.threshold': threshold,
          'cache.confidence': confidence,
          'cache.matched_key': matchedKey,
          'cache.category': categoryLabel,
          'embedding_latency_ms': embedDuration * 1000,
          'search_latency_ms': searchDuration * 1000,
        });
        span.setStatus({ code: SpanStatusCode.OK });

        return {
          hit: true,
          response: firstResult.fields['response'],
          similarity: score,
          confidence,
          matchedKey,
        };
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
        throw err;
      } finally {
        span.end();
        const duration = (performance.now() - startTime) / 1000;
        this.telemetry.metrics.operationDuration
          .labels({ cache_name: this.name, operation: 'check' })
          .observe(duration);
      }
    });
  }

  async store(
    prompt: string,
    response: string,
    options?: CacheStoreOptions,
  ): Promise<string> {
    if (!this._initialized) {
      throw new SemanticCacheUsageError(
        'SemanticCache.initialize() must be called before check() or store().',
      );
    }

    const startTime = performance.now();
    return this.telemetry.tracer.startActiveSpan('semantic_cache.store', async (span) => {
      try {
        // Embed the prompt
        const embedStart = performance.now();
        let embedding: number[];
        try {
          embedding = await this.embedFn(prompt);
        } catch (err) {
          throw new EmbeddingError(
            `embedFn failed: ${err instanceof Error ? err.message : String(err)}`,
            err,
          );
        }
        const embedDuration = (performance.now() - embedStart) / 1000;
        this.telemetry.metrics.embeddingDuration
          .labels({ cache_name: this.name })
          .observe(embedDuration);

        if (embedding.length !== this._dimension) {
          throw new SemanticCacheUsageError(
            `Embedding dimension mismatch: index expects ${this._dimension}, embedFn returned ${embedding.length}. Call flush() then initialize() to rebuild.`,
          );
        }

        const entryKey = `${this.entryPrefix}${randomUUID()}`;
        const category = options?.category ?? '';
        const model = options?.model ?? '';

        const fieldMap: Record<string, string | Buffer> = {
          prompt,
          response,
          model,
          category,
          inserted_at: Date.now().toString(),
          metadata: JSON.stringify(options?.metadata ?? {}),
          embedding: encodeFloat32(embedding),
        };

        try {
          await this.client.hset(entryKey, fieldMap);
        } catch (err) {
          throw new ValkeyCommandError('HSET', err);
        }

        const ttl = options?.ttl ?? this.defaultTtl;
        if (ttl !== undefined) {
          await this.client.expire(entryKey, ttl);
        }

        span.setAttributes({
          'cache.name': this.name,
          'cache.key': entryKey,
          'cache.ttl': ttl ?? -1,
          'cache.category': category || 'none',
          'cache.model': model || 'none',
          'embedding_latency_ms': embedDuration * 1000,
        });
        span.setStatus({ code: SpanStatusCode.OK });

        return entryKey;
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
        throw err;
      } finally {
        span.end();
        const duration = (performance.now() - startTime) / 1000;
        this.telemetry.metrics.operationDuration
          .labels({ cache_name: this.name, operation: 'store' })
          .observe(duration);
      }
    });
  }

  /**
   * Deletes all entries matching a valkey-search filter expression.
   *
   * **Security note:** `filter` is passed directly to FT.SEARCH. Only pass
   * trusted, programmatically-constructed expressions — never unsanitised
   * user input.
   */
  async invalidate(filter: string): Promise<InvalidateResult> {
    if (!this._initialized) {
      throw new SemanticCacheUsageError(
        'SemanticCache.initialize() must be called before invalidate().',
      );
    }

    const startTime = performance.now();
    return this.telemetry.tracer.startActiveSpan('semantic_cache.invalidate', async (span) => {
      try {
        let rawResult: unknown;
        try {
          rawResult = await this.client.call(
            'FT.SEARCH',
            this.indexName,
            filter,
            'RETURN',
            '0',
            'LIMIT',
            '0',
            '1000',
            'DIALECT',
            '2',
          );
        } catch (err) {
          throw new ValkeyCommandError('FT.SEARCH', err);
        }

        const parsed = parseFtSearchResponse(rawResult);
        if (parsed.length === 0) {
          span.setAttributes({
            'cache.name': this.name,
            'cache.filter': filter,
            'cache.deleted_count': 0,
            'cache.truncated': false,
          });
          span.setStatus({ code: SpanStatusCode.OK });
          return { deleted: 0, truncated: false };
        }

        const keys = parsed.map((r) => r.key);
        const truncated = keys.length === 1000;
        try {
          await this.client.del(keys);
        } catch (err) {
          throw new ValkeyCommandError('DEL', err);
        }

        span.setAttributes({
          'cache.name': this.name,
          'cache.filter': filter,
          'cache.deleted_count': keys.length,
          'cache.truncated': truncated,
        });
        span.setStatus({ code: SpanStatusCode.OK });

        return { deleted: keys.length, truncated };
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
        throw err;
      } finally {
        span.end();
        const duration = (performance.now() - startTime) / 1000;
        this.telemetry.metrics.operationDuration
          .labels({ cache_name: this.name, operation: 'invalidate' })
          .observe(duration);
      }
    });
  }

  async stats(): Promise<CacheStats> {
    if (!this._initialized) {
      throw new SemanticCacheUsageError(
        'SemanticCache.initialize() must be called before stats().',
      );
    }

    const raw = await this.client.hgetall(this.statsKey);
    const hits = parseInt(raw?.hits ?? '0', 10);
    const misses = parseInt(raw?.misses ?? '0', 10);
    const total = parseInt(raw?.total ?? '0', 10);
    return {
      hits,
      misses,
      total,
      hitRate: total === 0 ? 0 : hits / total,
    };
  }

  async indexInfo(): Promise<IndexInfo> {
    if (!this._initialized) {
      throw new SemanticCacheUsageError(
        'SemanticCache.initialize() must be called before indexInfo().',
      );
    }

    let raw: unknown;
    try {
      raw = await this.client.call('FT.INFO', this.indexName);
    } catch (err) {
      throw new ValkeyCommandError('FT.INFO', err);
    }

    const info = raw as unknown[];
    let numDocs = 0;
    let indexingState = 'unknown';

    for (let i = 0; i < info.length - 1; i += 2) {
      const key = String(info[i]);
      if (key === 'num_docs') {
        numDocs = parseInt(String(info[i + 1]), 10) || 0;
      } else if (key === 'indexing') {
        indexingState = String(info[i + 1]);
      }
    }

    return {
      name: this.indexName,
      numDocs,
      dimension: this._dimension,
      indexingState,
    };
  }

  async flush(): Promise<void> {
    // Valkey Search 1.2 does not support the DD (Delete Documents) flag on
    // FT.DROPINDEX — it fails with "wrong number of arguments". We drop the
    // index first, then clean up entry keys and the stats hash separately
    // via SCAN + DEL. The error-ignore check also matches Valkey's "not found"
    // message format (see initialize() comment).
    try {
      await this.client.call('FT.DROPINDEX', this.indexName);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message.toLowerCase() : '';
      const notFound =
        msg.includes('unknown index name') ||
        msg.includes('no such index') ||
        msg.includes('not found');
      if (!notFound) {
        throw new ValkeyCommandError('FT.DROPINDEX', err);
      }
    }

    // Step 2: delete all entry keys (SCAN for the entry prefix)
    const entryPattern = `${this.name}:entry:*`;
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.client.scan(
        cursor,
        'MATCH',
        entryPattern,
        'COUNT',
        '100',
      );
      cursor = nextCursor;
      if (keys.length > 0) {
        await this.client.del(keys);
      }
    } while (cursor !== '0');

    // Step 3: delete the stats hash
    await this.client.del([`${this.name}:__stats`]);

    this._initialized = false;
    this._initPromise = null;
  }

  private parseDimensionFromInfo(info: unknown[]): number {
    // FT.INFO returns a flat array: [key, value, key, value, ...]
    // We need to find the 'attributes' section which contains field definitions.
    for (let i = 0; i < info.length - 1; i += 2) {
      const key = String(info[i]);
      if (key === 'attributes' || key === 'fields') {
        const attributes = info[i + 1];
        if (!Array.isArray(attributes)) continue;

        // Each attribute is an array of key-value pairs describing a field
        for (const attr of attributes) {
          if (!Array.isArray(attr)) continue;

          // Check if this is the vector field
          let isVector = false;
          let dim = 0;

          for (let j = 0; j < attr.length - 1; j++) {
            const attrKey = String(attr[j]);
            if (attrKey === 'type' && String(attr[j + 1]) === 'VECTOR') {
              isVector = true;
            }
            // Redis/RediSearch uses 'DIM' at the top level of the attribute.
            if (attrKey.toLowerCase() === 'dim') {
              dim = parseInt(String(attr[j + 1]), 10) || 0;
            }
            // Valkey Search 1.2 nests dimension inside an 'index' sub-array:
            //   [..., "type", "VECTOR", "index", ["capacity", N, "dimensions", D, ...]]
            if (attrKey === 'index' && Array.isArray(attr[j + 1])) {
              const indexArr = attr[j + 1] as unknown[];
              for (let k = 0; k < indexArr.length - 1; k++) {
                if (String(indexArr[k]) === 'dimensions') {
                  const d = parseInt(String(indexArr[k + 1]), 10) || 0;
                  if (d > 0) dim = d;
                }
              }
            }
          }

          if (isVector && dim > 0) {
            return dim;
          }
        }
      }
    }

    // Could not parse dimension — caller (initialize) falls back to embedFn probe.
    return 0;
  }
}
