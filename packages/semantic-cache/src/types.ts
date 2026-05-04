import type Valkey from 'iovalkey';
import type { Registry } from 'prom-client';

import type { DiscoveryOptions } from './discovery';

export type { Valkey };

export type EmbedFn = (text: string) => Promise<number[]>;

export interface ModelCost {
  inputPer1k: number;
  outputPer1k: number;
}

export interface SemanticCacheOptions {
  /** Index name prefix used for Valkey keys. Default: 'betterdb_scache'. */
  name?: string;
  /** iovalkey client instance. Required. */
  client: Valkey;
  /** Async function that returns a float embedding vector for a text string. Required. */
  embedFn: EmbedFn;
  /**
   * Model pricing for cost savings tracking. Optional.
   * Keys are model names (e.g. 'gpt-4o'), values are per-1k-token costs.
   */
  costTable?: Record<string, ModelCost>;
  /**
   * Use bundled default cost table from LiteLLM. User costTable entries override defaults.
   * Default: true.
   */
  useDefaultCostTable?: boolean;
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
  /**
   * Pluggable binary content normalizer for stable hashing of images, audio, and documents.
   * Default: passthrough (uses the ref string as-is).
   * Pass this to adapter prepareSemanticParams() calls to share the same normalization strategy.
   */
  normalizer?: import('./normalizer').BinaryNormalizer;
  /**
   * Embedding cache configuration. When enabled, computed embeddings are stored in Valkey
   * so that repeated check() calls on the same text skip the embedFn call.
   */
  embeddingCache?: {
    /** Enable embedding caching. Default: true. */
    enabled?: boolean;
    /** TTL for cached embeddings in seconds. Default: 86400 (24 hours). */
    ttl?: number;
  };
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
  analytics?: {
    /** PostHog API key. Overrides the build-time baked key if set. */
    apiKey?: string;
    /** PostHog host. Overrides the build-time baked host if set. */
    host?: string;
    /** Disable analytics. Also controlled by BETTERDB_TELEMETRY env var. */
    disabled?: boolean;
    /** Interval in ms for periodic stats snapshots. Default: 300_000 (5 min). 0 to disable. */
    statsIntervalMs?: number;
  };
  /**
   * Discovery-marker protocol controls. See
   * docs/plans/specs/spec-semantic-cache-discovery-markers.md.
   * Defaults: enabled=true, heartbeatIntervalMs=30000, includeCategories=true.
   */
  discovery?: DiscoveryOptions;
}

export interface RerankOptions {
  /**
   * Number of top-k candidates to retrieve before reranking.
   * A higher k gives the rerankFn more candidates to choose from.
   */
  k: number;
  /**
   * Function that receives the query text and ranked candidates, and returns
   * the index of the best candidate. Return -1 to reject all candidates (miss).
   */
  rerankFn: (
    query: string,
    candidates: Array<{ response: string; similarity: number }>,
  ) => Promise<number>;
}

export interface CacheCheckOptions {
  /** Per-request threshold override (cosine distance 0-2). Highest priority. */
  threshold?: number;
  /** Category tag - used for per-category threshold lookup and metric labels. */
  category?: string;
  /**
   * Additional FT.SEARCH pre-filter expression.
   * Example: '@model:{gpt-4o}'
   * Applied as: "({filter})=>[KNN {k} @embedding $vec AS __score]"
   *
   * **Security note:** this string is interpolated directly into the FT.SEARCH
   * query. Only pass trusted, programmatically-constructed expressions - never
   * unsanitised user input.
   */
  filter?: string;
  /**
   * Number of nearest neighbours to fetch via KNN. Default: 1.
   * Ignored when rerank is set (rerank.k takes precedence).
   */
  k?: number;
  /**
   * When true, a cache hit whose stored model differs from currentModel is
   * treated as a miss and the stale entry is deleted. Useful for automatically
   * evicting cache entries when you upgrade the model you use for a given prompt.
   * Requires currentModel to be set.
   * Default: false.
   */
  staleAfterModelChange?: boolean;
  /** The model name to compare against stored entries when staleAfterModelChange is true. */
  currentModel?: string;
  /**
   * Optional rerank hook. When set, FT.SEARCH retrieves rerank.k candidates
   * and passes them to rerank.rerankFn. The function returns the index of the
   * best candidate, or -1 to treat all as a miss.
   * The threshold is NOT applied to the reranked pick unless you filter candidates
   * in rerankFn yourself.
   */
  rerank?: RerankOptions;
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
   * Stored for external consumption (e.g. BetterDB Monitor) - not returned by check().
   */
  metadata?: Record<string, string | number>;
  /**
   * Number of input tokens used to generate the cached response.
   * When provided along with outputTokens and model, the cost is computed and stored.
   * On future cache hits, the stored cost is reported as costSaved in CacheCheckResult.
   */
  inputTokens?: number;
  /**
   * Number of output tokens in the cached response.
   * See inputTokens for full description.
   */
  outputTokens?: number;
  /** LLM sampling temperature stored as a NUMERIC field for opt-in filtering. */
  temperature?: number;
  /** Top-p nucleus sampling parameter stored as a NUMERIC field for opt-in filtering. */
  topP?: number;
  /** Random seed stored as a NUMERIC field for opt-in filtering. */
  seed?: number;
}

export type CacheConfidence = 'high' | 'uncertain' | 'miss';

export interface CacheCheckResult {
  hit: boolean;
  response?: string;
  /**
   * Cosine distance score (0-2). Present when a nearest neighbour was found,
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
  /**
   * Estimated cost saved (in dollars) by returning this cached result instead of calling the LLM.
   * Present on hit when the original store() call included inputTokens/outputTokens and model.
   */
  costSaved?: number;
  /**
   * Structured response content blocks. Present on hit when the entry was stored via storeMultipart().
   */
  contentBlocks?: import('./utils').ContentBlock[];
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
  /** Accumulated cost saved in microdollars (divide by 1_000_000 for dollars). */
  costSavedMicros: number;
}

export interface IndexInfo {
  name: string;
  numDocs: number;
  dimension: number;
  indexingState: string;
}
