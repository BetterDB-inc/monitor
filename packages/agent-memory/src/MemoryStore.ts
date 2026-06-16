import { randomUUID } from 'node:crypto';
import { encodeFloat32, parseFtSearchResponse } from '@betterdb/valkey-search-kit';
import { buildMemoryRecord } from './buildMemoryRecord';
import { buildRecallQuery, buildScopeFilter, SCORE_FIELD } from './buildRecallQuery';
import { parseMemoryItem } from './parseMemoryItem';
import { compositeScore, similarityFromDistance, type RecallWeights } from './compositeScore';
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

export interface MemoryStoreOptions {
  client: MemoryStoreClient;
  name: string;
  embedFn: EmbedFn;
  defaultThreshold?: number;
  weights?: RecallWeights;
  halfLifeSeconds?: number;
}

export class MemoryStore {
  private readonly client: MemoryStoreClient;
  private readonly name: string;
  private readonly embedFn: EmbedFn;
  private readonly defaultThreshold: number;
  private readonly weights: RecallWeights;
  private readonly halfLifeSeconds: number;
  private dims?: number;

  constructor(options: MemoryStoreOptions) {
    this.client = options.client;
    this.name = options.name;
    this.embedFn = options.embedFn;
    this.defaultThreshold = options.defaultThreshold ?? DEFAULT_THRESHOLD;
    this.weights = options.weights ?? DEFAULT_WEIGHTS;
    this.halfLifeSeconds = options.halfLifeSeconds ?? DEFAULT_HALF_LIFE_SECONDS;
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
      const ageSeconds = (now - item.createdAt) / 1000;
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
    return hits.slice(0, k);
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

    for (let batch = 0; batch < FORGET_MAX_BATCHES; batch++) {
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

    return deleted;
  }

  async remember(content: string, options: RememberOptions = {}): Promise<string> {
    const vector = await this.embed(content);
    const id = randomUUID();
    const now = Date.now();
    const record = buildMemoryRecord(this.name, id, content, vector, options, now);
    await this.client.call('HSET', record.key, ...record.fields);
    return id;
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
