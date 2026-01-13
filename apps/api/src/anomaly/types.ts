export enum MetricType {
  CONNECTIONS = 'connections',
  OPS_PER_SEC = 'ops_per_sec',
  MEMORY_USED = 'memory_used',
  INPUT_KBPS = 'input_kbps',
  OUTPUT_KBPS = 'output_kbps',
  SLOWLOG_COUNT = 'slowlog_count',
  ACL_DENIED = 'acl_denied',
  EVICTED_KEYS = 'evicted_keys',
  BLOCKED_CLIENTS = 'blocked_clients',
  KEYSPACE_MISSES = 'keyspace_misses',
  FRAGMENTATION_RATIO = 'fragmentation_ratio',
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
