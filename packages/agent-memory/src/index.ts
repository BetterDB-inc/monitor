export * from '@betterdb/agent-cache';
export { MemoryStore } from './MemoryStore';
export type {
  MemoryStoreOptions,
  MemoryDiscoveryConfig,
  MemoryConfigRefreshConfig,
  ConsolidationConfig,
  MemoryConfigSnapshot,
  MemoryStats,
} from './MemoryStore';
export { reconcile, applyOps } from './reconcileFacts';
export type { FactOp } from './reconcileFacts';
export { MemoryDiscovery, MEMORY_CACHE_TYPE, MEMORY_CAPABILITIES } from './discovery';
export type { MemoryDiscoveryDeps, MemoryMarker } from './discovery';
export { createMemoryTelemetry, DEFAULT_METRICS_PREFIX, DEFAULT_TRACER_NAME } from './telemetry';
export type { MemoryTelemetry, MemoryTelemetryOptions, MemoryMetrics } from './telemetry';
export { AgentMemory } from './AgentMemory';
export type { AgentMemoryOptions, AgentMemoryConfig } from './AgentMemory';
export type {
  EmbedFn,
  MemoryStoreClient,
  MemoryScope,
  RememberOptions,
  MemoryItem,
  RecallOptions,
  MemoryHit,
  ConsolidateOptions,
  ConsolidateResult,
  Fact,
  FactExtractor,
  ConsolidateFactsOptions,
  ConsolidateFactsResult,
  MemoryListOptions,
  MemoryListResult,
} from './types';
export { compositeScore, similarityFromDistance } from './compositeScore';
export type { RecallWeights, CompositeScoreParams } from './compositeScore';
export { MATCH_ALL_MEMORY_QUERY } from './buildRecallQuery';
