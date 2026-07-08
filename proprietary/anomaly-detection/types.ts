export enum MetricType {
  CONNECTIONS = 'connections',
  OPS_PER_SEC = 'ops_per_sec',
  MEMORY_USED = 'memory_used',
  INPUT_KBPS = 'input_kbps',
  OUTPUT_KBPS = 'output_kbps',
  SLOWLOG_LAST_ID = 'slowlog_last_id',
  ACL_DENIED = 'acl_denied',
  EVICTED_KEYS = 'evicted_keys',
  BLOCKED_CLIENTS = 'blocked_clients',
  KEYSPACE_MISSES = 'keyspace_misses',
  FRAGMENTATION_RATIO = 'fragmentation_ratio',
  CPU_UTILIZATION = 'cpu_utilization',
  REPLICATION_ROLE = 'replication_role',
  CLUSTER_STATE = 'cluster_state',
  DATASET_KEYS = 'dataset_keys',
  /** Per-command P99 latency regression (INFO latencystats) — handled by LatencyRegressionService, not z-score buffers */
  COMMAND_P99 = 'command_p99',
  PERSISTENCE_CHILD = 'persistence_child',
  CLUSTER_TOPOLOGY = 'cluster_topology',
  /** @deprecated Use SLOWLOG_LAST_ID instead — retained only for backwards compatibility */
  SLOWLOG_COUNT = 'slowlog_count',
}

export enum AnomalySeverity {
  INFO = 'info',
  WARNING = 'warning',
  CRITICAL = 'critical',
}

export enum AnomalyType {
  SPIKE = 'spike',
  DROP = 'drop',
}

export enum AnomalyPattern {
  TRAFFIC_BURST = 'traffic_burst',
  BATCH_JOB = 'batch_job',
  MEMORY_PRESSURE = 'memory_pressure',
  SLOW_QUERIES = 'slow_queries',
  AUTH_ATTACK = 'auth_attack',
  CONNECTION_LEAK = 'connection_leak',
  CACHE_THRASHING = 'cache_thrashing',
  NODE_FAILOVER = 'node_failover',
  PERSISTENCE_STALL = 'persistence_stall',
  SPLIT_BRAIN = 'split_brain',
  UNKNOWN = 'unknown',
}

export interface AnomalyEvent {
  id: string;
  timestamp: number;
  metricType: MetricType;
  anomalyType: AnomalyType;
  severity: AnomalySeverity;
  value: number;
  baseline: number;
  stdDev: number;
  zScore: number;
  threshold: number;
  message: string;
  correlationId?: string;
  relatedMetrics?: MetricType[];
  resolved: boolean;
  connectionId?: string;
}

export interface CorrelatedAnomalyGroup {
  correlationId: string;
  timestamp: number;
  anomalies: AnomalyEvent[];
  pattern: AnomalyPattern;
  diagnosis: string;
  recommendations: string[];
  severity: AnomalySeverity;
}

export interface MetricSample {
  timestamp: number;
  value: number;
}

export interface BufferStats {
  metricType: MetricType;
  connectionId?: string;
  sampleCount: number;
  mean: number;
  stdDev: number;
  min: number;
  max: number;
  latest: number;
  isReady: boolean;
}

export interface SpikeDetectorConfig {
  warningZScore?: number;
  criticalZScore?: number;
  warningThreshold?: number;
  criticalThreshold?: number;
  consecutiveRequired?: number;
  cooldownMs?: number;
  detectDrops?: boolean;
}

export interface AnomalySummary {
  totalEvents: number;
  totalGroups: number;
  bySeverity: Record<AnomalySeverity, number>;
  byMetric: Record<MetricType, number>;
  byPattern: Record<AnomalyPattern, number>;
  activeEvents: number;
  resolvedEvents: number;
}
