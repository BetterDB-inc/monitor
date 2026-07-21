import { randomUUID } from 'node:crypto';
import { SpanStatusCode, type Span } from '@opentelemetry/api';
import {
  encodeFloat32,
  isIndexNotFoundError,
  parseFtInfoStats,
  parseFtSearchResponse,
} from '@betterdb/valkey-search-kit';
import { buildMemoryRecord } from './buildMemoryRecord';
import { buildMemoryIndexArgs, memoryIndexName } from './buildMemoryIndex';
import {
  buildConsolidateFilter,
  buildRecallQuery,
  buildScopeFilter,
  MATCH_ALL_MEMORY_QUERY,
  SCORE_FIELD,
} from './buildRecallQuery';
import { parseMemoryItem } from './parseMemoryItem';
import { reconcile, applyOps, factContent, storedFactToFact, subjectKey } from './reconcileFacts';
import { compositeScore, similarityFromDistance, type RecallWeights } from './compositeScore';
import { selectEvictions, type EvictionCandidate } from './selectEvictions';
import { MemoryDiscovery } from './discovery';
import {
  createMemoryTelemetry,
  type MemoryTelemetry,
  type MemoryTelemetryOptions,
} from './telemetry';
import {
  createAnalytics,
  NOOP_ANALYTICS,
  type Analytics,
  type AnalyticsOptions,
} from './analytics';
import type {
  ConsolidateFactsOptions,
  ConsolidateFactsResult,
  ConsolidateOptions,
  ConsolidateResult,
  EmbedFn,
  Fact,
  MemoryHit,
  MemoryItem,
  MemoryListOptions,
  MemoryListResult,
  MemoryScope,
  MemoryStoreClient,
  RecallOptions,
  RememberOptions,
} from './types';

// Cosine-distance ceiling for recall (lower = closer). Sized so mainstream
// embedding models — whose correct matches can land near ~0.3 — aren't silently
// filtered out; a tighter gate is available per call or via config.
const DEFAULT_THRESHOLD = 0.33;
// When recall returns nothing but the nearest candidate's distance was within
// this multiple of the threshold, it's flagged as a near-miss (the threshold,
// not the data, likely dropped a good hit).
const RECALL_NEAR_MISS_FACTOR = 2;
const DEFAULT_WEIGHTS: RecallWeights = { similarity: 0.6, recency: 0.25, importance: 0.15 };
const DEFAULT_HALF_LIFE_SECONDS = 604800; // 7 days
const DEFAULT_RECALL_K = 8;
const RECALL_OVERFETCH = 4;
const FORGET_BATCH_SIZE = 500;
const FORGET_MAX_BATCHES = 10000;
const EVICTION_SCAN_LIMIT = 10000;
const CONSOLIDATE_SCAN_LIMIT = 10000;
const DEFAULT_SUMMARY_IMPORTANCE = 0.7;
const SUMMARY_SOURCE = 'summary';
const FACT_SOURCE = 'fact';
const DEFAULT_FACT_IMPORTANCE = 0.7;
const DEFAULT_IMPORTANCE = 0.5;
const DEFAULT_CONFIG_REFRESH_MS = 30000;
const MIN_CONFIG_REFRESH_MS = 1000;
const MAX_DISTANCE = 2;
const DEFAULT_LIST_LIMIT = 20;

// Read lazily so only discovery users pay the disk read on import (and avoid a
// bundler hazard, since package.json is not always emitted).
function packageVersion(): string {
  return (require('../package.json') as { version: string }).version;
}

export interface MemoryDiscoveryConfig {
  version?: string;
  heartbeatIntervalMs?: number;
}

export interface MemoryConfigRefreshConfig {
  enabled?: boolean;
  intervalMs?: number;
}

/**
 * Fact consolidation (write-time distillation of source memories into curated,
 * additive fact memories via {@link MemoryStore.consolidateFacts}). Always
 * available; this config only customizes the fact source tag and default
 * importance.
 */
export interface ConsolidationConfig {
  /** @deprecated Ignored — fact consolidation is always available; the enable-gate was removed. */
  enabled?: boolean;
  /** `source` tag written on fact memories (also excluded from re-consolidation). Default 'fact'. */
  factSource?: string;
  /** Default importance for written fact memories. Default 0.7. */
  factImportance?: number;
}

// Fact consolidation is always available (the old enable-gate was dropped); this
// only resolves the customizable fact source tag and default fact importance.
function resolveConsolidation(config: boolean | ConsolidationConfig | undefined): {
  factSource: string;
  factImportance: number;
} {
  const obj = typeof config === 'object' && config !== null ? config : undefined;
  return {
    factSource: obj?.factSource ?? FACT_SOURCE,
    factImportance: obj?.factImportance ?? DEFAULT_FACT_IMPORTANCE,
  };
}

export interface MemoryConfigSnapshot {
  threshold: number;
  weights: RecallWeights;
  halfLifeSeconds: number;
  maxItemsPerScope?: number;
}

export interface MemoryStats {
  itemCount: number;
  evictions: number;
  config: MemoryConfigSnapshot;
}

export interface MemoryStoreOptions {
  client: MemoryStoreClient;
  name: string;
  embedFn?: EmbedFn;
  defaultThreshold?: number;
  weights?: RecallWeights;
  halfLifeSeconds?: number;
  maxItemsPerScope?: number;
  discovery?: boolean | MemoryDiscoveryConfig;
  configRefresh?: boolean | MemoryConfigRefreshConfig;
  telemetry?: MemoryTelemetryOptions;
  analytics?: AnalyticsOptions;
  /**
   * Customize write-time fact consolidation (consolidateFacts): fact source tag
   * and default importance. Consolidation itself is always available — passing
   * `false` (or nothing) no longer disables it.
   */
  consolidation?: boolean | ConsolidationConfig;
}

export class MemoryStore {
  private readonly client: MemoryStoreClient;
  private readonly name: string;
  private readonly embedFn?: EmbedFn;
  private defaultThreshold: number;
  private weights: RecallWeights;
  private halfLifeSeconds: number;
  private maxItemsPerScope?: number;
  private readonly initialThreshold: number;
  private readonly initialWeights: RecallWeights;
  private readonly initialHalfLifeSeconds: number;
  private readonly initialMaxItemsPerScope?: number;
  private readonly configKey: string;
  private configRefreshHandle: ReturnType<typeof setInterval> | null = null;
  private readonly discovery: MemoryDiscovery | null;
  private discoveryReady: Promise<void> | null = null;
  private readonly telemetry: MemoryTelemetry;
  private readonly storeLabels: Record<string, string>;
  private dims?: number;
  private readonly analyticsOptions?: AnalyticsOptions;
  private analytics: Analytics = NOOP_ANALYTICS;
  private analyticsStarted = false;
  // Aggregate flow counts captured once as a `memory_session` roll-up on exit,
  // so we learn how the store is actually used without a per-operation event.
  private readonly sessionCounts = {
    remembered: 0,
    recalled: 0,
    recallHits: 0,
    forgotten: 0,
    consolidated: 0,
    evicted: 0,
  };
  private sessionFlushed = false;
  private sessionExitHandler: (() => void) | null = null;
  // Fire the recall near-miss console warning at most once per store instance,
  // so a mis-set threshold surfaces without spamming every recall call.
  private nearMissWarned = false;
  private readonly factSource: string;
  private readonly defaultFactImportance: number;

  constructor(options: MemoryStoreOptions) {
    this.client = options.client;
    this.name = options.name;
    this.embedFn = options.embedFn;
    this.telemetry = createMemoryTelemetry(options.telemetry);
    this.storeLabels = { store_name: this.name };
    this.initialThreshold = options.defaultThreshold ?? DEFAULT_THRESHOLD;
    this.initialWeights = { ...(options.weights ?? DEFAULT_WEIGHTS) };
    this.initialHalfLifeSeconds = options.halfLifeSeconds ?? DEFAULT_HALF_LIFE_SECONDS;
    this.initialMaxItemsPerScope = options.maxItemsPerScope;
    this.defaultThreshold = this.initialThreshold;
    this.weights = { ...this.initialWeights };
    this.halfLifeSeconds = this.initialHalfLifeSeconds;
    this.maxItemsPerScope = this.initialMaxItemsPerScope;
    this.configKey = `${this.name}:__mem_config`;
    this.discovery = this.createDiscovery(options.discovery);
    this.startConfigRefresh(options.configRefresh);
    this.analyticsOptions = options.analytics;
    const consolidation = resolveConsolidation(options.consolidation);
    this.factSource = consolidation.factSource;
    this.defaultFactImportance = consolidation.factImportance;
  }

  // Fire-once: defer analytics startup to the first index-lifecycle call so the
  // real client is awaited before any event is captured (the constructor cannot
  // await). Never lets analytics break the memory store.
  private async ensureAnalyticsStarted(): Promise<void> {
    if (this.analyticsStarted) {
      return;
    }
    this.analyticsStarted = true;
    try {
      const analytics = await createAnalytics({
        disabled: this.analyticsOptions?.disabled,
      });
      this.analytics = analytics;
      await analytics.init(this.client, this.name, {
        hasEmbedFn: this.embedFn !== undefined,
        maxItemsPerScope: this.maxItemsPerScope,
        discovery: this.discovery !== null,
      });
      // Short-lived consumers frequently never call close(), so emit the
      // session roll-up when the event loop drains as a backstop. close()
      // supersedes and unregisters it.
      if (analytics !== NOOP_ANALYTICS && this.sessionExitHandler === null) {
        this.sessionExitHandler = () => {
          this.captureSession();
          void this.analytics.flush();
        };
        process.once('beforeExit', this.sessionExitHandler);
      }
    } catch {
      this.analytics = NOOP_ANALYTICS;
    }
  }

  // Emit the aggregate flow counts once. Guarded so the close() path and the
  // beforeExit backstop can't double-count. Silent when nothing happened.
  private captureSession(): void {
    if (this.sessionFlushed) {
      return;
    }
    const counts = this.sessionCounts;
    const total =
      counts.remembered + counts.recalled + counts.forgotten + counts.consolidated + counts.evicted;
    if (total === 0) {
      // Nothing worth reporting yet — leave the one-shot armed so a later
      // close() (after real activity) can still emit the summary.
      return;
    }
    this.sessionFlushed = true;
    this.analytics.capture('memory_session', {
      remembered: counts.remembered,
      recalled: counts.recalled,
      recall_hits: counts.recallHits,
      forgotten: counts.forgotten,
      consolidated: counts.consolidated,
      evicted: counts.evicted,
    });
  }

  currentConfig(): MemoryConfigSnapshot {
    return {
      threshold: this.defaultThreshold,
      weights: { ...this.weights },
      halfLifeSeconds: this.halfLifeSeconds,
      maxItemsPerScope: this.maxItemsPerScope,
    };
  }

  async get(id: string): Promise<MemoryItem | null> {
    await this.ensureAnalyticsStarted();
    const key = `${this.name}:mem:${id}`;
    const fields = parseHashReply(await this.client.call('HGETALL', key));
    if (Object.keys(fields).length === 0) {
      return null;
    }
    return parseMemoryItem(this.name, { key, fields });
  }

  async list(options: MemoryListOptions = {}): Promise<MemoryListResult> {
    await this.ensureAnalyticsStarted();
    const tags = options.tags ?? [];
    const scope: MemoryScope = {
      threadId: options.threadId,
      agentId: options.agentId,
      namespace: options.namespace,
    };
    const limit = options.limit ?? DEFAULT_LIST_LIMIT;
    const offset = options.offset ?? 0;
    const raw = await this.client.call(
      'FT.SEARCH',
      `${this.name}:mem:idx`,
      buildScopeFilter(scope, tags),
      'RETURN',
      '10',
      'content',
      'importance',
      'tags',
      'created_at',
      'last_accessed_at',
      'access_count',
      'source',
      'threadId',
      'agentId',
      'namespace',
      'SORTBY',
      'created_at',
      'DESC',
      'LIMIT',
      String(offset),
      String(limit),
      'DIALECT',
      '2',
    );
    const total = ftSearchTotal(raw);
    const items = parseFtSearchResponse(raw).map((hit) => parseMemoryItem(this.name, hit));
    return { items, total };
  }

  async stats(): Promise<MemoryStats> {
    await this.ensureAnalyticsStarted();
    const infoRaw = await this.client.call('FT.INFO', memoryIndexName(this.name));
    const { numDocs } = parseFtInfoStats(infoRaw as unknown[]);
    const statsFields = parseHashReply(
      await this.client.call('HGETALL', `${this.name}:__mem_stats`),
    );
    const evictions = Number(statsFields.evictions ?? '0');
    return {
      itemCount: numDocs,
      evictions: Number.isFinite(evictions) ? evictions : 0,
      config: this.currentConfig(),
    };
  }

  async refreshConfig(): Promise<void> {
    try {
      const raw = await this.client.call('HGETALL', this.configKey);
      this.applyConfig(parseHashReply(raw));
    } catch {
      // Best-effort: a failed refresh keeps the last-known config in place.
    }
  }

  private startConfigRefresh(config?: boolean | MemoryConfigRefreshConfig): void {
    if (!config) {
      return;
    }
    const settings = config === true ? {} : config;
    if (settings.enabled === false) {
      return;
    }
    const intervalMs = Math.max(
      MIN_CONFIG_REFRESH_MS,
      settings.intervalMs ?? DEFAULT_CONFIG_REFRESH_MS,
    );
    void this.refreshConfig();
    const handle = setInterval(() => {
      void this.refreshConfig();
    }, intervalMs);
    handle.unref?.();
    this.configRefreshHandle = handle;
  }

  private applyConfig(raw: Record<string, string>): void {
    let threshold = this.initialThreshold;
    // Weights are a partial update: if any component is in the config, start
    // from the LIVE weights and overlay only what's present, so tuning one knob
    // (the proposal engine's common case) doesn't reset the others. With no
    // weight field at all, fall back to the constructor values like the rest.
    const weightFieldPresent =
      raw['recall.weights.similarity'] !== undefined ||
      raw['recall.weights.recency'] !== undefined ||
      raw['recall.weights.importance'] !== undefined;
    const weights: RecallWeights = { ...(weightFieldPresent ? this.weights : this.initialWeights) };
    let halfLifeSeconds = this.initialHalfLifeSeconds;
    let maxItemsPerScope = this.initialMaxItemsPerScope;

    for (const [field, value] of Object.entries(raw)) {
      const num = Number(value);
      if (!Number.isFinite(num)) {
        continue;
      }
      switch (field) {
        case 'recall.threshold':
          if (num >= 0 && num <= MAX_DISTANCE) {
            threshold = num;
          }
          break;
        case 'recall.weights.similarity':
          if (num >= 0) {
            weights.similarity = num;
          }
          break;
        case 'recall.weights.recency':
          if (num >= 0) {
            weights.recency = num;
          }
          break;
        case 'recall.weights.importance':
          if (num >= 0) {
            weights.importance = num;
          }
          break;
        case 'recall.halfLifeSeconds':
          if (num > 0) {
            halfLifeSeconds = num;
          }
          break;
        case 'maxItemsPerScope':
          if (num >= 1) {
            maxItemsPerScope = Math.floor(num);
          }
          break;
        default:
          break;
      }
    }

    this.defaultThreshold = threshold;
    // An all-zero weight vector would make every composite score 0 and leave
    // recall ordering undefined, so reject it and keep the configured weights.
    const weightSum = weights.similarity + weights.recency + weights.importance;
    this.weights = weightSum > 0 ? weights : { ...this.initialWeights };
    this.halfLifeSeconds = halfLifeSeconds;
    this.maxItemsPerScope = maxItemsPerScope;
  }

  private createDiscovery(config?: boolean | MemoryDiscoveryConfig): MemoryDiscovery | null {
    if (!config) {
      return null;
    }
    const settings = config === true ? {} : config;
    const discovery = new MemoryDiscovery({
      client: this.client,
      name: this.name,
      version: settings.version ?? packageVersion(),
      statsKey: `${this.name}:__mem_stats`,
      heartbeatIntervalMs: settings.heartbeatIntervalMs,
    });
    // Registration is fire-and-forget so construction stays synchronous;
    // close() awaits it before tearing the marker down. The floating catch
    // keeps any rejected registration from surfacing as an unhandled rejection
    // when close() is never called.
    const ready = discovery.register();
    ready.catch(() => undefined);
    this.discoveryReady = ready;
    return discovery;
  }

  async ensureDiscoveryReady(): Promise<void> {
    if (this.discoveryReady) {
      await this.discoveryReady.catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    if (this.configRefreshHandle) {
      clearInterval(this.configRefreshHandle);
      this.configRefreshHandle = null;
    }
    if (this.discoveryReady) {
      await this.discoveryReady.catch(() => undefined);
    }
    if (this.discovery) {
      await this.discovery.stop({ deleteHeartbeat: true });
    }
    this.captureSession();
    if (this.sessionExitHandler) {
      process.removeListener('beforeExit', this.sessionExitHandler);
      this.sessionExitHandler = null;
    }
    await this.analytics.shutdown();
  }

  /**
   * Create the `{name}:mem:idx` vector index if it does not already exist.
   * Idempotent — an existing index is left untouched. Resolves the vector
   * dimension from `embedFn` when it has not been observed yet. Call once
   * before the first remember/recall; the AgentMemory facade does this in
   * initialize().
   */
  async ensureIndex(): Promise<void> {
    await this.ensureAnalyticsStarted();
    try {
      await this.client.call('FT.INFO', memoryIndexName(this.name));
      return;
    } catch (err) {
      if (!isIndexNotFoundError(err)) {
        throw err;
      }
    }
    const dims = await this.resolveDims();
    await this.client.call('FT.CREATE', ...buildMemoryIndexArgs(this.name, dims));
    this.analytics.capture('index_created', { dims });
  }

  async recall(query: string, options: RecallOptions = {}): Promise<MemoryHit[]> {
    await this.ensureAnalyticsStarted();
    return this.traced('recall', async (span) => {
      const startedAt = Date.now();
      const vector = await this.embed(query);
      return this.runRecall(vector, options, span, startedAt);
    });
  }

  async recallByVector(vector: number[], options: RecallOptions = {}): Promise<MemoryHit[]> {
    await this.ensureAnalyticsStarted();
    return this.traced('recall', (span) => this.runRecall(vector, options, span, Date.now()));
  }

  private async runRecall(
    vector: number[],
    options: RecallOptions,
    span: Span,
    startedAt: number,
  ): Promise<MemoryHit[]> {
    const k = options.k ?? DEFAULT_RECALL_K;
    const threshold = options.threshold ?? this.defaultThreshold;
    const weights = options.weights ?? this.weights;
    const halfLifeSeconds = this.halfLifeSeconds;
    const fetchK = k * RECALL_OVERFETCH;
    const tags = options.tags ?? [];
    const scope = {
      threadId: options.threadId,
      agentId: options.agentId,
      namespace: options.namespace,
    };
    span.setAttribute('recall.k', k);

    const queryString = buildRecallQuery(fetchK, scope, tags);
    const raw = await this.client.call(
      'FT.SEARCH',
      `${this.name}:mem:idx`,
      queryString,
      'PARAMS',
      '2',
      'vec',
      encodeFloat32(vector),
      'LIMIT',
      '0',
      String(fetchK),
      'DIALECT',
      '2',
    );

    const now = Date.now();
    const hits: MemoryHit[] = [];
    // Track the closest candidate seen regardless of the threshold, so a recall
    // that returns nothing can tell whether a good hit was dropped just outside.
    let nearestDistance = Infinity;
    for (const hit of parseFtSearchResponse(raw)) {
      const rawScore = hit.fields[SCORE_FIELD];
      if (rawScore === undefined || rawScore.trim() === '') {
        continue;
      }
      const distance = Number(rawScore);
      if (!Number.isFinite(distance)) {
        continue;
      }
      if (distance < nearestDistance) {
        nearestDistance = distance;
      }
      if (distance > threshold) {
        continue;
      }
      const item = parseMemoryItem(this.name, hit);
      const lastTouched = Math.max(item.createdAt, item.lastAccessedAt);
      const ageSeconds = (now - lastTouched) / 1000;
      const score = compositeScore({
        similarity: similarityFromDistance(distance),
        ageSeconds,
        importance: item.importance,
        weights,
        halfLifeSeconds,
      });
      if (!Number.isFinite(score)) {
        continue;
      }
      hits.push({ item, similarity: distance, score });
    }

    hits.sort((a, b) => b.score - a.score);
    const result = hits.slice(0, k);
    span.setAttribute('recall.candidate_count', hits.length);
    span.setAttribute('recall.result_count', result.length);

    // Near-miss diagnostic: zero hits, but the closest candidate sat just past
    // the threshold — the gate, not the corpus, likely dropped a relevant memory.
    // Surface it (span + metric + a one-time warn) instead of failing silently.
    if (
      result.length === 0 &&
      Number.isFinite(nearestDistance) &&
      // Strictly OUTSIDE the threshold: a candidate at or within the threshold was
      // admitted by the vector gate, so an empty result there is score-filtering,
      // not a too-tight threshold — don't advise raising it.
      nearestDistance > threshold &&
      nearestDistance <= threshold * RECALL_NEAR_MISS_FACTOR
    ) {
      span.setAttribute('recall.zero_hits_near_threshold', true);
      span.setAttribute('recall.nearest_distance', nearestDistance);
      this.telemetry.metrics.recallNearMiss.labels(this.storeLabels).inc();
      if (!this.nearMissWarned) {
        this.nearMissWarned = true;
        console.warn(
          `recall on '${this.name}' returned 0 hits, but the nearest candidate was at cosine ` +
            `distance ${nearestDistance.toFixed(3)} — just past the threshold ${threshold}. If your ` +
            `embedding model returns correct matches at this range, raise it via ` +
            `recall(query, { threshold }) or the store's defaultThreshold. (Warns once per store.)`,
        );
      }
    }

    this.recordRecall(result.length, (Date.now() - startedAt) / 1000);
    this.sessionCounts.recalled += 1;
    if (result.length > 0) {
      this.sessionCounts.recallHits += 1;
    }

    if (options.reinforce !== false) {
      await this.reinforce(result, now).catch(() => undefined);
    }
    return result;
  }

  private recordRecall(resultCount: number, latencySeconds: number): void {
    const metrics = this.telemetry.metrics;
    metrics.recallTotal.labels(this.storeLabels).inc();
    if (resultCount > 0) {
      metrics.recallHits.labels(this.storeLabels).inc();
    } else {
      metrics.recallEmpty.labels(this.storeLabels).inc();
    }
    metrics.recallLatency.labels(this.storeLabels).observe(latencySeconds);
  }

  private traced<T>(operation: string, fn: (span: Span) => Promise<T>): Promise<T> {
    return this.telemetry.tracer.startActiveSpan(`agent_memory.${operation}`, async (span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
        throw err;
      } finally {
        span.end();
      }
    });
  }

  private async reinforce(hits: MemoryHit[], now: number): Promise<void> {
    for (const hit of hits) {
      const key = `${this.name}:mem:${hit.item.id}`;
      // Only touch live hashes: a recalled key may already be deleted (stale
      // index) and HSET/HINCRBY would otherwise resurrect a partial record.
      const exists = Number(await this.client.call('EXISTS', key));
      if (exists === 0) {
        continue;
      }
      await this.client.call('HSET', key, 'last_accessed_at', String(now));
      await this.client.call('HINCRBY', key, 'access_count', '1');
    }
  }

  async forget(id: string): Promise<boolean> {
    await this.ensureAnalyticsStarted();
    const removed = Number(await this.client.call('DEL', `${this.name}:mem:${id}`));
    if (removed > 0) {
      this.telemetry.metrics.items.labels(this.storeLabels).dec(removed);
      this.sessionCounts.forgotten += removed;
    }
    return removed > 0;
  }

  async forgetByScope(scope: MemoryScope & { tags?: string[] }): Promise<number> {
    await this.ensureAnalyticsStarted();
    const tags = scope.tags ?? [];
    const hasFilter =
      scope.threadId !== undefined ||
      scope.agentId !== undefined ||
      scope.namespace !== undefined ||
      tags.length > 0;
    if (!hasFilter) {
      throw new Error('forgetByScope requires at least one scope field or tag');
    }

    const filter = buildScopeFilter(scope, tags);
    let deleted = 0;
    let batch = 0;

    for (; batch < FORGET_MAX_BATCHES; batch++) {
      const raw = await this.client.call(
        'FT.SEARCH',
        `${this.name}:mem:idx`,
        filter,
        'LIMIT',
        '0',
        String(FORGET_BATCH_SIZE),
        'DIALECT',
        '2',
      );
      const keys = parseFtSearchResponse(raw).map((hit) => hit.key);
      if (keys.length === 0) {
        break;
      }
      const removed = Number(await this.client.call('DEL', ...keys));
      deleted += removed;
      // Stop when a batch makes no progress (every match was already gone),
      // so a lagging index that re-lists deleted keys can't loop forever.
      if (removed === 0) {
        break;
      }
    }

    // Reaching the batch cap with work still flowing means matches may remain;
    // surface it rather than returning a partial count that reads as complete.
    if (batch === FORGET_MAX_BATCHES) {
      console.warn(
        `forgetByScope hit the ${FORGET_MAX_BATCHES}-batch safety cap for '${this.name}'; ` +
          `${deleted} memories deleted, but some matches may remain — re-run to continue.`,
      );
    }

    if (deleted > 0) {
      this.telemetry.metrics.items.labels(this.storeLabels).dec(deleted);
      this.sessionCounts.forgotten += deleted;
    }
    return deleted;
  }

  private async writeMemory(
    content: string,
    options: RememberOptions,
    now: number,
  ): Promise<string> {
    const vector = await this.embed(content);
    const id = randomUUID();
    const record = buildMemoryRecord(this.name, id, content, vector, options, now);
    await this.writeRecord(record.key, record.fields, options.ttl);
    this.telemetry.metrics.items.labels(this.storeLabels).inc();
    return id;
  }

  async remember(content: string, options: RememberOptions = {}): Promise<string> {
    await this.ensureAnalyticsStarted();
    return this.traced('remember', async (span) => {
      span.setAttribute('memory.importance', options.importance ?? DEFAULT_IMPORTANCE);
      if (options.ttl !== undefined) {
        span.setAttribute('memory.ttl', options.ttl);
      }
      const now = Date.now();
      const id = await this.writeMemory(content, options, now);
      this.sessionCounts.remembered += 1;
      // Capacity enforcement is best-effort: the memory is already durably stored,
      // so a failed eviction pass must not reject an otherwise successful write.
      await this.enforceCapacity(options, now).catch(() => undefined);
      return id;
    });
  }

  /**
   * Consolidate a scoped set of memories. The mode is explicit:
   *  - `mode: 'summary'` — accumulation: `summarize(items)` folds the candidates
   *    into ONE new digest memory, optionally deleting the sources. Lossy; use it
   *    to compress volume. Items arrive oldest→newest with their dates, so the
   *    summarizer can respect recency.
   *  - `mode: 'facts'` — updates: `extractFacts(items)` returns structured facts
   *    reconciled by subject (newest `date` wins, tombstones retract) and written
   *    additively (sources kept). Use it for an updating corpus so later
   *    statements supersede earlier ones instead of being conflated.
   */
  async consolidate(options: ConsolidateOptions): Promise<ConsolidateResult>;
  async consolidate(
    options: ConsolidateFactsOptions & { mode: 'facts' },
  ): Promise<ConsolidateFactsResult>;
  async consolidate(
    options: ConsolidateOptions | (ConsolidateFactsOptions & { mode: 'facts' }),
  ): Promise<ConsolidateResult | ConsolidateFactsResult> {
    await this.ensureAnalyticsStarted();
    if (options.mode === 'facts') {
      return this.traced('consolidateFacts', (span) => this.runConsolidateFacts(options, span));
    }
    if (options.mode === 'summary') {
      return this.traced('consolidate', (span) => this.runConsolidate(options, span));
    }
    // Guard runtime (untyped) callers: an unknown mode must fail, not silently run
    // the summary path (mirrors the Python implementation).
    throw new Error(
      `consolidate: unknown mode ${JSON.stringify((options as { mode: unknown }).mode)} ` +
        `(expected 'summary' or 'facts')`,
    );
  }

  private async runConsolidate(
    options: ConsolidateOptions,
    span: Span,
  ): Promise<ConsolidateResult> {
    const now = Date.now();
    const tags = options.tags ?? [];
    const scope: MemoryScope = {
      threadId: options.threadId,
      agentId: options.agentId,
      namespace: options.namespace,
    };

    const hasCriteria =
      scope.threadId !== undefined ||
      scope.agentId !== undefined ||
      scope.namespace !== undefined ||
      tags.length > 0 ||
      options.olderThanSeconds !== undefined ||
      options.maxImportance !== undefined;
    if (!hasCriteria) {
      throw new Error(
        'consolidate requires a scope, tags, olderThanSeconds, or maxImportance to select candidates',
      );
    }

    // Push olderThanSeconds/maxImportance into the query (both are NUMERIC
    // indexed) so the scan limit applies to actual matches, not an arbitrary
    // first window, and we don't transfer rows we'd only discard. Prior
    // summaries are always excluded (-@source:{summary}) so consolidation never
    // re-folds its own output into a new summary.
    const filter = buildConsolidateFilter(scope, tags, {
      maxCreatedAt:
        options.olderThanSeconds !== undefined ? now - options.olderThanSeconds * 1000 : undefined,
      maxImportance: options.maxImportance,
      excludeSource: SUMMARY_SOURCE,
    });
    const raw = await this.client.call(
      'FT.SEARCH',
      `${this.name}:mem:idx`,
      filter,
      'RETURN',
      '11',
      'content',
      'importance',
      'tags',
      'created_at',
      'last_accessed_at',
      'access_count',
      'source',
      'threadId',
      'agentId',
      'namespace',
      // Give the summarizer each item's asserted date alongside the recency order
      // below, so a summary can't silently ignore which statement is newer.
      'date',
      'LIMIT',
      '0',
      String(CONSOLIDATE_SCAN_LIMIT),
      'DIALECT',
      '2',
    );
    const candidates = parseFtSearchResponse(raw).map((hit) => parseMemoryItem(this.name, hit));
    // Order oldest→newest so the summarizer sees the evolution of state and can
    // respect recency; FT.SEARCH itself returns candidates unordered.
    candidates.sort((a, b) => a.createdAt - b.createdAt);
    span.setAttribute('consolidate.candidates', candidates.length);

    if (candidates.length === 0) {
      span.setAttribute('consolidate.created', 0);
      span.setAttribute('consolidate.deleted', 0);
      return { consolidated: 0, created: [], deleted: 0 };
    }

    // Write the summary before deleting sources so a failure can never destroy
    // memories without leaving their consolidated replacement behind. Use the
    // capacity-free write path: consolidation is a net reduction (N sources -> 1
    // summary), and the sources still inflate the scope here, so an enforceCapacity
    // pass could otherwise evict the summary we just wrote and then delete the
    // sources — losing the content entirely.
    const summary = await options.summarize(candidates);
    const summaryId = await this.writeMemory(
      summary,
      {
        ...scope,
        tags,
        source: SUMMARY_SOURCE,
        importance: options.summaryImportance ?? DEFAULT_SUMMARY_IMPORTANCE,
      },
      now,
    );

    let deleted = 0;
    if (options.deleteSources !== false) {
      const keys = candidates.map((item) => `${this.name}:mem:${item.id}`);
      deleted = Number(await this.client.call('DEL', ...keys));
      if (deleted > 0) {
        this.telemetry.metrics.items.labels(this.storeLabels).dec(deleted);
      }
    }

    this.telemetry.metrics.consolidations.labels(this.storeLabels).inc();
    this.sessionCounts.consolidated += 1;
    this.analytics.capture('memory_consolidated', {
      sources: candidates.length,
      deleted,
    });
    span.setAttribute('consolidate.created', 1);
    span.setAttribute('consolidate.deleted', deleted);
    return { consolidated: candidates.length, created: [summaryId], deleted };
  }

  /**
   * Write-time fact consolidation: distill the selected source memories into
   * atomic, deduplicated fact memories and ADD them (sources are kept, so recall
   * is never reduced). The reconcile pass keys facts by subject, letting a newer
   * dated statement supersede an older one and tombstones retract a subject.
   *
   * @deprecated Use `consolidate({ mode: 'facts', ... })`. Kept as a thin alias.
   */
  async consolidateFacts(options: ConsolidateFactsOptions): Promise<ConsolidateFactsResult> {
    return this.consolidate({ ...options, mode: 'facts' });
  }

  private async runConsolidateFacts(
    options: ConsolidateFactsOptions,
    span: Span,
  ): Promise<ConsolidateFactsResult> {
    const now = Date.now();
    const tags = options.tags ?? [];
    const scope: MemoryScope = {
      threadId: options.threadId,
      agentId: options.agentId,
      namespace: options.namespace,
    };

    const hasCriteria =
      scope.threadId !== undefined ||
      scope.agentId !== undefined ||
      scope.namespace !== undefined ||
      tags.length > 0 ||
      options.olderThanSeconds !== undefined ||
      options.maxImportance !== undefined;
    if (!hasCriteria) {
      throw new Error(
        'consolidateFacts requires a scope, tags, olderThanSeconds, or maxImportance to select source memories',
      );
    }

    // Exclude prior fact memories so a re-run never re-distills its own output.
    const filter = buildConsolidateFilter(scope, tags, {
      maxCreatedAt:
        options.olderThanSeconds !== undefined ? now - options.olderThanSeconds * 1000 : undefined,
      maxImportance: options.maxImportance,
      excludeSource: this.factSource,
    });
    const raw = await this.client.call(
      'FT.SEARCH',
      `${this.name}:mem:idx`,
      filter,
      'RETURN',
      '12',
      'content',
      'importance',
      'tags',
      'created_at',
      'last_accessed_at',
      'access_count',
      'source',
      'threadId',
      'agentId',
      'namespace',
      // Surface the reconcile keys to the extractor callback: `date` drives
      // newest-wins and `subject` is the reconcile key, so an extractFacts seam
      // can read them off each MemoryItem instead of the caller re-deriving them.
      'subject',
      'date',
      // Deterministic oldest→newest ordering (created_at is NUMERIC SORTABLE) so
      // the extractor's rendered input is stable run-to-run — FT.SEARCH is
      // otherwise unordered, which left the same candidates in a shifting order.
      'SORTBY',
      'created_at',
      'ASC',
      'LIMIT',
      '0',
      String(CONSOLIDATE_SCAN_LIMIT),
      'DIALECT',
      '2',
    );
    const candidates = parseFtSearchResponse(raw).map((hit) => parseMemoryItem(this.name, hit));
    span.setAttribute('consolidate_facts.candidates', candidates.length);

    if (candidates.length === 0) {
      span.setAttribute('consolidate_facts.facts', 0);
      span.setAttribute('consolidate_facts.created', 0);
      span.setAttribute('consolidate_facts.deleted', 0);
      return { candidates: 0, facts: 0, created: [], deleted: 0, unmatchedTombstones: [] };
    }

    // Load the fact memories already written for this scope so reconciliation
    // considers them (not just the current batch): a re-run over the same
    // sources is idempotent, a newer statement supersedes the stored fact, and a
    // tombstone retracts it. Only facts that carry a persisted `subject` (the
    // reconcile key) can participate; pre-subject rows are left untouched.
    const existingFacts = await this.loadExistingFacts(scope, tags);
    const existingBySubject = new Map<string, { id: string; content: string }>();
    // Self-heal a concurrent-write race: two consolidateFacts runs that each
    // wrote a fact for the same subject leave a duplicate row. Keep one canonical
    // per subject and retract the extras on this run, so tracking stays 1:1 and
    // orphaned duplicates don't accumulate forever.
    const duplicateFactIds: string[] = [];
    for (const item of existingFacts) {
      if (item.subject === undefined) {
        continue;
      }
      if (existingBySubject.has(subjectKey(item.subject))) {
        duplicateFactIds.push(item.id);
      } else {
        existingBySubject.set(subjectKey(item.subject), { id: item.id, content: item.content });
      }
    }
    const priorFacts: Fact[] = existingFacts
      .filter((item) => item.subject !== undefined)
      .map((item) => storedFactToFact(item));

    // Extract atomic facts, then reconcile against the stored facts so subject
    // collisions (within the batch AND against prior runs) resolve to the newest
    // dated statement and tombstones drop retracted subjects.
    const extracted = await options.extractFacts(candidates);
    const ops = reconcile(extracted, priorFacts);
    const curated = applyOps(priorFacts, ops);
    // A tombstone that matched no live fact is surfaced, not silently dropped.
    const unmatchedTombstones = ops.flatMap((op) =>
      op.type === 'unmatched-tombstone' ? [op.subject] : [],
    );
    if (unmatchedTombstones.length > 0) {
      this.telemetry.metrics.factTombstoneUnmatched
        .labels(this.storeLabels)
        .inc(unmatchedTombstones.length);
    }
    const curatedBySubject = new Map<string, Fact>();
    for (const fact of curated) {
      curatedBySubject.set(subjectKey(fact.subject), fact);
    }
    span.setAttribute('consolidate_facts.facts', curated.length);
    span.setAttribute('consolidate_facts.unmatched_tombstones', unmatchedTombstones.length);

    // Diff the curated set against what is stored. Writing before deleting keeps
    // a crash between the two from losing a fact (recall-safe, at worst a
    // duplicate), mirroring consolidate()'s write-then-delete ordering.
    const created: string[] = [];
    for (const fact of curated) {
      const content = factContent(fact);
      const existing = existingBySubject.get(subjectKey(fact.subject));
      // Unchanged subject already on disk: skip the write (idempotent re-run).
      if (existing !== undefined && existing.content === content) {
        continue;
      }
      const id = await this.writeMemory(
        content,
        {
          ...scope,
          tags,
          source: this.factSource,
          subject: fact.subject,
          date: fact.date,
          importance: options.factImportance ?? this.defaultFactImportance,
        },
        now,
      );
      created.push(id);
    }

    // Delete the stored fact for any subject that was superseded (its content
    // changed) or retracted (no longer in the curated set), plus any duplicate
    // rows from a prior concurrent-write race.
    const toDelete: string[] = duplicateFactIds.map((id) => `${this.name}:mem:${id}`);
    for (const [subject, existing] of existingBySubject) {
      const curatedFact = curatedBySubject.get(subject);
      if (curatedFact === undefined || factContent(curatedFact) !== existing.content) {
        toDelete.push(`${this.name}:mem:${existing.id}`);
      }
    }
    let deleted = 0;
    if (toDelete.length > 0) {
      deleted = Number(await this.client.call('DEL', ...toDelete));
      if (deleted > 0) {
        this.telemetry.metrics.items.labels(this.storeLabels).dec(deleted);
      }
    }

    this.telemetry.metrics.consolidations.labels(this.storeLabels).inc();
    span.setAttribute('consolidate_facts.created', created.length);
    span.setAttribute('consolidate_facts.deleted', deleted);
    return { candidates: candidates.length, facts: curated.length, created, deleted, unmatchedTombstones };
  }

  // Load the fact memories already written for this scope (source == factSource),
  // so a consolidateFacts run can reconcile against them.
  private async loadExistingFacts(scope: MemoryScope, tags: string[]): Promise<MemoryItem[]> {
    const filter = buildConsolidateFilter(scope, tags, { includeSource: this.factSource });
    const raw = await this.client.call(
      'FT.SEARCH',
      `${this.name}:mem:idx`,
      filter,
      'RETURN',
      '4',
      'content',
      'subject',
      'source',
      'date',
      // Deterministic oldest→newest ordering: subject collisions (e.g.
      // case-variant duplicates) resolve first-wins downstream, so which row is
      // "first" must be stable across runs; FT.SEARCH is otherwise unordered.
      'SORTBY',
      'created_at',
      'ASC',
      'LIMIT',
      '0',
      String(CONSOLIDATE_SCAN_LIMIT),
      'DIALECT',
      '2',
    );
    return parseFtSearchResponse(raw).map((hit) => parseMemoryItem(this.name, hit));
  }

  private async writeRecord(key: string, fields: (string | Buffer)[], ttl?: number): Promise<void> {
    if (ttl === undefined || ttl <= 0) {
      await this.client.call('HSET', key, ...fields);
      return;
    }
    // Set the hash and its expiry in one transaction so a crash between the two
    // can't leave a memory that should expire living forever. Atomicity assumes
    // the client routes these calls to a single connection (the MemoryStoreClient
    // contract); on a pooled client that splits them the guarantee is lost.
    await this.client.call('MULTI');
    try {
      await this.client.call('HSET', key, ...fields);
      await this.client.call('EXPIRE', key, String(ttl));
      await this.client.call('EXEC');
    } catch (err) {
      // Clear the half-built transaction so the connection isn't left mid-MULTI.
      await this.client.call('DISCARD').catch(() => undefined);
      throw err;
    }
  }

  private async enforceCapacity(
    scope: MemoryScope & { tags?: string[] },
    now: number,
  ): Promise<void> {
    const max = this.maxItemsPerScope;
    if (max === undefined) {
      return;
    }
    // Snapshot the eviction tunables alongside max so an opt-in configRefresh
    // landing mid-pass can't score victims with a different weight/half-life
    // set than the capacity check ran with.
    const weights = this.weights;
    const halfLifeSeconds = this.halfLifeSeconds;
    // Tags are part of the partition (as in recall/forgetByScope), so a
    // tag-scoped write caps its own tag bucket.
    const filter = buildScopeFilter(scope, scope.tags ?? []);
    if (filter === MATCH_ALL_MEMORY_QUERY) {
      // A fully-unscoped write has no scope to bound: enforcing here would count
      // and evict across the entire index (every other scope's memories), which
      // `maxItemsPerScope` does not promise. Skip — the write stays, uncapped.
      return;
    }
    // Count-first so the common in-capacity write pays only a cheap LIMIT 0 0
    // probe and never fetches candidate rows. Both the count and the candidate
    // scan go through FT.SEARCH, so under HNSW index lag the cap is enforced
    // approximately and up to one write behind (the unit tests mock this exact).
    const countRaw = await this.client.call(
      'FT.SEARCH',
      `${this.name}:mem:idx`,
      filter,
      'LIMIT',
      '0',
      '0',
      'DIALECT',
      '2',
    );
    const total = ftSearchTotal(countRaw);
    if (total <= max) {
      return;
    }

    // Eviction selection is exact while the scope fits EVICTION_SCAN_LIMIT (the
    // expected case); a larger scope evicts from the scanned window and the
    // remainder is reclaimed on subsequent writes.

    const raw = await this.client.call(
      'FT.SEARCH',
      `${this.name}:mem:idx`,
      filter,
      'RETURN',
      '2',
      'importance',
      'last_accessed_at',
      'LIMIT',
      '0',
      String(EVICTION_SCAN_LIMIT),
      'DIALECT',
      '2',
    );
    const candidates: EvictionCandidate[] = parseFtSearchResponse(raw).map((hit) => {
      const importance = Number(hit.fields.importance);
      const lastAccessedAt = Number(hit.fields.last_accessed_at);
      return {
        key: hit.key,
        importance: Number.isFinite(importance) ? importance : 0,
        lastAccessedAt: Number.isFinite(lastAccessedAt) ? lastAccessedAt : 0,
      };
    });
    const dropCount = Math.min(total - max, candidates.length);
    const evictKeys = selectEvictions(candidates, candidates.length - dropCount, {
      now,
      halfLifeSeconds,
      weights,
    });
    if (evictKeys.length === 0) {
      return;
    }
    // Count actual removals, not the keys we asked to drop: the index can list
    // already-deleted keys (stale), so DEL may remove fewer. Using the reply
    // keeps the stats and Prometheus gauges accurate, as forget/forgetByScope/
    // consolidate already do.
    const removed = Number(await this.client.call('DEL', ...evictKeys));
    if (!(removed > 0)) {
      return;
    }
    await this.client.call('HINCRBY', `${this.name}:__mem_stats`, 'evictions', String(removed));
    this.telemetry.metrics.evictions.labels(this.storeLabels).inc(removed);
    this.telemetry.metrics.items.labels(this.storeLabels).dec(removed);
    this.sessionCounts.evicted += removed;
  }

  private requireEmbedFn(): EmbedFn {
    if (!this.embedFn) {
      throw new Error(
        'MemoryStore was constructed without an embedFn; remember(), recall(), and ensureIndex() require one. Use get/list/stats/recallByVector for read-only access.',
      );
    }
    return this.embedFn;
  }

  private async resolveDims(): Promise<number> {
    if (this.dims !== undefined) {
      return this.dims;
    }
    const probe = await this.requireEmbedFn()('probe');
    if (probe.length === 0) {
      throw new Error(
        'Cannot resolve memory vector dimension: embedFn returned a zero-length embedding',
      );
    }
    this.dims = probe.length;
    return this.dims;
  }

  private async embed(content: string): Promise<number[]> {
    this.telemetry.metrics.embeddingCalls.labels(this.storeLabels).inc();
    const vector = await this.requireEmbedFn()(content);
    if (this.dims === undefined) {
      this.dims = vector.length;
    } else if (vector.length !== this.dims) {
      throw new Error(
        `Embedding dimension mismatch: expected ${this.dims}, embedFn returned ${vector.length}`,
      );
    }
    return vector;
  }
}

function ftSearchTotal(raw: unknown): number {
  if (!Array.isArray(raw) || raw.length < 1) {
    return 0;
  }
  const total = typeof raw[0] === 'string' ? parseInt(raw[0], 10) : Number(raw[0]);
  return Number.isFinite(total) && total > 0 ? total : 0;
}

function parseHashReply(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (let i = 0; i + 1 < raw.length; i += 2) {
      out[String(raw[i])] = String(raw[i + 1]);
    }
  } else if (raw !== null && typeof raw === 'object') {
    for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
      out[field] = String(value);
    }
  }
  return out;
}
