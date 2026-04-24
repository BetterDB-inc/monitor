export { SemanticCache } from './SemanticCache';
export type { ThresholdEffectivenessResult } from './SemanticCache';
export { DEFAULT_COST_TABLE } from './defaultCostTable';
export type {
  SemanticCacheOptions,
  CacheCheckOptions,
  CacheStoreOptions,
  CacheCheckResult,
  CacheStats,
  IndexInfo,
  InvalidateResult,
  CacheConfidence,
  EmbedFn,
  ModelCost,
  RerankOptions,
} from './types';
export {
  SemanticCacheUsageError,
  EmbeddingError,
  ValkeyCommandError,
} from './errors';
export type {
  ContentBlock,
  TextBlock,
  BinaryBlock,
  ToolCallBlock,
  ToolResultBlock,
  ReasoningBlock,
  BlockHints,
} from './utils';
export type { BinaryRef, BinaryNormalizer, NormalizerConfig } from './normalizer';
export {
  hashBase64,
  hashBytes,
  hashUrl,
  fetchAndHash,
  passthrough,
  composeNormalizer,
  defaultNormalizer,
} from './normalizer';
export type { DiscoveryOptions } from './discovery';
