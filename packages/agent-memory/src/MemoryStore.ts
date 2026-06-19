import { randomUUID } from 'node:crypto';
import { encodeFloat32, parseFtSearchResponse } from '@betterdb/valkey-search-kit';
import { buildMemoryRecord } from './buildMemoryRecord';
import { buildRecallQuery, buildScopeFilter, SCORE_FIELD } from './buildRecallQuery';
import { parseMemoryItem } from './parseMemoryItem';
import { compositeScore, similarityFromDistance, type RecallWeights } from './compositeScore';
import { selectEvictions, type EvictionCandidate } from './selectEvictions';
import type {
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

export interface MemoryStoreOptions {
  client: MemoryStoreClient;
  name: string;
  embedFn: EmbedFn;
  defaultThreshold?: number;
  weights?: RecallWeights;
  halfLifeSeconds?: number;
  maxItemsPerScope?: number;
}

export class MemoryStore {
  private readonly client: MemoryStoreClient;
  private readonly name: string;
  private readonly embedFn: EmbedFn;
  private readonly defaultThreshold: number;
  private readonly weights: RecallWeights;
  private readonly halfLifeSeconds: number;
  private readonly maxItemsPerScope?: number;
  private dims?: number;

  constructor(options: MemoryStoreOptions) {
    this.client = options.client;
    this.name = options.name;
    this.embedFn = options.embedFn;
    this.defaultThreshold = options.defaultThreshold ?? DEFAULT_THRESHOLD;
    this.weights = options.weights ?? DEFAULT_WEIGHTS;
    this.halfLifeSeconds = options.halfLifeSeconds ?? DEFAULT_HALF_LIFE_SECONDS;
    this.maxItemsPerScope = options.maxItemsPerScope;
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

  async remember(content: string, options: RememberOptions = {}): Promise<string> {
    const vector = await this.embed(content);
    const id = randomUUID();
    const now = Date.now();
    const record = buildMemoryRecord(this.name, id, content, vector, options, now);
    await this.writeRecord(record.key, record.fields, options.ttl);
    // Capacity enforcement is best-effort: the memory is already durably stored,
    // so a failed eviction pass must not reject an otherwise successful write.
    await this.enforceCapacity(options, now).catch(() => undefined);
    return id;
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
