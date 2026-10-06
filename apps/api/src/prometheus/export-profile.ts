export type ExportProfile = 'vitals' | 'full';

export const DEFAULT_SLOT_STATS_TOP_N = 100;
export const MAX_SLOT_STATS_TOP_N = 16384;

export const VITALS_METRICS: ReadonlySet<string> = new Set([
  'betterdb_uptime_in_seconds',
  'betterdb_instance_info',
  'betterdb_connected_clients',
  'betterdb_blocked_clients',
  'betterdb_tracking_clients',
  'betterdb_memory_used_bytes',
  'betterdb_memory_used_rss_bytes',
  'betterdb_memory_used_peak_bytes',
  'betterdb_memory_max_bytes',
  'betterdb_memory_fragmentation_ratio',
  'betterdb_memory_fragmentation_bytes',
  'betterdb_connections_received_total',
  'betterdb_commands_processed_total',
  'betterdb_instantaneous_ops_per_sec',
  'betterdb_instantaneous_input_kbps',
  'betterdb_instantaneous_output_kbps',
  'betterdb_keyspace_hits_total',
  'betterdb_keyspace_misses_total',
  'betterdb_evicted_keys_total',
  'betterdb_expired_keys_total',
  'betterdb_cpu_sys_seconds_total',
  'betterdb_cpu_user_seconds_total',
  'betterdb_keyspace_keys',
  'betterdb_keyspace_keys_expiring',
  'betterdb_rdb_changes_since_last_save',
  'betterdb_rdb_last_save_timestamp_seconds',
  'betterdb_rdb_last_bgsave_ok',
  'betterdb_aof_enabled',
  'betterdb_aof_last_bgrewrite_ok',
  'betterdb_connected_slaves',
  'betterdb_replication_offset',
  'betterdb_master_link_up',
  'betterdb_master_last_io_seconds_ago',
  'betterdb_cluster_enabled',
  'betterdb_cluster_known_nodes',
  'betterdb_cluster_size',
  'betterdb_cluster_slots_assigned',
  'betterdb_cluster_slots_ok',
  'betterdb_cluster_slots_fail',
  'betterdb_cluster_slots_pfail',
  'betterdb_poll_stale',
]);

export function parseExportProfile(value: unknown): ExportProfile {
  if (typeof value === 'string' && value.trim().toLowerCase() === 'vitals') {
    return 'vitals';
  }
  return 'full';
}

export function resolveSlotStatsTopN(value: unknown, profile: ExportProfile): number {
  if (profile === 'vitals') {
    return 0;
  }
  if (value === undefined || value === null || String(value).trim() === '') {
    return DEFAULT_SLOT_STATS_TOP_N;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_SLOT_STATS_TOP_N;
  }
  return Math.min(MAX_SLOT_STATS_TOP_N, Math.max(0, Math.floor(parsed)));
}

export function isExportedInProfile(name: string, profile: ExportProfile): boolean {
  return profile === 'full' || VITALS_METRICS.has(name);
}
