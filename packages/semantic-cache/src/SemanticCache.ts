import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
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
  ModelCost,
} from './types';
import {
  SemanticCacheUsageError,
  EmbeddingError,
  ValkeyCommandError,
} from './errors';
import { createTelemetry, type Telemetry } from './telemetry';
import {
  encodeFloat32,
  escapeTag,
  parseFtSearchResponse,
  extractText,
  extractBinaryRefs,
  type ContentBlock,
  type TextBlock,
} from './utils';
import { DEFAULT_COST_TABLE } from './defaultCostTable';
import { clusterScan } from './cluster';

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
  private readonly similarityWindowKey: string;
  private readonly defaultThreshold: number;
  private readonly defaultTtl: number | undefined;
  private readonly categoryThresholds: Record<string, number>;
  private readonly uncertaintyBand: number;
  private readonly telemetry: Telemetry;
  private readonly costTable: Record<string, ModelCost> | undefined;
  private readonly embeddingCacheEnabled: boolean;
  private readonly embeddingCacheTtl: number;
  private readonly embedKeyPrefix: string;

  private _initialized = false;
  private _dimension = 0;
  private _hasBinaryRefs = false;
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
    this.similarityWindowKey = `${this.name}:__similarity_window`;
    this.embedKeyPrefix = `${this.name}:embed:`;
    this.defaultThreshold = options.defaultThreshold ?? 0.1;
    this.defaultTtl = options.defaultTtl;
    this.categoryThresholds = options.categoryThresholds ?? {};
    this.uncertaintyBand = options.uncertaintyBand ?? 0.05;

    // Build effective cost table
    const useDefault = options.useDefaultCostTable ?? true;
    if (!useDefault && !options.costTable) {
      this.costTable = undefined;
    } else if (!useDefault) {
      this.costTable = options.costTable;
    } else {
      this.costTable = { ...DEFAULT_COST_TABLE, ...(options.costTable ?? {}) };
    }

    // Embedding cache config
    this.embeddingCacheEnabled = options.embeddingCache?.enabled ?? true;
    this.embeddingCacheTtl = options.embeddingCache?.ttl ?? 86400;

    this.telemetry = createTelemetry({
      prefix: options.telemetry?.metricsPrefix ?? 'semantic_cache',
      tracerName: options.telemetry?.tracerName ?? '@betterdb/semantic-cache',
      registry: options.telemetry?.registry,
    });
  }

  // -- Lifecycle --

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

    // Cluster-aware SCAN for entry keys and embed cache keys
    const patterns = [
      `${this.name}:entry:*`,
      `${this.name}:embed:*`,
    ];

    for (const pattern of patterns) {
      await clusterScan(this.client, pattern, async (keys, nodeClient) => {
        await nodeClient.del(keys);
      });
    }

    await this.client.del(this.statsKey);
    await this.client.del(this.similarityWindowKey);
  }

  // -- Public operations --

  async check(prompt: string | ContentBlock[], options?: CacheCheckOptions): Promise<CacheCheckResult> {
    this.assertInitialized('check');

    return this.traced('check', async (span) => {
      const category = options?.category ?? '';
      const threshold =
        options?.threshold ??
        (category && this.categoryThresholds[category] !== undefined
          ? this.categoryThresholds[category]
          : this.defaultThreshold);

      // Resolve text and binary refs from prompt
      const { text: promptText, binaryRefs } = await this.resolvePrompt(prompt);

      // Stale model detection
      const checkStale = (options?.staleAfterModelChange ?? false) && !!options?.currentModel;

      // Rerank option
      const rerankOpts = options?.rerank;
      const k = rerankOpts ? rerankOpts.k : (options?.k ?? 1);

      const { vector: embedding, durationSec: embedSec } = await this.embed(promptText);
      this.assertDimension(embedding);

      // Build filter
      const userFilter = options?.filter;
      // AND semantics: each ref must be present — chain separate TAG clauses.
      const binaryFilter =
        binaryRefs.length > 0 && this._hasBinaryRefs
          ? (binaryRefs.length === 1
              ? `@binary_refs:{${escapeTag(binaryRefs[0])}}`
              : binaryRefs.map((r) => `@binary_refs:{${escapeTag(r)}}`).join(' '))
          : null;
      const combinedFilter = [userFilter, binaryFilter].filter(Boolean).join(' ');
      const filterExpr = combinedFilter ? `(${combinedFilter})` : '*';

      const query = `${filterExpr}=>[KNN ${k} @embedding $vec AS __score]`;
      const searchStart = performance.now();
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
        if (!isNaN(score)) {
          await this.recordSimilarityWindow(score, 'miss', category);
        }
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

      // Rerank: apply rerankFn to all candidates above threshold
      let winnerIndex = 0;
      if (rerankOpts && parsed.length > 0) {
        const candidates = parsed
          .filter((r) => {
            const s = parseFloat(r.fields['__score'] ?? 'NaN');
            return !isNaN(s);
          })
          .map((r) => ({
            response: r.fields['response'] ?? '',
            similarity: parseFloat(r.fields['__score'] ?? 'NaN'),
          }));
        const picked = await rerankOpts.rerankFn(promptText, candidates);
        if (picked === -1) {
          // Record the actual outcome — rerank rejected, so it's a miss
          await this.recordSimilarityWindow(score, 'miss', category);
          await this.recordStat('misses');
          this.telemetry.metrics.requestsTotal
            .labels({ cache_name: this.name, result: 'miss', category: categoryLabel }).inc();
          span.setAttributes({ 'cache.hit': false, 'cache.name': this.name, 'cache.reranked': true });
          return { hit: false, confidence: 'miss' as const };
        }
        winnerIndex = picked;
      }

      const winner = parsed[winnerIndex] ?? parsed[0];
      const winnerScore = parseFloat(winner.fields['__score'] ?? String(score));

      // Stale model check: if winner's model differs from currentModel, evict and treat as miss
      if (checkStale) {
        const storedModel = winner.fields['model'] ?? '';
        if (storedModel && storedModel !== options!.currentModel) {
          // Evict stale entry
          try {
            await this.client.del(winner.key);
          } catch { /* best effort */ }
          await this.recordSimilarityWindow(winnerScore, 'miss', category);
          this.telemetry.metrics.staleModelEvictions.labels({ cache_name: this.name }).inc();
          await this.recordStat('misses');
          this.telemetry.metrics.requestsTotal
            .labels({ cache_name: this.name, result: 'miss', category: categoryLabel }).inc();
          span.setAttributes({ 'cache.hit': false, 'cache.stale_evicted': true });
          return { hit: false, confidence: 'miss' as const };
        }
      }

      // All checks passed — record as a genuine hit
      await this.recordSimilarityWindow(winnerScore, 'hit', category);
      const confidence: CacheConfidence =
        winnerScore >= threshold - this.uncertaintyBand ? 'uncertain' : 'high';

      await this.recordStat('hits');
      const metricResult = confidence === 'uncertain' ? 'uncertain_hit' : 'hit';
      this.telemetry.metrics.requestsTotal
        .labels({ cache_name: this.name, result: metricResult, category: categoryLabel }).inc();

      const matchedKey = winner.key;
      if (this.defaultTtl !== undefined && matchedKey) {
        await this.client.expire(matchedKey, this.defaultTtl);
      }

      // Cost saved
      let costSaved: number | undefined;
      const costMicrosStr = winner.fields['cost_micros'];
      if (costMicrosStr) {
        const costMicros = parseInt(costMicrosStr, 10);
        if (!isNaN(costMicros) && costMicros > 0) {
          costSaved = costMicros / 1_000_000;
          // Atomically increment cost_saved_micros in stats
          await this.client.hincrby(this.statsKey, 'cost_saved_micros', costMicros);
          this.telemetry.metrics.costSavedTotal
            .labels({ cache_name: this.name, category: categoryLabel }).inc(costSaved);
        }
      }

      // Content blocks
      let contentBlocks: import('./utils').ContentBlock[] | undefined;
      const contentBlocksStr = winner.fields['content_blocks'];
      if (contentBlocksStr) {
        try {
          contentBlocks = JSON.parse(contentBlocksStr);
        } catch { /* ignore parse errors */ }
      }

      span.setAttributes({
        'cache.hit': true, 'cache.similarity': winnerScore, 'cache.threshold': threshold,
        'cache.confidence': confidence, 'cache.matched_key': matchedKey,
        'cache.category': categoryLabel, ...timingAttrs,
      });

      const result: CacheCheckResult = {
        hit: true, response: winner.fields['response'],
        similarity: winnerScore, confidence, matchedKey,
      };
      if (costSaved !== undefined) result.costSaved = costSaved;
      if (contentBlocks) result.contentBlocks = contentBlocks;
      return result;
    });
  }

  async store(prompt: string | ContentBlock[], response: string, options?: CacheStoreOptions): Promise<string> {
    this.assertInitialized('store');

    return this.traced('store', async (span) => {
      const { text: promptText, binaryRefs } = await this.resolvePrompt(prompt);
      const { vector: embedding, durationSec: embedSec } = await this.embed(promptText);
      this.assertDimension(embedding);

      const entryKey = `${this.entryPrefix}${randomUUID()}`;
      const category = options?.category ?? '';
      const model = options?.model ?? '';

      // Compute cost if tokens and model provided
      let costMicros: number | undefined;
      if (
        options?.model &&
        options?.inputTokens !== undefined &&
        options?.outputTokens !== undefined &&
        this.costTable
      ) {
        const pricing = this.costTable[options.model];
        if (pricing) {
          costMicros = Math.round(
            (options.inputTokens * pricing.inputPer1k / 1000 +
              options.outputTokens * pricing.outputPer1k / 1000) * 1_000_000
          );
        }
      }

      const hashFields: Record<string, string | Buffer> = {
        prompt: promptText,
        response,
        model,
        category,
        inserted_at: Date.now().toString(),
        metadata: JSON.stringify(options?.metadata ?? {}),
        embedding: encodeFloat32(embedding),
      };

      if (binaryRefs.length > 0) {
        hashFields['binary_refs'] = binaryRefs.join(',');
      }

      if (costMicros !== undefined && costMicros > 0) {
        hashFields['cost_micros'] = String(costMicros);
      }

      if (options?.temperature !== undefined) {
        hashFields['temperature'] = String(options.temperature);
      }
      if (options?.topP !== undefined) {
        hashFields['top_p'] = String(options.topP);
      }
      if (options?.seed !== undefined) {
        hashFields['seed'] = String(options.seed);
      }

      try {
        await this.client.hset(entryKey, hashFields);
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
   * Store structured content blocks as the cached response.
   * Populates both the response field (from TextBlock text) and content_blocks (full JSON).
   */
  async storeMultipart(
    prompt: string | ContentBlock[],
    blocks: ContentBlock[],
    options?: CacheStoreOptions,
  ): Promise<string> {
    this.assertInitialized('storeMultipart');

    return this.traced('storeMultipart', async (span) => {
      const { text: promptText, binaryRefs } = await this.resolvePrompt(prompt);
      const { vector: embedding, durationSec: embedSec } = await this.embed(promptText);
      this.assertDimension(embedding);

      // Derive text response from blocks for backward compat
      const textResponse = extractText(blocks);

      const entryKey = `${this.entryPrefix}${randomUUID()}`;
      const category = options?.category ?? '';
      const model = options?.model ?? '';

      let costMicros: number | undefined;
      if (options?.model && options?.inputTokens !== undefined && options?.outputTokens !== undefined && this.costTable) {
        const pricing = this.costTable[options.model];
        if (pricing) {
          costMicros = Math.round(
            (options.inputTokens * pricing.inputPer1k / 1000 +
              options.outputTokens * pricing.outputPer1k / 1000) * 1_000_000
          );
        }
      }

      const hashFields: Record<string, string | Buffer> = {
        prompt: promptText,
        response: textResponse,
        model,
        category,
        inserted_at: Date.now().toString(),
        metadata: JSON.stringify(options?.metadata ?? {}),
        embedding: encodeFloat32(embedding),
        content_blocks: JSON.stringify(blocks),
      };

      if (binaryRefs.length > 0) {
        hashFields['binary_refs'] = binaryRefs.join(',');
      }
      if (costMicros !== undefined && costMicros > 0) {
        hashFields['cost_micros'] = String(costMicros);
      }
      if (options?.temperature !== undefined) hashFields['temperature'] = String(options.temperature);
      if (options?.topP !== undefined) hashFields['top_p'] = String(options.topP);
      if (options?.seed !== undefined) hashFields['seed'] = String(options.seed);

      try {
        await this.client.hset(entryKey, hashFields);
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
   * Check multiple prompts in parallel, using pipelined FT.SEARCH calls.
   * Returns results in input order.
   */
  async checkBatch(
    prompts: (string | ContentBlock[])[],
    options?: CacheCheckOptions,
  ): Promise<CacheCheckResult[]> {
    this.assertInitialized('checkBatch');

    if (prompts.length === 0) return [];

    return this.traced('checkBatch', async (span) => {
      // Resolve all prompts and embed in parallel
      const resolved = await Promise.all(prompts.map((p) => this.resolvePrompt(p)));
      const embeddings = await Promise.all(resolved.map(({ text }) => this.embed(text)));

      const category = options?.category ?? '';
      const threshold =
        options?.threshold ??
        (category && this.categoryThresholds[category] !== undefined
          ? this.categoryThresholds[category]
          : this.defaultThreshold);
      const k = options?.k ?? 1;
      const userFilter = options?.filter;

      // Pipeline all FT.SEARCH calls
      const pipeline = this.client.pipeline();
      for (let i = 0; i < prompts.length; i++) {
        const { binaryRefs } = resolved[i];
        const { vector: embedding } = embeddings[i];

        const binaryFilter =
          binaryRefs.length > 0 && this._hasBinaryRefs
            ? (binaryRefs.length === 1
                ? `@binary_refs:{${escapeTag(binaryRefs[0])}}`
                : binaryRefs.map((r) => `@binary_refs:{${escapeTag(r)}}`).join(' '))
            : null;
        const combinedFilter = [userFilter, binaryFilter].filter(Boolean).join(' ');
        const filterExpr = combinedFilter ? `(${combinedFilter})` : '*';
        const query = `${filterExpr}=>[KNN ${k} @embedding $vec AS __score]`;

        pipeline.call(
          'FT.SEARCH', this.indexName, query,
          'PARAMS', '2', 'vec', encodeFloat32(embedding),
          'LIMIT', '0', String(k),
          'DIALECT', '2',
        );
      }

      const pipelineResults = await pipeline.exec();
      span.setAttributes({ 'cache.batch_size': prompts.length, 'cache.name': this.name });

      const results: CacheCheckResult[] = [];
      const categoryLabel = category || 'none';

      for (let i = 0; i < prompts.length; i++) {
        const pipelineEntry = pipelineResults?.[i];
        const err = pipelineEntry?.[0];
        const rawResult = pipelineEntry?.[1];

        if (err) {
          results.push({ hit: false, confidence: 'miss' as const });
          continue;
        }

        const parsed = parseFtSearchResponse(rawResult);

        if (parsed.length === 0) {
          await this.recordStat('misses');
          this.telemetry.metrics.requestsTotal
            .labels({ cache_name: this.name, result: 'miss', category: categoryLabel }).inc();
          results.push({ hit: false, confidence: 'miss' as const });
          continue;
        }

        const scoreStr = parsed[0].fields['__score'];
        const score = scoreStr !== undefined ? parseFloat(scoreStr) : NaN;

        if (isNaN(score) || score > threshold) {
          if (!isNaN(score)) {
            await this.recordSimilarityWindow(score, 'miss', category);
          }
          await this.recordStat('misses');
          this.telemetry.metrics.requestsTotal
            .labels({ cache_name: this.name, result: 'miss', category: categoryLabel }).inc();
          const result: CacheCheckResult = { hit: false, confidence: 'miss' as const };
          if (!isNaN(score)) {
            result.similarity = score;
            result.nearestMiss = { similarity: score, deltaToThreshold: score - threshold };
          }
          results.push(result);
          continue;
        }

        await this.recordSimilarityWindow(score, 'hit', category);
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

        let costSaved: number | undefined;
        const costMicrosStr = parsed[0].fields['cost_micros'];
        if (costMicrosStr) {
          const costMicros = parseInt(costMicrosStr, 10);
          if (!isNaN(costMicros) && costMicros > 0) {
            costSaved = costMicros / 1_000_000;
            await this.client.hincrby(this.statsKey, 'cost_saved_micros', costMicros);
          }
        }

        const result: CacheCheckResult = {
          hit: true, response: parsed[0].fields['response'],
          similarity: score, confidence, matchedKey,
        };
        if (costSaved !== undefined) result.costSaved = costSaved;
        results.push(result);
      }

      return results;
    });
  }

  /**
   * Deletes all entries matching a valkey-search filter expression.
   *
   * **Security note:** `filter` is passed directly to FT.SEARCH. Only pass
   * trusted, programmatically-constructed expressions - never unsanitised
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

  /** Delete all entries tagged with the given model name. */
  async invalidateByModel(model: string): Promise<number> {
    let total = 0;
    let result: InvalidateResult;
    do {
      result = await this.invalidate(`@model:{${escapeTag(model)}}`);
      total += result.deleted;
    } while (result.truncated);
    return total;
  }

  /** Delete all entries tagged with the given category. */
  async invalidateByCategory(category: string): Promise<number> {
    let total = 0;
    let result: InvalidateResult;
    do {
      result = await this.invalidate(`@category:{${escapeTag(category)}}`);
      total += result.deleted;
    } while (result.truncated);
    return total;
  }

  async stats(): Promise<CacheStats> {
    this.assertInitialized('stats');
    const raw = await this.client.hgetall(this.statsKey);
    const hits = parseInt(raw?.hits ?? '0', 10);
    const misses = parseInt(raw?.misses ?? '0', 10);
    const total = parseInt(raw?.total ?? '0', 10);
    const costSavedMicros = parseInt(raw?.cost_saved_micros ?? '0', 10);
    return { hits, misses, total, hitRate: total === 0 ? 0 : hits / total, costSavedMicros };
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

  /**
   * Analyze the rolling similarity score window and recommend threshold adjustments.
   */
  async thresholdEffectiveness(options?: {
    category?: string;
    minSamples?: number;
  }): Promise<ThresholdEffectivenessResult> {
    this.assertInitialized('thresholdEffectiveness');

    const minSamples = options?.minSamples ?? 100;
    const category = options?.category;
    const threshold = category && this.categoryThresholds[category] !== undefined
      ? this.categoryThresholds[category]
      : this.defaultThreshold;

    // Read all window entries
    let rawEntries: string[];
    try {
      rawEntries = (await this.client.zrange(this.similarityWindowKey, '0', '-1')) as string[];
    } catch {
      rawEntries = [];
    }

    // Parse and optionally filter by category
    const entries: Array<{ score: number; result: 'hit' | 'miss'; category: string }> = [];
    for (const raw of rawEntries) {
      try {
        const entry = JSON.parse(String(raw));
        if (
          typeof entry.score === 'number' &&
          (entry.result === 'hit' || entry.result === 'miss')
        ) {
          if (!category || entry.category === category) {
            entries.push(entry);
          }
        }
      } catch { /* skip corrupt entries */ }
    }

    const sampleCount = entries.length;
    const categoryLabel = category ?? 'all';

    if (sampleCount < minSamples) {
      return {
        category: categoryLabel,
        sampleCount,
        currentThreshold: threshold,
        hitRate: 0,
        uncertainHitRate: 0,
        nearMissRate: 0,
        avgHitSimilarity: 0,
        avgMissSimilarity: 0,
        recommendation: 'insufficient_data',
        reasoning: `Only ${sampleCount} samples collected; ${minSamples} required for a reliable recommendation.`,
      };
    }

    const hits = entries.filter((e) => e.result === 'hit');
    const misses = entries.filter((e) => e.result === 'miss');

    const hitRate = hits.length / sampleCount;
    const uncertainHits = hits.filter((e) => e.score >= threshold - this.uncertaintyBand);
    const uncertainHitRate = hits.length > 0 ? uncertainHits.length / hits.length : 0;

    const nearMisses = misses.filter((e) => e.score <= threshold + 0.03);
    const nearMissRate = misses.length > 0 ? nearMisses.length / misses.length : 0;

    const avgHitSimilarity =
      hits.length > 0 ? hits.reduce((s, e) => s + e.score, 0) / hits.length : 0;
    const avgMissSimilarity =
      misses.length > 0 ? misses.reduce((s, e) => s + e.score, 0) / misses.length : 0;

    // avgNearMissDelta: how far above the threshold near-misses are on average
    const avgNearMissDelta =
      nearMisses.length > 0
        ? nearMisses.reduce((s, e) => s + (e.score - threshold), 0) / nearMisses.length
        : 0;

    let recommendation: ThresholdEffectivenessResult['recommendation'];
    let recommendedThreshold: number | undefined;
    let reasoning: string;

    if (uncertainHitRate > 0.2) {
      recommendation = 'tighten_threshold';
      recommendedThreshold = Math.max(0, threshold - this.uncertaintyBand * 1.5);
      reasoning = `${(uncertainHitRate * 100).toFixed(1)}% of hits are in the uncertainty band - tighten the threshold to reduce false positives.`;
    } else if (nearMissRate > 0.3 && avgNearMissDelta < 0.03) {
      recommendation = 'loosen_threshold';
      recommendedThreshold = threshold + avgNearMissDelta;
      reasoning = `${(nearMissRate * 100).toFixed(1)}% of misses are very close to the threshold - consider loosening to capture more hits.`;
    } else {
      recommendation = 'optimal';
      reasoning = `Hit rate is ${(hitRate * 100).toFixed(1)}% with ${(uncertainHitRate * 100).toFixed(1)}% uncertain hits - threshold appears well-calibrated.`;
    }

    return {
      category: categoryLabel,
      sampleCount,
      currentThreshold: threshold,
      hitRate,
      uncertainHitRate,
      nearMissRate,
      avgHitSimilarity,
      avgMissSimilarity,
      recommendation,
      recommendedThreshold,
      reasoning,
    };
  }

  /**
   * Returns threshold effectiveness results for every category seen in the
   * rolling window, plus one aggregate result for all categories combined.
   */
  async thresholdEffectivenessAll(options?: {
    minSamples?: number;
  }): Promise<ThresholdEffectivenessResult[]> {
    this.assertInitialized('thresholdEffectivenessAll');

    let rawEntries: string[];
    try {
      rawEntries = (await this.client.zrange(this.similarityWindowKey, '0', '-1')) as string[];
    } catch {
      rawEntries = [];
    }

    // Collect unique categories
    const categories = new Set<string>();
    for (const raw of rawEntries) {
      try {
        const entry = JSON.parse(raw);
        if (entry.category) categories.add(entry.category);
      } catch { /* skip */ }
    }

    const results = await Promise.all([
      this.thresholdEffectiveness({ minSamples: options?.minSamples }),
      ...[...categories].filter(Boolean).map((cat) =>
        this.thresholdEffectiveness({ category: cat, minSamples: options?.minSamples })
      ),
    ]);

    return results;
  }

  // -- Internal helpers exposed to package adapters --

  /**
   * Execute a stable FT.SEARCH for use by adapters (e.g. LangGraph).
   * SORTBY inserted_at ASC gives stable ordering across paginated calls.
   * @internal
   */
  async _searchEntries(filterExpr: string, limit: number, offset: number): Promise<unknown> {
    return this.client.call(
      'FT.SEARCH', this.indexName, filterExpr,
      'SORTBY', 'inserted_at', 'ASC',
      'LIMIT', String(offset), String(limit),
      'DIALECT', '2',
    );
  }

  /**
   * Embed text for use by adapters (e.g. LangGraph semantic search).
   * @internal
   */
  async _embedText(text: string): Promise<{ vector: number[]; durationSec: number }> {
    return this.embed(text);
  }

  // -- Private helpers --

  private async _doInitialize(): Promise<void> {
    const gen = this._initGeneration;
    return this.traced('initialize', async () => {
      const { dim, hasBinaryRefs } = await this.ensureIndexAndGetDimension();
      if (this._initGeneration !== gen) return;
      this._dimension = dim;
      this._hasBinaryRefs = hasBinaryRefs;
      this._initialized = true;
    });
  }

  private async ensureIndexAndGetDimension(): Promise<{ dim: number; hasBinaryRefs: boolean }> {
    // Try reading an existing index
    try {
      const info = (await this.client.call('FT.INFO', this.indexName)) as unknown[];
      const dim = this.parseDimensionFromInfo(info);
      const hasBinaryRefs = this.parseHasBinaryRefsFromInfo(info);
      if (dim > 0) return { dim, hasBinaryRefs };
      // Couldn't parse dimension from FT.INFO - fall back to probe
      const probeDim = (await this.embed('probe')).vector.length;
      return { dim: probeDim, hasBinaryRefs };
    } catch (err) {
      if (err instanceof EmbeddingError) throw err;
      if (!this.isIndexNotFoundError(err)) {
        throw new ValkeyCommandError('FT.INFO', err);
      }
    }

    // Index doesn't exist - probe dimension and create it
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
        'binary_refs', 'TAG',
        'inserted_at', 'NUMERIC', 'SORTABLE',
        'temperature', 'NUMERIC',
        'top_p', 'NUMERIC',
        'seed', 'NUMERIC',
        'embedding', 'VECTOR', 'HNSW', '6',
        'TYPE', 'FLOAT32', 'DIM', String(dim), 'DISTANCE_METRIC', 'COSINE',
      );
    } catch (err) {
      throw new ValkeyCommandError('FT.CREATE', err);
    }
    return { dim, hasBinaryRefs: true };
  }

  /** Check if the index schema has a binary_refs field. */
  private parseHasBinaryRefsFromInfo(info: unknown[]): boolean {
    for (let i = 0; i < info.length - 1; i += 2) {
      const key = String(info[i]);
      if (key !== 'attributes' && key !== 'fields') continue;
      const attributes = info[i + 1];
      if (!Array.isArray(attributes)) continue;
      for (const attr of attributes) {
        if (!Array.isArray(attr)) continue;
        for (let j = 0; j < attr.length - 1; j++) {
          if (String(attr[j]) === 'identifier' && String(attr[j + 1]) === 'binary_refs') {
            return true;
          }
        }
      }
    }
    return false;
  }

  /** Resolve a prompt (string or ContentBlock[]) into text + binary refs. */
  private resolvePrompt(
    prompt: string | ContentBlock[],
  ): { text: string; binaryRefs: string[] } {
    if (typeof prompt === 'string') {
      return { text: prompt, binaryRefs: [] };
    }
    const text = extractText(prompt);
    const binaryRefs = extractBinaryRefs(prompt);
    return { text, binaryRefs };
  }

  /** Wraps embedFn with error handling, duration tracking, and optional embedding cache. */
  private async embed(text: string): Promise<{ vector: number[]; durationSec: number }> {
    // Check embedding cache
    if (this.embeddingCacheEnabled && text) {
      const hash = createHash('sha256').update(text).digest('hex');
      const embedKey = `${this.embedKeyPrefix}${hash}`;
      try {
        const cached = await this.client.getBuffer(embedKey);
        if (cached) {
          this.telemetry.metrics.embeddingCacheTotal
            .labels({ cache_name: this.name, result: 'hit' }).inc();
          // Decode Float32 buffer
          const vector: number[] = [];
          for (let i = 0; i < cached.length; i += 4) {
            vector.push(cached.readFloatLE(i));
          }
          return { vector, durationSec: 0 };
        }
      } catch { /* ignore cache read errors */ }
      this.telemetry.metrics.embeddingCacheTotal
        .labels({ cache_name: this.name, result: 'miss' }).inc();
    }

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

    // Store in embedding cache
    if (this.embeddingCacheEnabled && text) {
      const hash = createHash('sha256').update(text).digest('hex');
      const embedKey = `${this.embedKeyPrefix}${hash}`;
      try {
        const buf = encodeFloat32(vector);
        await this.client.set(embedKey, buf, 'EX', this.embeddingCacheTtl);
      } catch { /* ignore cache write errors */ }
    }

    return { vector, durationSec };
  }

  /**
   * Wraps a method body in an OTel span with automatic status, end, and
   * operation duration metric. The span is passed to fn so callers can
   * set attributes - but callers must NOT call span.end() or span.setStatus(),
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

  /** Append to the rolling similarity window sorted set and trim to 10,000 entries or 7 days. */
  private async recordSimilarityWindow(
    score: number,
    result: 'hit' | 'miss',
    category: string,
  ): Promise<void> {
    const now = Date.now();
    // Include a unique nonce so identical (score, result, category) tuples are
    // each recorded as distinct ZADD members instead of overwriting each other.
    const member = JSON.stringify({ score, result, category, _n: Math.random() });
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    try {
      const pipeline = this.client.pipeline();
      pipeline.zadd(this.similarityWindowKey, now, member);
      // Trim by time: remove entries older than 7 days
      pipeline.zremrangebyscore(this.similarityWindowKey, '-inf', sevenDaysAgo);
      // Trim by count: keep at most 10,000 most recent
      pipeline.zremrangebyrank(this.similarityWindowKey, 0, -10001);
      await pipeline.exec();
    } catch { /* best effort - never fail on window writes */ }
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

// -- ThresholdEffectiveness types --

export interface ThresholdEffectivenessResult {
  category: string;
  sampleCount: number;
  currentThreshold: number;
  hitRate: number;
  uncertainHitRate: number;
  nearMissRate: number;
  avgHitSimilarity: number;
  avgMissSimilarity: number;
  recommendation: 'tighten_threshold' | 'loosen_threshold' | 'optimal' | 'insufficient_data';
  recommendedThreshold?: number;
  reasoning: string;
}
