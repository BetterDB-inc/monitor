import { randomUUID } from 'node:crypto';
import { SpanStatusCode, type Span } from '@opentelemetry/api';
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

const INVALIDATE_BATCH_SIZE = 1000;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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
  private _initGeneration = 0;

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

  // ── Lifecycle ──────────────────────────────────────────────

  async initialize(): Promise<void> {
    if (!this._initPromise) {
      this._initPromise = this._doInitialize().catch((err) => {
        this._initPromise = null;
        throw err;
      });
    }
    return this._initPromise;
  }

  async flush(): Promise<void> {
    // Mark uninitialized immediately so concurrent check()/store() calls get
    // a clear SemanticCacheUsageError instead of cryptic Valkey errors.
    // Bump generation so any in-flight _doInitialize() won't overwrite this state.
    this._initialized = false;
    this._initPromise = null;
    this._initGeneration++;

    // Valkey Search 1.2 does not support the DD (Delete Documents) flag on
    // FT.DROPINDEX. Drop the index first, then clean up keys separately.
    try {
      await this.client.call('FT.DROPINDEX', this.indexName);
    } catch (err: unknown) {
      if (!this.isIndexNotFoundError(err)) {
        throw new ValkeyCommandError('FT.DROPINDEX', err);
      }
    }

    const entryPattern = `${this.name}:entry:*`;
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.client.scan(
        cursor, 'MATCH', entryPattern, 'COUNT', '100',
      );
      cursor = nextCursor;
      if (keys.length > 0) await this.client.del(keys);
    } while (cursor !== '0');

    await this.client.del(this.statsKey);
  }

  // ── Public operations ──────────────────────────────────────

  async check(prompt: string, options?: CacheCheckOptions): Promise<CacheCheckResult> {
    this.assertInitialized('check');

    return this.traced('check', async (span) => {
      const category = options?.category ?? '';
      const k = options?.k ?? 1;
      const threshold =
        options?.threshold ??
        (category && this.categoryThresholds[category] !== undefined
          ? this.categoryThresholds[category]
          : this.defaultThreshold);

      const { vector: embedding, durationSec: embedSec } = await this.embed(prompt);
      this.assertDimension(embedding);

      // FT.SEARCH — Valkey Search 1.2 rejects KNN aliases in RETURN/SORTBY,
      // so we omit both. Results include all fields and are pre-sorted by distance.
      const searchStart = performance.now();
      const filter = options?.filter;
      const query = `${filter ? `(${filter})` : '*'}=>[KNN ${k} @embedding $vec AS __score]`;
      let rawResult: unknown;
      try {
        rawResult = await this.client.call(
          'FT.SEARCH', this.indexName, query,
          'PARAMS', '2', 'vec', encodeFloat32(embedding),
          'LIMIT', '0', String(k),
          'DIALECT', '2',
        );
      } catch (err) {
        throw new ValkeyCommandError('FT.SEARCH', err);
      }
      const searchMs = performance.now() - searchStart;

      const parsed = parseFtSearchResponse(rawResult);
      const categoryLabel = category || 'none';
      const timingAttrs = { 'embedding_latency_ms': embedSec * 1000, 'search_latency_ms': searchMs };

      // No candidates at all
      if (parsed.length === 0) {
        await this.recordStat('misses');
        this.telemetry.metrics.requestsTotal
          .labels({ cache_name: this.name, result: 'miss', category: categoryLabel }).inc();
        span.setAttributes({
          'cache.hit': false, 'cache.name': this.name,
          'cache.category': categoryLabel, ...timingAttrs,
        });
        return { hit: false, confidence: 'miss' as const };
      }

      const scoreStr = parsed[0].fields['__score'];
      const score = scoreStr !== undefined ? parseFloat(scoreStr) : NaN;

      if (!isNaN(score)) {
        this.telemetry.metrics.similarityScore
          .labels({ cache_name: this.name, category: categoryLabel }).observe(score);
      }

      // Miss (no usable score, or score exceeds threshold)
      if (isNaN(score) || score > threshold) {
        await this.recordStat('misses');
        this.telemetry.metrics.requestsTotal
          .labels({ cache_name: this.name, result: 'miss', category: categoryLabel }).inc();
        span.setAttributes({
          'cache.hit': false, 'cache.name': this.name,
          'cache.category': categoryLabel, ...timingAttrs,
          ...(isNaN(score) ? {} : { 'cache.similarity': score, 'cache.threshold': threshold }),
        });

        const result: CacheCheckResult = { hit: false, confidence: 'miss' as const };
        if (!isNaN(score)) {
          result.similarity = score;
          result.nearestMiss = { similarity: score, deltaToThreshold: score - threshold };
        }
        return result;
      }

      // Hit
      const confidence: CacheConfidence =
        score >= threshold - this.uncertaintyBand ? 'uncertain' : 'high';

      await this.recordStat('hits');
      const metricResult = confidence === 'uncertain' ? 'uncertain_hit' : 'hit';
      this.telemetry.metrics.requestsTotal
        .labels({ cache_name: this.name, result: metricResult, category: categoryLabel }).inc();

      const matchedKey = parsed[0].key;
      if (this.defaultTtl !== undefined && matchedKey) {
        await this.client.expire(matchedKey, this.defaultTtl);
      }

      span.setAttributes({
        'cache.hit': true, 'cache.similarity': score, 'cache.threshold': threshold,
        'cache.confidence': confidence, 'cache.matched_key': matchedKey,
        'cache.category': categoryLabel, ...timingAttrs,
      });

      return {
        hit: true, response: parsed[0].fields['response'],
        similarity: score, confidence, matchedKey,
      };
    });
  }

  async store(prompt: string, response: string, options?: CacheStoreOptions): Promise<string> {
    this.assertInitialized('store');

    return this.traced('store', async (span) => {
      const { vector: embedding, durationSec: embedSec } = await this.embed(prompt);
      this.assertDimension(embedding);

      const entryKey = `${this.entryPrefix}${randomUUID()}`;
      const category = options?.category ?? '';
      const model = options?.model ?? '';

      try {
        await this.client.hset(entryKey, {
          prompt, response, model, category,
          inserted_at: Date.now().toString(),
          metadata: JSON.stringify(options?.metadata ?? {}),
          embedding: encodeFloat32(embedding),
        } as Record<string, string | Buffer>);
      } catch (err) {
        throw new ValkeyCommandError('HSET', err);
      }

      const ttl = options?.ttl ?? this.defaultTtl;
      if (ttl !== undefined) await this.client.expire(entryKey, ttl);

      span.setAttributes({
        'cache.name': this.name, 'cache.key': entryKey, 'cache.ttl': ttl ?? -1,
        'cache.category': category || 'none', 'cache.model': model || 'none',
        'embedding_latency_ms': embedSec * 1000,
      });

      return entryKey;
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
    this.assertInitialized('invalidate');

    return this.traced('invalidate', async (span) => {
      let rawResult: unknown;
      try {
        rawResult = await this.client.call(
          'FT.SEARCH', this.indexName, filter,
          'RETURN', '0',
          'LIMIT', '0', String(INVALIDATE_BATCH_SIZE),
          'DIALECT', '2',
        );
      } catch (err) {
        throw new ValkeyCommandError('FT.SEARCH', err);
      }

      const parsed = parseFtSearchResponse(rawResult);
      if (parsed.length === 0) {
        span.setAttributes({
          'cache.name': this.name, 'cache.filter': filter,
          'cache.deleted_count': 0, 'cache.truncated': false,
        });
        return { deleted: 0, truncated: false };
      }

      const keys = parsed.map((r) => r.key);
      const truncated = keys.length === INVALIDATE_BATCH_SIZE;
      try {
        await this.client.del(keys);
      } catch (err) {
        throw new ValkeyCommandError('DEL', err);
      }

      span.setAttributes({
        'cache.name': this.name, 'cache.filter': filter,
        'cache.deleted_count': keys.length, 'cache.truncated': truncated,
      });
      return { deleted: keys.length, truncated };
    });
  }

  async stats(): Promise<CacheStats> {
    this.assertInitialized('stats');
    const raw = await this.client.hgetall(this.statsKey);
    const hits = parseInt(raw.hits ?? '0', 10);
    const misses = parseInt(raw.misses ?? '0', 10);
    const total = parseInt(raw.total ?? '0', 10);
    return { hits, misses, total, hitRate: total === 0 ? 0 : hits / total };
  }

  async indexInfo(): Promise<IndexInfo> {
    this.assertInitialized('indexInfo');
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
      if (key === 'num_docs') numDocs = parseInt(String(info[i + 1]), 10) || 0;
      else if (key === 'indexing') indexingState = String(info[i + 1]);
    }

    return { name: this.indexName, numDocs, dimension: this._dimension, indexingState };
  }

  // ── Private helpers ────────────────────────────────────────

  private async _doInitialize(): Promise<void> {
    const gen = this._initGeneration;
    return this.traced('initialize', async () => {
      const dim = await this.ensureIndexAndGetDimension();
      // If flush() ran while we were initializing, don't overwrite its state.
      if (this._initGeneration !== gen) return;
      this._dimension = dim;
      this._initialized = true;
    });
  }

  private async ensureIndexAndGetDimension(): Promise<number> {
    // Try reading an existing index
    try {
      const info = (await this.client.call('FT.INFO', this.indexName)) as unknown[];
      const dim = this.parseDimensionFromInfo(info);
      if (dim > 0) return dim;
      // Couldn't parse dimension from FT.INFO — fall back to probe
      return (await this.embed('probe')).vector.length;
    } catch (err) {
      if (err instanceof EmbeddingError) throw err;
      if (!this.isIndexNotFoundError(err)) {
        throw new ValkeyCommandError('FT.INFO', err);
      }
    }

    // Index doesn't exist — probe dimension and create it
    const dim = (await this.embed('probe')).vector.length;
    try {
      await this.client.call(
        'FT.CREATE', this.indexName, 'ON', 'HASH',
        'PREFIX', '1', this.entryPrefix,
        'SCHEMA',
        'prompt', 'TEXT', 'NOSTEM',
        'response', 'TEXT', 'NOSTEM',
        'model', 'TAG',
        'category', 'TAG',
        'inserted_at', 'NUMERIC', 'SORTABLE',
        'embedding', 'VECTOR', 'HNSW', '6',
        'TYPE', 'FLOAT32', 'DIM', String(dim), 'DISTANCE_METRIC', 'COSINE',
      );
    } catch (err) {
      throw new ValkeyCommandError('FT.CREATE', err);
    }
    return dim;
  }

  /** Wraps embedFn with error handling and duration tracking. */
  private async embed(text: string): Promise<{ vector: number[]; durationSec: number }> {
    const start = performance.now();
    let vector: number[];
    try {
      vector = await this.embedFn(text);
    } catch (err) {
      throw new EmbeddingError(`embedFn failed: ${errMsg(err)}`, err);
    }
    const durationSec = (performance.now() - start) / 1000;
    this.telemetry.metrics.embeddingDuration
      .labels({ cache_name: this.name })
      .observe(durationSec);
    return { vector, durationSec };
  }

  /**
   * Wraps a method body in an OTel span with automatic status, end, and
   * operation duration metric. The span is passed to fn so callers can
   * set attributes — but callers must NOT call span.end() or span.setStatus(),
   * as traced() handles both.
   */
  private async traced<T>(operation: string, fn: (span: Span) => Promise<T>): Promise<T> {
    const start = performance.now();
    return this.telemetry.tracer.startActiveSpan(`semantic_cache.${operation}`, async (span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
        throw err;
      } finally {
        span.end();
        this.telemetry.metrics.operationDuration
          .labels({ cache_name: this.name, operation })
          .observe((performance.now() - start) / 1000);
      }
    });
  }

  /** Increment stats counters via pipeline. */
  private async recordStat(field: 'hits' | 'misses'): Promise<void> {
    const pipeline = this.client.pipeline();
    pipeline.hincrby(this.statsKey, 'total', 1);
    pipeline.hincrby(this.statsKey, field, 1);
    await pipeline.exec();
  }

  private assertInitialized(method: string): void {
    if (!this._initialized) {
      throw new SemanticCacheUsageError(
        `SemanticCache.initialize() must be called before ${method}().`,
      );
    }
  }

  private assertDimension(embedding: number[]): void {
    if (embedding.length !== this._dimension) {
      throw new SemanticCacheUsageError(
        `Embedding dimension mismatch: index expects ${this._dimension}, embedFn returned ${embedding.length}. Call flush() then initialize() to rebuild.`,
      );
    }
  }

  private isIndexNotFoundError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message.toLowerCase() : '';
    return (
      msg.includes('unknown index name') ||
      msg.includes('no such index') ||
      msg.includes('not found')
    );
  }

  private parseDimensionFromInfo(info: unknown[]): number {
    for (let i = 0; i < info.length - 1; i += 2) {
      const key = String(info[i]);
      if (key !== 'attributes' && key !== 'fields') continue;

      const attributes = info[i + 1];
      if (!Array.isArray(attributes)) continue;

      for (const attr of attributes) {
        if (!Array.isArray(attr)) continue;

        let isVector = false;
        let dim = 0;

        for (let j = 0; j < attr.length - 1; j++) {
          const attrKey = String(attr[j]);
          if (attrKey === 'type' && String(attr[j + 1]) === 'VECTOR') isVector = true;
          if (attrKey.toLowerCase() === 'dim') dim = parseInt(String(attr[j + 1]), 10) || 0;
          // Valkey Search 1.2 nests dimension inside an 'index' sub-array
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

        if (isVector && dim > 0) return dim;
      }
    }

    return 0;
  }
}
