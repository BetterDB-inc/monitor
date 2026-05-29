import { createHash } from 'node:crypto';
import { SemanticCache } from '@upstash/semantic-cache';
import { Index } from '@upstash/vector';
import { CacheAdapter } from './base.js';
import type { CheckResult, AdapterMode } from '../types.js';

/** Upstash Vector has a 1000-char limit on vector IDs. Hash long prompts. */
const MAX_ID_LENGTH = 900;
function safeId(text: string): string {
  if (text.length <= MAX_ID_LENGTH) return text;
  const hash = createHash('sha256').update(text).digest('hex');
  return text.slice(0, MAX_ID_LENGTH - 65) + '|' + hash;
}

/**
 * Adapter for @upstash/semantic-cache.
 *
 * Uses SemanticCache.set() for the store path (what real users do), but queries
 * the Index directly for checks so we can capture similarity scores — their
 * SemanticCache.get() only returns string | undefined with no score.
 *
 * Upstash embeds text server-side using the model configured at index creation
 * time (not controllable from code). Latency includes network round-trip to
 * Upstash's cloud.
 *
 * Threshold mapping: our CLI threshold is cosine distance (lower = more similar).
 * Upstash's minProximity is cosine similarity (higher = more similar).
 * Conversion: minProximity = 1 - threshold.
 *
 * Requires env vars:
 *   UPSTASH_VECTOR_REST_URL
 *   UPSTASH_VECTOR_REST_TOKEN
 */
export class UpstashAdapter extends CacheAdapter {
  private cache!: SemanticCache;
  private index!: Index;
  private readonly minProximity: number;

  constructor(threshold: number, embeddingModel: string, redisUrl: string, mode: AdapterMode) {
    super(threshold, embeddingModel, redisUrl, mode);
    this.minProximity = 1 - threshold;
  }

  get name(): string {
    return 'upstash';
  }

  enabledFeatures(): string[] {
    return [
      `cosine-similarity threshold (minProximity=${this.minProximity.toFixed(2)})`,
      'server-side embedding (model configured at index creation)',
      'cloud-hosted (latency includes network round-trip)',
    ];
  }

  override async initialize(): Promise<void> {
    const url = process.env.UPSTASH_VECTOR_REST_URL;
    const token = process.env.UPSTASH_VECTOR_REST_TOKEN;

    if (!url || !token) {
      throw new Error(
        'Upstash adapter requires UPSTASH_VECTOR_REST_URL and UPSTASH_VECTOR_REST_TOKEN env vars',
      );
    }

    this.index = new Index({ url, token });
    // Cast needed: pnpm may resolve @upstash/vector from two paths
    this.cache = new SemanticCache({ index: this.index as never, minProximity: this.minProximity });
  }

  async store(prompt: string, response: string): Promise<void> {
    // Use Index.upsert directly instead of SemanticCache.set() to control
    // the vector ID — Upstash has a 1000-char ID limit and vcache_lmarena
    // prompts can be much longer.
    await this.index.upsert({
      id: safeId(prompt),
      data: prompt,
      metadata: { data: response, dataType: 'text' },
    });
  }

  async check(prompt: string): Promise<CheckResult> {
    // Query the Index directly to get similarity scores.
    // SemanticCache.get() calls the same query internally but discards the score.
    const results = await this.index.query({
      data: prompt,
      topK: 1,
      includeMetadata: true,
    });

    if (results.length === 0) {
      return { hit: false, similarityScore: null };
    }

    const best = results[0];
    const hit = best.score >= this.minProximity;
    // Convert similarity (1=identical) back to distance (0=identical)
    const similarityScore = 1 - best.score;

    return { hit, similarityScore };
  }

  async clear(): Promise<void> {
    if (this.cache) {
      await this.cache.flush();
      // Upstash reset is async — wait for the index to be ready
      await delay(1000);
    }
  }

  override async close(): Promise<void> {
    // No persistent connection to close — Upstash uses REST API
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
