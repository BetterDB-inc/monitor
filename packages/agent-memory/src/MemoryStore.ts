import { randomUUID } from 'node:crypto';
import { encodeFloat32, parseFtSearchResponse } from '@betterdb/valkey-search-kit';
import { buildMemoryRecord } from './buildMemoryRecord';
import {
  buildConsolidateFilter,
  buildRecallQuery,
  buildScopeFilter,
  SCORE_FIELD,
} from './buildRecallQuery';
import { parseMemoryItem } from './parseMemoryItem';
import { compositeScore, similarityFromDistance, type RecallWeights } from './compositeScore';
import { selectEvictions, type EvictionCandidate } from './selectEvictions';
import { MemoryDiscovery } from './discovery';
import type {
  ConsolidateOptions,
  ConsolidateResult,
  EmbedFn,
  MemoryHit,
  MemoryScope,
  MemoryStoreClient,
  RecallOptions,
  RememberOptions,
} from './types';

const DEFAULT_THRESHOLD = 0.25;
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
const DEFAULT_CONFIG_REFRESH_MS = 30000;
const MIN_CONFIG_REFRESH_MS = 1000;
const MAX_DISTANCE = 2;

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

export interface MemoryConfigSnapshot {
  threshold: number;
  weights: RecallWeights;
  halfLifeSeconds: number;
  maxItemsPerScope?: number;
}

export interface MemoryStoreOptions {
  client: MemoryStoreClient;
  name: string;
  embedFn: EmbedFn;
  defaultThreshold?: number;
  weights?: RecallWeights;
  halfLifeSeconds?: number;
  maxItemsPerScope?: number;
  discovery?: boolean | MemoryDiscoveryConfig;
  configRefresh?: boolean | MemoryConfigRefreshConfig;
}

export class MemoryStore {
  private readonly client: MemoryStoreClient;
  private readonly name: string;
  private readonly embedFn: EmbedFn;
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
  private dims?: number;

  constructor(options: MemoryStoreOptions) {
    this.client = options.client;
    this.name = options.name;
    this.embedFn = options.embedFn;
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
  }

  currentConfig(): MemoryConfigSnapshot {
    return {
      threshold: this.defaultThreshold,
      weights: { ...this.weights },
      halfLifeSeconds: this.halfLifeSeconds,
      maxItemsPerScope: this.maxItemsPerScope,
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
    const weights: RecallWeights = { ...this.initialWeights };
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
  }

  async recall(query: string, options: RecallOptions = {}): Promise<MemoryHit[]> {
    const k = options.k ?? DEFAULT_RECALL_K;
    const threshold = options.threshold ?? this.defaultThreshold;
    const weights = options.weights ?? this.weights;
    const fetchK = k * RECALL_OVERFETCH;
    const tags = options.tags ?? [];
    const scope = {
      threadId: options.threadId,
      agentId: options.agentId,
      namespace: options.namespace,
    };

    const vector = await this.embed(query);
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
    for (const hit of parseFtSearchResponse(raw)) {
      const rawScore = hit.fields[SCORE_FIELD];
      if (rawScore === undefined || rawScore.trim() === '') {
        continue;
      }
      const distance = Number(rawScore);
      if (!Number.isFinite(distance) || distance > threshold) {
        continue;
      }
      const item = parseMemoryItem(this.name, hit);
      // Recency decays from the last access, not creation, so reinforcement
      // (which bumps last_accessed_at) actually makes a memory more recallable.
      // max() guards against a clock-skewed last_accessed_at older than created_at.
      const lastTouched = Math.max(item.createdAt, item.lastAccessedAt);
      const ageSeconds = (now - lastTouched) / 1000;
      const score = compositeScore({
        similarity: similarityFromDistance(distance),
        ageSeconds,
        importance: item.importance,
        weights,
        halfLifeSeconds: this.halfLifeSeconds,
      });
      if (!Number.isFinite(score)) {
        continue;
      }
      hits.push({ item, similarity: distance, score });
    }

    hits.sort((a, b) => b.score - a.score);
    const result = hits.slice(0, k);

    if (options.reinforce !== false) {
      // Reinforcement is best-effort and must never break the recall read path.
      await this.reinforce(result, now).catch(() => undefined);
    }
    return result;
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
    const deleted = await this.client.call('DEL', `${this.name}:mem:${id}`);
    return Number(deleted) > 0;
  }

  async forgetByScope(scope: MemoryScope & { tags?: string[] }): Promise<number> {
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
    return id;
  }

  async remember(content: string, options: RememberOptions = {}): Promise<string> {
    const now = Date.now();
    const id = await this.writeMemory(content, options, now);
    // Capacity enforcement is best-effort: the memory is already durably stored,
    // so a failed eviction pass must not reject an otherwise successful write.
    await this.enforceCapacity(options, now).catch(() => undefined);
    return id;
  }

  async consolidate(options: ConsolidateOptions): Promise<ConsolidateResult> {
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
        options.olderThanSeconds !== undefined
          ? now - options.olderThanSeconds * 1000
          : undefined,
      maxImportance: options.maxImportance,
      excludeSource: SUMMARY_SOURCE,
    });
    const raw = await this.client.call(
      'FT.SEARCH',
      `${this.name}:mem:idx`,
      filter,
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
      'LIMIT',
      '0',
      String(CONSOLIDATE_SCAN_LIMIT),
      'DIALECT',
      '2',
    );
    const candidates = parseFtSearchResponse(raw).map((hit) => parseMemoryItem(this.name, hit));

    if (candidates.length === 0) {
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
    }

    return { consolidated: candidates.length, created: [summaryId], deleted };
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

  private async enforceCapacity(scope: MemoryScope & { tags?: string[] }, now: number): Promise<void> {
    const max = this.maxItemsPerScope;
    if (max === undefined) {
      return;
    }
    // Tags are part of the partition (as in recall/forgetByScope), so a
    // tag-scoped write caps its own tag bucket.
    const filter = buildScopeFilter(scope, scope.tags ?? []);
    if (filter === '*') {
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
      halfLifeSeconds: this.halfLifeSeconds,
      weights: this.weights,
    });
    if (evictKeys.length === 0) {
      return;
    }
    await this.client.call('DEL', ...evictKeys);
    await this.client.call(
      'HINCRBY',
      `${this.name}:__mem_stats`,
      'evictions',
      String(evictKeys.length),
    );
  }

  private async embed(content: string): Promise<number[]> {
    const vector = await this.embedFn(content);
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
