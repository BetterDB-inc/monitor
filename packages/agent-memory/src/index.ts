export * from '@betterdb/agent-cache';
export { MemoryStore } from './MemoryStore';
export type {
  MemoryStoreOptions,
  MemoryDiscoveryConfig,
  MemoryConfigRefreshConfig,
  MemoryConfigSnapshot,
  MemoryStats,
} from './MemoryStore';
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
  MemoryListOptions,
  MemoryListResult,
} from './types';
export { compositeScore, similarityFromDistance } from './compositeScore';
export type { RecallWeights, CompositeScoreParams } from './compositeScore';
