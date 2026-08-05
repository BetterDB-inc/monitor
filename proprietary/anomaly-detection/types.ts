export enum MetricType {
  CONNECTIONS = 'connections',
  OPS_PER_SEC = 'ops_per_sec',
  MEMORY_USED = 'memory_used',
  INPUT_KBPS = 'input_kbps',
  OUTPUT_KBPS = 'output_kbps',
  SLOWLOG_LAST_ID = 'slowlog_last_id',
  ACL_DENIED = 'acl_denied',
  /** New connections refused because maxclients was hit — per-poll delta of INFO stats rejected_connections. */
  REJECTED_CONNECTIONS = 'rejected_connections',
  /** connected_clients / maxclients saturation — state-based, emitted directly (not z-score buffered). */
  CLIENT_SATURATION = 'client_saturation',
  /** Clients disconnected by maxmemory-clients eviction — per-poll delta of INFO stats evicted_clients (valkey#4151). */
  EVICTED_CLIENTS = 'evicted_clients',
  /** Raft cluster (Cluster V2) health: leaderless/quorum-loss and election churn — state-based. */
  RAFT_HEALTH = 'raft_health',
  /** Gossip-mode failover churn: one shard re-electing repeatedly (valkey#3996) — state-based. */
  FAILOVER_CHURN = 'failover_churn',
  /** Replica output buffer approaching client-output-buffer-limit slave (valkey#3963) — state-based. */
  REPL_BUFFER_PRESSURE = 'repl_buffer_pressure',
  /** Non-dataset memory overhead consuming the maxmemory budget / driving eviction (valkey#1792) — state-based. */
  MEMORY_OVERHEAD = 'memory_overhead',
  /** Event-loop busy-fraction saturation — the real-work busyness raw CPU% hides (valkey#2055) — state-based. */
  LOAD_SATURATION = 'load_saturation',
  /** Fork-based-save (BGSAVE/AOF) copy-on-write RSS blow-up / OOM risk (valkey#3609) — state-based. */
  FORK_MEMORY_RISK = 'fork_memory_risk',
  EVICTED_KEYS = 'evicted_keys',
  BLOCKED_CLIENTS = 'blocked_clients',
  KEYSPACE_MISSES = 'keyspace_misses',
  FRAGMENTATION_RATIO = 'fragmentation_ratio',
  CPU_UTILIZATION = 'cpu_utilization',
  REPLICATION_ROLE = 'replication_role',
  CLUSTER_STATE = 'cluster_state',
  /** Replica wrongly reporting slot migrating/importing/owned state (valkey#1664) — state-based. */
  REPLICA_SLOT_STATE = 'replica_slot_state',
  DATASET_KEYS = 'dataset_keys',
  /** Per-command P99 latency regression (INFO latencystats) — handled by LatencyRegressionService, not z-score buffers */
  COMMAND_P99 = 'command_p99',
  PERSISTENCE_CHILD = 'persistence_child',
  CLUSTER_TOPOLOGY = 'cluster_topology',
  /** Hot command(s) repeatedly crossing commandlog-reply-larger-than, taxing throughput via the large-reply commandlog path (valkey#2926) — state-based, per-command dedupe. */
  LARGE_REPLY_PRESSURE = 'large_reply_pressure',
  /** @deprecated Use SLOWLOG_LAST_ID instead — retained only for backwards compatibility */
  SLOWLOG_COUNT = 'slowlog_count',
}

/**
 * Metric types handled OUTSIDE the normal z-score extractor/buffer loop: they are
 * state-based (emitted directly on a state transition), delta/lazily fed, or
 * deprecated — so no baseline buffer/detector is created for them. This single
 * source of truth is referenced by both the buffer-init guard in AnomalyService
 * and its test, so the two can never drift out of lockstep.
 */
export const METRICS_HANDLED_OUTSIDE_EXTRACTOR: ReadonlySet<MetricType> = new Set([
  MetricType.REPLICATION_ROLE,
  MetricType.CLUSTER_STATE,
  MetricType.REPLICA_SLOT_STATE,
  MetricType.DATASET_KEYS,
  MetricType.COMMAND_P99,
  MetricType.PERSISTENCE_CHILD,
  MetricType.CLUSTER_TOPOLOGY,
  MetricType.SLOWLOG_LAST_ID,
  MetricType.REJECTED_CONNECTIONS,
  MetricType.CLIENT_SATURATION,
  MetricType.EVICTED_CLIENTS,
  MetricType.RAFT_HEALTH,
  MetricType.FAILOVER_CHURN,
  MetricType.REPL_BUFFER_PRESSURE,
  MetricType.MEMORY_OVERHEAD,
  MetricType.LOAD_SATURATION,
  MetricType.FORK_MEMORY_RISK,
  MetricType.SLOWLOG_COUNT,
  MetricType.LARGE_REPLY_PRESSURE,
]);

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
  CONTROL_PLANE_SATURATION = 'control_plane_saturation',
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
  /**
   * Set only by synthetic-event constructors (e.g.
   * createControlPlaneSaturationEvent) to mark an event that represents a
   * correlated pattern rather than a raw metric observation. In-memory only
   * (recentAnomalies / correlator) — not persisted, and never inferred from
   * the numeric fields.
   */
  syntheticPattern?: AnomalyPattern;
  /**
   * Transient (not persisted): whether this cached event was durably written to
   * storage. Deterministic string-id events (failover/promotion/cluster/
   * persistence/dup-primary) can't be stored on Postgres (UUID PK), so they stay
   * memory-only and are resolved by flipping the cache — a storage-backed poll
   * can never resurface a row that was never written.
   */
  persisted?: boolean;
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
