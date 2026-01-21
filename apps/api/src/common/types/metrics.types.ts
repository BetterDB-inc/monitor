export interface ServerInfo {
  valkey_version?: string;
  redis_version?: string;
  valkey_git_sha1?: string;
  redis_git_sha1?: string;
  valkey_git_dirty?: string;
  redis_git_dirty?: string;
  valkey_build_id?: string;
  redis_build_id?: string;
  valkey_mode?: string;
  redis_mode?: string;
  os: string;
  arch_bits: string;
  multiplexing_api: string;
  atomicvar_api: string;
  gcc_version?: string;
  process_id: string;
  process_supervised: string;
  run_id: string;
  tcp_port: string;
  server_time_usec: string;
  uptime_in_seconds: string;
  uptime_in_days: string;
  hz: string;
  configured_hz: string;
  lru_clock: string;
  executable?: string;
  config_file?: string;
  io_threads_active: string;
  shutdown_in_milliseconds?: string;
}

export interface ClientsInfo {
  connected_clients: string;
  cluster_connections?: string;
  maxclients: string;
  client_recent_max_input_buffer: string;
  client_recent_max_output_buffer: string;
  blocked_clients: string;
  tracking_clients?: string;
  clients_in_timeout_table?: string;
  total_blocking_keys?: string;
  total_blocking_keys_on_nokey?: string;
}

export interface MemoryInfo {
  used_memory: string;
  used_memory_human: string;
  used_memory_rss: string;
  used_memory_rss_human: string;
  used_memory_peak: string;
  used_memory_peak_human: string;
  used_memory_peak_perc: string;
  used_memory_overhead: string;
  used_memory_startup: string;
  used_memory_dataset: string;
  used_memory_dataset_perc: string;
  allocator_allocated: string;
  allocator_active: string;
  allocator_resident: string;
  total_system_memory: string;
  total_system_memory_human: string;
  used_memory_lua?: string;
  used_memory_vm_eval?: string;
  used_memory_lua_human?: string;
  used_memory_scripts_eval?: string;
  number_of_cached_scripts?: string;
  number_of_functions?: string;
  number_of_libraries?: string;
  used_memory_vm_functions?: string;
  used_memory_vm_total?: string;
  used_memory_vm_total_human?: string;
  used_memory_functions?: string;
  used_memory_scripts?: string;
  used_memory_scripts_human?: string;
  maxmemory: string;
  maxmemory_human: string;
  maxmemory_policy: string;
  allocator_frag_ratio: string;
  allocator_frag_bytes: string;
  allocator_rss_ratio: string;
  allocator_rss_bytes: string;
  rss_overhead_ratio: string;
  rss_overhead_bytes: string;
  mem_fragmentation_ratio: string;
  mem_fragmentation_bytes: string;
  mem_not_counted_for_evict: string;
  mem_replication_backlog: string;
  mem_total_replication_buffers?: string;
  mem_clients_slaves: string;
  mem_clients_normal: string;
  mem_cluster_links?: string;
  mem_aof_buffer: string;
  mem_allocator: string;
  active_defrag_running: string;
  lazyfree_pending_objects: string;
  lazyfreed_objects?: string;
}

export interface PersistenceInfo {
  loading: string;
  async_loading?: string;
  current_cow_peak?: string;
  current_cow_size?: string;
  current_cow_size_age?: string;
  current_fork_perc?: string;
  current_save_keys_processed?: string;
  current_save_keys_total?: string;
  rdb_changes_since_last_save: string;
  rdb_bgsave_in_progress: string;
  rdb_last_save_time: string;
  rdb_last_bgsave_status: string;
  rdb_last_bgsave_time_sec: string;
  rdb_current_bgsave_time_sec: string;
  rdb_saves?: string;
  rdb_last_cow_size: string;
  rdb_last_load_keys_expired?: string;
  rdb_last_load_keys_loaded?: string;
  aof_enabled: string;
  aof_rewrite_in_progress: string;
  aof_rewrite_scheduled: string;
  aof_last_rewrite_time_sec: string;
  aof_current_rewrite_time_sec: string;
  aof_last_bgrewrite_status: string;
  aof_rewrites?: string;
  aof_rewrites_consecutive_failures?: string;
  aof_last_write_status: string;
  aof_last_cow_size: string;
  module_fork_in_progress: string;
  module_fork_last_cow_size: string;
  aof_current_size?: string;
  aof_base_size?: string;
  aof_pending_rewrite?: string;
  aof_buffer_length?: string;
  aof_pending_bio_fsync?: string;
  aof_delayed_fsync?: string;
}

export interface StatsInfo {
  total_connections_received: string;
  total_commands_processed: string;
  instantaneous_ops_per_sec: string;
  total_net_input_bytes: string;
  total_net_output_bytes: string;
  total_net_repl_input_bytes?: string;
  total_net_repl_output_bytes?: string;
  instantaneous_input_kbps: string;
  instantaneous_output_kbps: string;
  instantaneous_input_repl_kbps?: string;
  instantaneous_output_repl_kbps?: string;
  rejected_connections: string;
  sync_full: string;
  sync_partial_ok: string;
  sync_partial_err: string;
  expired_keys: string;
  expired_stale_perc: string;
  expired_time_cap_reached_count: string;
  expire_cycle_cpu_milliseconds: string;
  evicted_keys: string;
  evicted_clients?: string;
  total_eviction_exceeded_time?: string;
  current_eviction_exceeded_time?: string;
  keyspace_hits: string;
  keyspace_misses: string;
  pubsub_channels: string;
  pubsub_patterns: string;
  pubsubshard_channels?: string;
  latest_fork_usec: string;
  total_forks?: string;
  migrate_cached_sockets: string;
  slave_expires_tracked_keys: string;
  active_defrag_hits: string;
  active_defrag_misses: string;
  active_defrag_key_hits: string;
  active_defrag_key_misses: string;
  total_active_defrag_time?: string;
  current_active_defrag_time?: string;
  tracking_total_keys?: string;
  tracking_total_items?: string;
  tracking_total_prefixes?: string;
  unexpected_error_replies?: string;
  total_error_replies?: string;
  dump_payload_sanitizations?: string;
  total_reads_processed: string;
  total_writes_processed: string;
  io_threaded_reads_processed?: string;
  io_threaded_writes_processed?: string;
  reply_buffer_shrinks?: string;
  reply_buffer_expands?: string;
  eventloop_cycles?: string;
  eventloop_duration_sum?: string;
  eventloop_duration_cmd_sum?: string;
  instantaneous_eventloop_cycles_per_sec?: string;
  instantaneous_eventloop_duration_usec?: string;
  acl_access_denied_auth?: string;
  acl_access_denied_cmd?: string;
  acl_access_denied_key?: string;
  acl_access_denied_channel?: string;
}

export interface ReplicationInfo {
  role: string;
  connected_slaves?: string;
  master_failover_state?: string;
  master_replid?: string;
  master_replid2?: string;
  master_repl_offset?: string;
  second_repl_offset?: string;
  repl_backlog_active?: string;
  repl_backlog_size?: string;
  repl_backlog_first_byte_offset?: string;
  repl_backlog_histlen?: string;
  master_host?: string;
  master_port?: string;
  master_link_status?: string;
  master_last_io_seconds_ago?: string;
  master_sync_in_progress?: string;
  slave_read_repl_offset?: string;
  slave_repl_offset?: string;
  slave_priority?: string;
  slave_read_only?: string;
  replica_announced?: string;
  master_sync_total_bytes?: string;
  master_sync_read_bytes?: string;
  master_sync_left_bytes?: string;
  master_sync_last_io_seconds_ago?: string;
  master_link_down_since_seconds?: string;
}

export interface CpuInfo {
  used_cpu_sys: string;
  used_cpu_user: string;
  used_cpu_sys_children: string;
  used_cpu_user_children: string;
  used_cpu_sys_main_thread?: string;
  used_cpu_user_main_thread?: string;
}

export interface ModulesInfo {
  [key: string]: unknown;
}

export interface KeyspaceInfo {
  [dbKey: string]: {
    keys: number;
    expires: number;
    avg_ttl: number;
  };
}

export interface ClusterInfo {
  cluster_enabled?: string;
  [key: string]: unknown;
}

export interface CommandStatsInfo {
  [commandKey: string]: {
    calls: number;
    usec: number;
    usec_per_call: number;
    rejected_calls?: number;
    failed_calls?: number;
  };
}

export interface ErrorStatsInfo {
  [errorKey: string]: {
    count: number;
  };
}

export interface LatencyStatsInfo {
  [key: string]: unknown;
}

export interface InfoResponse {
  server?: ServerInfo;
  clients?: ClientsInfo;
  memory?: MemoryInfo;
  persistence?: PersistenceInfo;
  stats?: StatsInfo;
  replication?: ReplicationInfo;
  cpu?: CpuInfo;
  modules?: ModulesInfo;
  keyspace?: KeyspaceInfo;
  cluster?: ClusterInfo;
  commandstats?: CommandStatsInfo;
  errorstats?: ErrorStatsInfo;
  latencystats?: LatencyStatsInfo;
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
  startupAllocated: number;
  replicationBacklog: number;
  clientsNormal: number;
  clientsReplicas: number;
  aofBuffer: number;
  dbDict: number;
  dbExpires: number;
  [key: string]: unknown;
}

export interface ClientInfo {
  id: string;
  addr: string;
  name: string;
  age: number;
  idle: number;
  flags: string;
  db: number;
  sub: number;
  psub: number;
  multi: number;
  qbuf: number;
  qbufFree: number;
  obl: number;
  oll: number;
  omem: number;
  events: string;
  cmd: string;
  user: string;
  [key: string]: unknown;
}

export interface ClientFilters {
  type?: 'normal' | 'master' | 'replica' | 'pubsub';
  id?: string[];
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

export interface ReplicaInfo {
  ip: string;
  port: number;
  state: string;
  offset: number;
  lag: number;
}

export interface RoleInfo {
  role: 'master' | 'slave' | 'sentinel';
  replicationOffset?: number;
  replicas?: ReplicaInfo[];
  masterHost?: string;
  masterPort?: number;
  masterLinkStatus?: string;
  masterReplicationOffset?: number;
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
  migratingSlots?: Array<{ slot: number; targetNodeId: string }>;
  importingSlots?: Array<{ slot: number; sourceNodeId: string }>;
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

export interface ConfigGetResponse {
  [key: string]: string;
}

export type {
  SlowLogPatternExample,
  SlowLogPatternStats,
  CommandBreakdown,
  KeyPrefixBreakdown,
  ClientBreakdown,
  SlowLogPatternAnalysis,
} from '@betterdb/shared';
