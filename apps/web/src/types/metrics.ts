export interface DatabaseCapabilities {
  dbType: 'valkey' | 'redis';
  version: string;
  hasCommandLog: boolean;
  hasSlotStats: boolean;
  hasClusterSlotStats: boolean;
  hasLatencyMonitor: boolean;
  hasAclLog: boolean;
  hasMemoryDoctor: boolean;
  hasConfig: boolean;
  hasVectorSearch: boolean;
}

export interface RuntimeCapabilities {
  canSlowLog: boolean;
  canClientList: boolean;
  canAclLog: boolean;
  canClusterInfo: boolean;
  canClusterSlotStats: boolean;
  canCommandLog: boolean;
  canLatency: boolean;
  canMemory: boolean;
}

export interface HealthResponse {
  status: 'connected' | 'disconnected' | 'error' | 'waiting';
  database: {
    type: 'valkey' | 'redis' | 'unknown';
    version: string | null;
    host: string;
    port: number;
  };
  capabilities: DatabaseCapabilities | null;
  runtimeCapabilities?: RuntimeCapabilities | null;
  error?: string;
  message?: string;
}

export interface InfoResponse {
  server?: {
    valkey_version?: string;
    redis_version?: string;
    uptime_in_seconds: string;
    uptime_in_days: string;
    process_id: string;
    tcp_port: string;
    os: string;
    io_threads_active?: string;
  };
  clients?: {
    connected_clients: string;
    blocked_clients: string;
    tracking_clients?: string;
  };
  memory?: {
    used_memory: string;
    used_memory_human: string;
    used_memory_peak: string;
    used_memory_peak_human: string;
    used_memory_rss: string;
    mem_fragmentation_ratio: string;
    maxmemory: string;
    maxmemory_human: string;
  };
  stats?: {
    total_connections_received: string;
    total_commands_processed: string;
    instantaneous_ops_per_sec: string;
    instantaneous_input_kbps: string;
    instantaneous_output_kbps: string;
    keyspace_hits: string;
    keyspace_misses: string;
    evicted_keys: string;
    expired_keys: string;
    io_threaded_reads_processed?: string;
    io_threaded_writes_processed?: string;
    total_reads_processed?: string;
    total_writes_processed?: string;
  };
  replication?: {
    role: string;
    connected_slaves?: string;
  };
  cluster?: {
    cluster_enabled?: string;
  };
  cpu?: {
    used_cpu_sys: string;
    used_cpu_user: string;
  };
  keyspace?: Record<string, string>;
}

export interface SlowLogEntry {
  id: number;
  timestamp: number;
  duration: number;
  command: string[];
  clientAddress: string;
  clientName: string;
}

export type CommandLogType = 'slow' | 'large-request' | 'large-reply';

export interface CommandLogEntry {
  id: number;
  timestamp: number;
  duration: number;
  command: string[];
  clientAddress: string;
  clientName: string;
  type: CommandLogType;
}

export interface LatencyEvent {
  eventName: string;
  latency: number;
  timestamp: number;
}

export interface LatencyHistoryEntry {
  timestamp: number;
  latency: number;
}

export interface LatencyHistogram {
  calls: number;
  histogram: { [bucket: string]: number };
}

export interface StoredLatencyHistogram {
  id: string;
  timestamp: number;
  data: Record<string, LatencyHistogram>;
  connectionId?: string;
}

export interface MemoryStats {
  peakAllocated: number;
  totalAllocated: number;
  datasetBytes: number;
  datasetPercentage: number;
  peakPercentage: number;
  fragmentation: number;
  fragmentationBytes: number;
}

export interface StoredLatencySnapshot {
  id: string;
  timestamp: number;
  eventName: string;
  latestEventTimestamp: number;
  maxLatency: number;
  connectionId?: string;
}

export interface StoredMemorySnapshot {
  id: string;
  timestamp: number;
  usedMemory: number;
  usedMemoryRss: number;
  usedMemoryPeak: number;
  memFragmentationRatio: number;
  maxmemory: number;
  allocatorFragRatio: number;
  opsPerSec: number;
  cpuSys: number;
  cpuUser: number;
  ioThreadedReads: number;
  ioThreadedWrites: number;
  connectionId?: string;
}

export interface ClientInfo {
  id: string;
  addr: string;
  name: string;
  age: number;
  idle: number;
  flags: string;
  db: number;
  cmd: string;
  user: string;
}

export interface AclLogEntry {
  count: number;
  reason: string;
  context: string;
  object: string;
  username: string;
  ageSeconds: number;
  clientInfo: string;
  timestampCreated: number;
  timestampLastUpdated: number;
}

export interface ClusterNode {
  id: string;
  address: string;
  flags: string[];
  master: string;
  pingSent: number;
  pongReceived: number;
  configEpoch: number;
  linkState: string;
  slots: number[][];
}

export interface SlotStatsMetric {
  key_count: number;
  expires_count: number;
  total_reads: number;
  total_writes: number;
}

export interface SlotStats {
  [slot: string]: SlotStatsMetric;
}

export interface VectorIndexField {
  name: string;
  type: string;
  algorithm: string | null;
  dimension: number | null;
  distanceMetric: string | null;
  hnswM: number | null;
  hnswEfConstruction: number | null;
  hnswEfRuntime: number | null;
  separator: string | null;
  caseSensitive: boolean;
  sortable: boolean;
  noStem: boolean;
  weight: number | null;
}

export interface VectorSearchResult {
  key: string;
  score: number;
  fields: Record<string, string>;
}

export interface VectorIndexGcStats {
  gcCycles: number;
  bytesCollected: number;
  totalMsRun: number;
}

export interface VectorIndexDefinition {
  prefixes: string[];
  defaultLanguage: string | null;
  defaultScore: number | null;
}

export interface VectorIndexInfo {
  name: string;
  numDocs: number;
  numRecords: number;
  numVectorFields: number;
  indexingState: string;
  percentIndexed: number;
  memorySizeMb: number;
  indexingFailures: number;
  fields: VectorIndexField[];
  gcStats: VectorIndexGcStats | null;
  indexDefinition: VectorIndexDefinition | null;
}

export interface VectorIndexSnapshot {
  id: string;
  timestamp: number;
  connectionId: string;
  indexName: string;
  numDocs: number;
  memorySizeMb: number;
}

export type {
  StoredAclEntry,
  AuditStats,
  SlowLogPatternExample,
  SlowLogPatternStats,
  CommandBreakdown,
  KeyPrefixBreakdown,
  SlowLogPatternAnalysis,
  StoredClientSnapshot,
  ClientTimeSeriesPoint,
  ClientAnalyticsStats,
  CommandDistributionParams,
  CommandDistributionResponse,
  IdleConnectionsParams,
  IdleConnectionsResponse,
  BufferAnomaliesParams,
  BufferAnomaliesResponse,
  ActivityTimelineParams,
  ActivityTimelineResponse,
  SpikeDetectionParams,
  SpikeDetectionResponse,
} from '@betterdb/shared';
