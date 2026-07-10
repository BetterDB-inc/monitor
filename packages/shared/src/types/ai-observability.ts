// Types for the AI Cache & Memory observability feature.
//
// Our AI libraries (@betterdb/agent-cache, semantic-cache, agent-memory,
// retrieval) register themselves in the Valkey discovery registry hash
// `__betterdb:caches` and refresh a per-instance heartbeat key. Monitor reads
// these to enumerate and observe them. Registry/heartbeat key constants live in
// ../utils/discovery-protocol (REGISTRY_KEY, heartbeatKeyFor). See
// docs/design/ai-cache-memory-observability.md.

export type AiInstanceKind =
  | 'agent_cache'
  | 'semantic_cache'
  | 'agent_memory'
  | 'retrieval';

/** Raw marker JSON as written by the libraries into `__betterdb:caches`. */
export interface AiInstanceMarker {
  type: string; // one of AiInstanceKind (string on the wire)
  prefix: string; // the library `name` (key namespace)
  version: string;
  protocol_version?: number;
  capabilities?: string[];
  stats_key?: string;
  index_name?: string;
  started_at?: string;
  pid?: number;
  hostname?: string;
}

/** Normalized instance as surfaced by Monitor. */
export interface AiInstance {
  /** Registry field / marker id, e.g. `myapp` or `myapp:mem`. Also the heartbeat suffix. */
  field: string;
  kind: AiInstanceKind;
  /** Library `name` / key namespace. */
  name: string;
  version: string;
  capabilities: string[];
  statsKey?: string;
  indexName?: string;
  startedAt?: string;
  hostname?: string;
  /** True when a fresh heartbeat key exists. */
  alive: boolean;
  /** ISO timestamp from the heartbeat key, if present. */
  lastHeartbeat?: string;
}

// ---- Phase 1 storage: ai_cache_samples time series ----

/** One polled sample of an AI instance's Valkey-side stats. */
export interface StoredAiCacheSample {
  id: string;
  connectionId: string;
  /** Registry field (unique per instance within a connection). */
  instanceField: string;
  instanceName: string;
  kind: AiInstanceKind;
  timestamp: number;
  /** Cumulative counters (from the stats hash) at sample time. */
  hits: number;
  misses: number;
  /** Per-tick derived rate (hits+misses since last sample) — null on first sample. */
  hitRate: number | null;
  costSavedMicros: number;
  evictions: number;
  /** Item / doc count from FT.INFO (memory + retrieval), else null. */
  items: number | null;
  /** Index memory size in bytes from FT.INFO, else null. */
  indexBytes: number | null;
  /** Current recall/similarity threshold from the config hash, else null. */
  threshold: number | null;
  /** Kind-specific extras (per-tool breakdown, similarity summary) as JSON. */
  extra: string | null;
}

export interface AiCacheHistoryQueryOptions {
  connectionId?: string;
  instanceField?: string;
  kind?: AiInstanceKind;
  startTime?: number;
  endTime?: number;
  limit?: number;
}
