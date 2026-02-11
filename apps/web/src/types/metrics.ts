export interface DatabaseCapabilities {
  dbType: 'valkey' | 'redis';
  version: string;
  hasCommandLog: boolean;
  hasSlotStats: boolean;
  hasClusterSlotStats: boolean;
  hasLatencyMonitor: boolean;
  hasAclLog: boolean;
  hasMemoryDoctor: boolean;
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
  };
  replication?: {
    role: string;
    connected_slaves?: string;
  };
  cluster?: {
    cluster_enabled?: string;
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

export interface MemoryStats {
  peakAllocated: number;
  totalAllocated: number;
  datasetBytes: number;
  datasetPercentage: number;
  peakPercentage: number;
  fragmentation: number;
  fragmentationBytes: number;
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
