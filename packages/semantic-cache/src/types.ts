import type Valkey from 'iovalkey';
import type { Registry } from 'prom-client';

export type { Valkey };

export type EmbedFn = (text: string) => Promise<number[]>;

export interface SemanticCacheOptions {
  /** Index name prefix used for Valkey keys. Default: 'betterdb_scache'. */
  name?: string;
  /** iovalkey client instance. Required. */
  client: Valkey;
  /** Async function that returns a float embedding vector for a text string. Required. */
  embedFn: EmbedFn;
  /**
   * Default similarity threshold as cosine DISTANCE (0–2 scale, lower = more similar).
   * A lookup is a hit when score <= threshold. Default: 0.1.
   * NOTE: this is cosine DISTANCE not cosine SIMILARITY.
   * Distance 0 = identical, distance 2 = opposite.
   */
  defaultThreshold?: number;
  /** Default TTL in seconds for stored entries. undefined = no expiry. */
  defaultTtl?: number;
  /**
   * Per-category threshold overrides (cosine distance, 0–2).
   * Applied when CacheCheckOptions.category matches a key here.
   * Example: { faq: 0.08, search: 0.15 }
   */
  categoryThresholds?: Record<string, number>;
  /**
   * Width of the "uncertainty band" below the threshold.
   * A hit whose cosine distance falls within [threshold - band, threshold]
   * is returned with confidence 'uncertain' instead of 'high'.
   *
   * What to do with an uncertain hit:
   * - Use the cached response but flag it for downstream review
   * - Fall back to the LLM and optionally update the cache entry
   * - Collect uncertain hits via Prometheus/OTel and review them to tune
   *   your threshold — a high rate of uncertain hits suggests your threshold
   *   is too loose
   *
   * Default: 0.05. Set to 0 to disable uncertainty flagging (all hits are 'high').
   */
  uncertaintyBand?: number;
  telemetry?: {
    /** OTel tracer name. Default: '@betterdb/semantic-cache'. */
    tracerName?: string;
    /** Prefix for Prometheus metric names. Default: 'semantic_cache'. */
    metricsPrefix?: string;
    /**
     * prom-client Registry to register metrics on.
     * If omitted, uses the prom-client default registry.
     * Pass a custom Registry in library/multi-tenant contexts to avoid
     * polluting the host application's default registry.
     */
    registry?: Registry;
  };
}

export interface CacheCheckOptions {
  /** Per-request threshold override (cosine distance 0–2). Highest priority. */
  threshold?: number;
  /** Category tag — used for per-category threshold lookup and metric labels. */
  category?: string;
  /**
   * Additional FT.SEARCH pre-filter expression.
   * Example: '@model:{gpt-4o}'
   * Applied as: "({filter})=>[KNN {k} @embedding $vec AS __score]"
   *
   * **Security note:** this string is interpolated directly into the FT.SEARCH
   * query. Only pass trusted, programmatically-constructed expressions — never
   * unsanitised user input.
   */
  filter?: string;
  /**
   * Number of nearest neighbours to fetch via KNN. Default: 1.
   * Currently only the closest result is evaluated for hit/miss.
   * Values > 1 are reserved for future multi-candidate support.
   */
  k?: number;
}

export interface CacheStoreOptions {
  /** Per-entry TTL in seconds. Overrides SemanticCacheOptions.defaultTtl. */
  ttl?: number;
  /** Category tag stored with the entry. */
  category?: string;
  /** Model name stored with the entry (e.g. 'gpt-4o'). Enables invalidation by model. */
  model?: string;
  /**
   * Arbitrary metadata stored as JSON alongside the entry.
   * Stored for external consumption (e.g. BetterDB Monitor) — not returned by check().
   */
  metadata?: Record<string, string | number>;
}

export type CacheConfidence = 'high' | 'uncertain' | 'miss';

export interface CacheCheckResult {
  hit: boolean;
  response?: string;
  /**
   * Cosine distance score (0–2). Present when a nearest neighbour was found,
   * regardless of whether it was a hit or miss.
   */
  similarity?: number;
  /**
   * Confidence classification for the result.
   *
   * - 'high': similarity score is comfortably below the threshold (distance <= threshold - uncertaintyBand).
   *   Safe to return directly.
   * - 'uncertain': similarity score is close to the threshold boundary
   *   (threshold - uncertaintyBand < distance <= threshold).
   *   Consider falling back to the LLM or flagging for review.
   * - 'miss': no hit. response is undefined.
   */
  confidence: CacheConfidence;
  /** Valkey key of the matched entry. Present on hit only. */
  matchedKey?: string;
  /**
   * On a miss where a candidate existed but didn't clear the threshold,
   * describes how close it was. Useful for threshold tuning.
   */
  nearestMiss?: {
    similarity: number;
    deltaToThreshold: number;
  };
}

export interface InvalidateResult {
  /** Number of entries deleted in this call. */
  deleted: number;
  /**
   * True if the result set was truncated at 1000 entries.
   * If true, call invalidate() again with the same filter until truncated is false.
   */
  truncated: boolean;
}

export interface CacheStats {
  hits: number;
  misses: number;
  total: number;
  hitRate: number;
}

export interface IndexInfo {
  name: string;
  numDocs: number;
  dimension: number;
  indexingState: string;
}
