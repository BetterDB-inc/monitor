export * from '@betterdb/agent-cache';
export { MemoryStore } from './MemoryStore';
export type {
  MemoryStoreOptions,
  MemoryDiscoveryConfig,
  MemoryConfigRefreshConfig,
  MemoryConfigSnapshot,
} from './MemoryStore';
export { MemoryDiscovery, MEMORY_CACHE_TYPE, MEMORY_CAPABILITIES } from './discovery';
export type { MemoryDiscoveryDeps, MemoryMarker } from './discovery';
export { AgentMemory } from './AgentMemory';
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
} from './types';
export { compositeScore, similarityFromDistance } from './compositeScore';
export type { RecallWeights, CompositeScoreParams } from './compositeScore';
