import {
  AlertTriangle,
  AlertCircle,
  Info,
  TrendingUp,
  Activity,
  Clock,
  Zap,
  Database,
  Users,
  Shield,
  HardDrive,
  AlertOctagon,
  ArrowLeftRight,
  Flame,
} from 'lucide-react';
import type { RebalanceExecutionBlocker } from '../../types/anomaly';

export const shortShardId = (shardId: string) => shardId.substring(0, 8);

export const formatRatio = (value: number) => `${Number(value.toFixed(2))}x`;

export const slotRangeLabels = (ranges: ReadonlyArray<readonly [number, number]>) =>
  ranges.map(([start, end]) => (start === end ? `${start}` : `${start}-${end}`));

export const SEVERITY_CONFIG = {
  critical: {
    color: 'text-destructive',
    bg: 'bg-destructive/10',
    border: 'border-destructive',
    icon: AlertCircle,
  },
  warning: {
    color: 'text-yellow-500',
    bg: 'bg-yellow-500/10',
    border: 'border-yellow-500',
    icon: AlertTriangle,
  },
  info: { color: 'text-primary', bg: 'bg-primary/10', border: 'border-primary', icon: Info },
};

export const PATTERN_CONFIG: Record<
  string,
  { icon: typeof Activity; label: string; color: string }
> = {
  traffic_burst: { icon: TrendingUp, label: 'Traffic Burst', color: 'var(--chart-1)' },
  batch_job: { icon: Database, label: 'Batch Job', color: 'var(--chart-2)' },
  memory_pressure: { icon: HardDrive, label: 'Memory Pressure', color: 'var(--destructive)' },
  slow_queries: { icon: Clock, label: 'Slow Queries', color: 'var(--chart-warning)' },
  auth_attack: { icon: Shield, label: 'Auth Anomaly', color: 'var(--destructive)' },
  connection_leak: { icon: Users, label: 'Connection Leak', color: 'var(--chart-3)' },
  cache_thrashing: { icon: Zap, label: 'Cache Thrashing', color: 'var(--chart-warning)' },
  node_failover: { icon: AlertOctagon, label: 'Node Failover', color: 'var(--destructive)' },
  reshard_pressure: { icon: Database, label: 'Reshard Pressure', color: 'var(--chart-warning)' },
  recovery_amplification: {
    icon: Database,
    label: 'Recovery Amplification',
    color: 'var(--destructive)',
  },
  retry_amplification: {
    icon: AlertTriangle,
    label: 'Retry Amplification',
    color: 'var(--chart-warning)',
  },
  replication_divergence: {
    icon: Database,
    label: 'Replication Divergence',
    color: 'var(--destructive)',
  },
  persistence_stall: { icon: HardDrive, label: 'Persistence Stall', color: 'var(--chart-warning)' },
  split_brain: { icon: AlertOctagon, label: 'Split Brain', color: 'var(--destructive)' },
  control_plane_saturation: {
    icon: Activity,
    label: 'Control Plane Saturation',
    color: 'var(--chart-warning)',
  },
  divergence_under_pressure: {
    icon: Database,
    label: 'Divergence Under Pressure',
    color: 'var(--destructive)',
  },
  reshard_under_writes: {
    icon: Database,
    label: 'Reshard Under Writes',
    color: 'var(--chart-warning)',
  },
  reshard_divergence_pressure: {
    icon: Database,
    label: 'Reshard, Divergence and Memory Pressure',
    color: 'var(--destructive)',
  },
  retry_storm: { icon: AlertTriangle, label: 'Retry Storm', color: 'var(--destructive)' },
  backlog_exhaustion: { icon: Database, label: 'Backlog Exhaustion', color: 'var(--destructive)' },
  hot_shard_latency: { icon: Flame, label: 'Hot Shard Latency', color: 'var(--chart-warning)' },
  migration_redirects: {
    icon: ArrowLeftRight,
    label: 'Migration Redirects',
    color: 'var(--chart-warning)',
  },
  membership_failover: { icon: Users, label: 'Membership Failover', color: 'var(--destructive)' },
  unknown: { icon: Activity, label: 'Unknown', color: 'var(--muted-foreground)' },
};

export const METRIC_LABELS: Record<string, string> = {
  connections: 'Connections',
  ops_per_sec: 'Ops/sec',
  memory_used: 'Memory',
  input_kbps: 'Input KB/s',
  output_kbps: 'Output KB/s',
  slowlog_last_id: 'Slow Queries',
  acl_denied: 'ACL Denied',
  auth_failure_burst: 'Auth Failure Burst',
  evicted_keys: 'Evictions',
  blocked_clients: 'Blocked',
  keyspace_misses: 'Cache Misses',
  fragmentation_ratio: 'Fragmentation',
  replication_role: 'Replication Role',
  dataset_keys: 'Dataset Keys',
  command_p99: 'Command P99',
  rejected_connections: 'Rejected Connections',
  client_saturation: 'Client Saturation',
  client_lockout_risk: 'Admin Lockout Risk',
  evicted_clients: 'Client Evictions',
  raft_health: 'Raft Health',
  replica_slot_state: 'Replica Slot State',
  resync_loop: 'Replica Resync Loop',
  orphaned_slot_keys: 'Orphaned Slot Keys',
  failover_churn: 'Failover Churn',
  primary_without_replicas: 'Primary Without Replicas',
  repl_buffer_pressure: 'Replica Buffer Pressure',
  memory_overhead: 'Memory Overhead',
  load_saturation: 'Load Saturation',
  fork_memory_risk: 'Fork Memory Risk',
  config_drift: 'Config Drift',
  acl_drift: 'ACL Drift',
  sentinel_endpoint_drift: 'Sentinel Endpoint Drift',
  hostname_staleness: 'Hostname Staleness',
  large_reply_pressure: 'Large-Reply Pressure',
  ghost_membership: 'Ghost Membership',
  lagging_promotion: 'Lagging Promotion',
  cluster_state: 'Cluster State',
  cluster_topology: 'Cluster Topology',
  persistence_child: 'Persistence Child',
  cpu_utilization: 'CPU Utilization',
  slowlog_count: 'Slow Queries (legacy)',
  connection_churn: 'Connection Churn',
  reshard_shard_skew: 'Reshard Shard Skew',
  hot_shard: 'Hot Shard',
  slot_migration: 'Slot Migration',
  slot_migration_stuck: 'Slot Migration Stuck or Failed',
  topology_divergence: 'Topology Divergence',
  partial_membership: 'Partially Known Node',
  backlog_coverage_risk: 'Backlog Coverage Risk',
  resync_escalation: 'Resync Escalation',
  retry_amplification: 'Retry Amplification',
  error_replies: 'Error Replies',
  replication_divergence: 'Replication Divergence',
  sentinel_loop_stall: 'Sentinel Loop Stall',
};

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function patternLabel(pattern: string): string {
  return PATTERN_CONFIG[pattern]?.label ?? pattern;
}

export function metricLabel(metricType: string): string {
  return METRIC_LABELS[metricType] ?? metricType;
}

export const REBALANCE_BLOCKED: Record<RebalanceExecutionBlocker, string> = {
  flag_off:
    'Running a plan from BetterDB is off. An operator can turn it on with BETTERDB_SLOT_MIGRATION=true.',
  provider_managed: 'Slot commands are not supported on this managed service.',
  unsupported_server: 'Running a plan needs Valkey 9.0 or later on every shard of the plan.',
  not_dialed:
    'BetterDB does not connect to the cluster nodes directly, so it cannot run this plan.',
  migration_running: 'A slot migration is running. A plan can run once it ends.',
  plan_outdated:
    'The slots or the nodes changed since this suggestion was made. A new one follows.',
  server_refused:
    'The server refused the last start of this plan. It can run again once the suggestion is made again.',
  observe_mode:
    'This cluster is in Observe mode. Switch it to Recommend on the Cluster page to run plans.',
};
