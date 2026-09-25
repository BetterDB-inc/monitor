import { collectDataPoints, deriveUnit, type PromMetricJson } from './prom-otel-bridge';

export type SemconvKind = 'gauge' | 'counter' | 'updown';

export interface SemconvInstrumentSpec {
  name: string;
  kind: SemconvKind;
  description: string;
  unit: string;
}

export interface SemconvDataPoint {
  instrument: string;
  value: number;
  attributes: Record<string, string | number>;
}

export interface SemconvCollection {
  points: SemconvDataPoint[];
  skipped: number;
}

type Attributes = Record<string, string | number>;

type Convert = (value: number, labels: Attributes) => { value: number; attributes: Attributes } | null;

export interface SemconvRule {
  name: string;
  kind: SemconvKind;
  unit: string;
  convert: Convert;
  description?: string;
}

const LABEL_RENAMES: Readonly<Record<string, string>> = { command: 'cmd' };

const ROLE_NAMES: Readonly<Record<string, string>> = {
  master: 'primary',
  primary: 'primary',
  slave: 'replica',
  replica: 'replica',
};

const PASS_THROUGH_PREFIXES = ['betterdb_process_', 'betterdb_nodejs_'];

const EXCLUDED_FAMILIES: ReadonlySet<string> = new Set([
  'betterdb_keyspace_keys',
  'betterdb_keyspace_keys_expiring',
  'betterdb_poll_duration_seconds',
]);

function renameLabels(labels: Attributes): Attributes {
  const renamed: Attributes = {};
  for (const [key, value] of Object.entries(labels)) {
    renamed[LABEL_RENAMES[key] ?? key] = value;
  }
  return renamed;
}

function omit(labels: Attributes, keys: string[]): Attributes {
  return Object.fromEntries(Object.entries(labels).filter(([key]) => !keys.includes(key)));
}

const keep: Convert = (value, labels) => ({ value, attributes: renameLabels(labels) });

function withAttributes(extra: Attributes): Convert {
  return (value, labels) => ({ value, attributes: { ...renameLabels(labels), ...extra } });
}

function perDb(scale: number): Convert {
  return (value, labels) => {
    const match = /^db(\d+)$/.exec(String(labels.db ?? ''));
    if (!match) {
      return null;
    }
    return { value: value * scale, attributes: { ...renameLabels(labels), db: match[1] } };
  };
}

const role: Convert = (_value, labels) => {
  const mapped = ROLE_NAMES[String(labels.role)];
  if (!mapped) {
    return null;
  }
  return { value: 1, attributes: { ...omit(labels, ['version', 'os']), role: mapped } };
};

function gauge(name: string, unit: string, convert: Convert = keep): SemconvRule {
  return { name, kind: 'gauge', unit, convert };
}

function counter(name: string, unit: string, convert: Convert = keep): SemconvRule {
  return { name, kind: 'counter', unit, convert };
}

function updown(name: string, unit: string, convert: Convert = keep): SemconvRule {
  return { name, kind: 'updown', unit, convert };
}

function described(description: string, rule: SemconvRule): SemconvRule {
  return { ...rule, description };
}

const CPU_TIME = 'CPU time consumed by the server, by state';

const INFERENCE_LATENCY = 'Inference bucket latency by percentile';

export const SEMCONV_RULES: Readonly<Record<string, SemconvRule>> = {
  betterdb_memory_used_bytes: gauge('valkey.memory.used', 'By'),
  betterdb_memory_used_rss_bytes: gauge('valkey.memory.rss', 'By'),
  betterdb_memory_used_peak_bytes: gauge('valkey.memory.peak', 'By'),
  betterdb_memory_max_bytes: gauge('valkey.maxmemory', 'By'),
  betterdb_memory_fragmentation_ratio: gauge('valkey.memory.fragmentation_ratio', '1'),
  betterdb_cpu_sys_seconds_total: described(
    CPU_TIME,
    counter('valkey.cpu.time', 's', withAttributes({ state: 'sys' })),
  ),
  betterdb_cpu_user_seconds_total: described(
    CPU_TIME,
    counter('valkey.cpu.time', 's', withAttributes({ state: 'user' })),
  ),
  betterdb_connected_clients: updown('valkey.clients.connected', '{client}'),
  betterdb_blocked_clients: updown('valkey.clients.blocked', '{client}'),
  betterdb_commands_processed_total: counter('valkey.commands.processed', '{command}'),
  betterdb_connections_received_total: counter('valkey.connections.received', '{connection}'),
  betterdb_instantaneous_ops_per_sec: gauge('valkey.commands', '{ops}/s'),
  betterdb_keyspace_hits_total: counter('valkey.keyspace.hits', '{hit}'),
  betterdb_keyspace_misses_total: counter('valkey.keyspace.misses', '{miss}'),
  betterdb_evicted_keys_total: counter('valkey.keys.evicted', '{key}'),
  betterdb_expired_keys_total: counter('valkey.keys.expired', '{event}'),
  betterdb_db_keys: gauge('valkey.db.keys', '{key}', perDb(1)),
  betterdb_db_keys_expiring: gauge('valkey.db.expires', '{key}', perDb(1)),
  betterdb_db_avg_ttl_seconds: gauge('valkey.db.avg_ttl', 'ms', perDb(1000)),
  betterdb_commandstats_calls_total: counter('valkey.cmd.calls', '{call}'),
  betterdb_connected_slaves: updown('valkey.slaves.connected', '{replica}'),
  betterdb_replication_offset: gauge('valkey.replication.offset', 'By'),
  betterdb_uptime_in_seconds: counter('valkey.uptime', 's'),
  betterdb_rdb_changes_since_last_save: updown('valkey.rdb.changes_since_last_save', '{change}'),
  betterdb_cluster_enabled: gauge('valkey.cluster.cluster_enabled', '1'),
  betterdb_cluster_known_nodes: gauge('valkey.cluster.known_nodes', '{node}'),
  betterdb_cluster_slots_assigned: gauge('valkey.cluster.slots_assigned', '{slot}'),
  betterdb_cluster_slots_ok: gauge('valkey.cluster.slots_ok', '{slot}'),
  betterdb_cluster_slots_fail: gauge('valkey.cluster.slots_fail', '{slot}'),
  betterdb_cluster_slots_pfail: gauge('valkey.cluster.slots_pfail', '{slot}'),
  betterdb_instance_info: described(
    'Replication role of the node (1 for the current role)',
    updown('valkey.role', '{role}', role),
  ),
  betterdb_memory_fragmentation_bytes: gauge('betterdb.memory.fragmentation', 'By'),
  betterdb_tracking_clients: gauge('betterdb.clients.tracking', '{client}'),
  betterdb_instantaneous_input_kbps: gauge('betterdb.net.input_rate', 'KiBy/s'),
  betterdb_instantaneous_output_kbps: gauge('betterdb.net.output_rate', 'KiBy/s'),
  betterdb_pubsub_channels: gauge('betterdb.pubsub.channels', '{channel}'),
  betterdb_pubsub_patterns: gauge('betterdb.pubsub.patterns', '{pattern}'),
  betterdb_repl_output_buffer_ratio: gauge('betterdb.replication.output_buffer_ratio', '1'),
  betterdb_master_link_up: gauge('betterdb.replication.master_link_up', '1'),
  betterdb_master_last_io_seconds_ago: gauge('betterdb.replication.master_last_io_age', 's'),
  betterdb_rdb_last_save_timestamp_seconds: gauge('betterdb.rdb.last_save_time', 's'),
  betterdb_rdb_last_bgsave_ok: gauge('betterdb.rdb.last_bgsave_ok', '1'),
  betterdb_aof_enabled: gauge('betterdb.aof.enabled', '1'),
  betterdb_aof_last_bgrewrite_ok: gauge('betterdb.aof.last_bgrewrite_ok', '1'),
  betterdb_cluster_size: gauge('betterdb.cluster.size', '{node}'),
  betterdb_cluster_stats_messages_crc_mismatch: gauge(
    'betterdb.cluster.messages_crc_mismatch',
    '{message}',
  ),
  betterdb_cluster_slot_keys: gauge('betterdb.cluster.slot.keys', '{key}'),
  betterdb_cluster_slot_expires: gauge('betterdb.cluster.slot.expires', '{key}'),
  betterdb_cluster_slot_reads_total: counter('betterdb.cluster.slot.reads', '{read}'),
  betterdb_cluster_slot_writes_total: counter('betterdb.cluster.slot.writes', '{write}'),
  betterdb_commandstats_latency_us: gauge('betterdb.cmd.latency_avg', 'us'),
  betterdb_slowlog_length: gauge('betterdb.slowlog.length', '{entry}'),
  betterdb_slowlog_last_id: gauge('betterdb.slowlog.last_id', '{id}'),
  betterdb_slowlog_pattern_count: gauge('betterdb.slowlog.pattern.count', '{entry}'),
  betterdb_slowlog_pattern_avg_duration_us: gauge('betterdb.slowlog.pattern.duration_avg', 'us'),
  betterdb_slowlog_pattern_percentage: gauge('betterdb.slowlog.pattern.share', '%'),
  betterdb_commandlog_large_request: gauge('betterdb.commandlog.large_request', '{entry}'),
  betterdb_commandlog_large_reply: gauge('betterdb.commandlog.large_reply', '{entry}'),
  betterdb_commandlog_large_request_by_pattern: gauge(
    'betterdb.commandlog.large_request_by_pattern',
    '{entry}',
  ),
  betterdb_commandlog_large_reply_by_pattern: gauge(
    'betterdb.commandlog.large_reply_by_pattern',
    '{entry}',
  ),
  betterdb_acl_denied: gauge('betterdb.acl.denied', '{event}'),
  betterdb_acl_denied_by_reason: gauge('betterdb.acl.denied_by_reason', '{event}'),
  betterdb_acl_denied_by_user: gauge('betterdb.acl.denied_by_user', '{event}'),
  betterdb_client_connections_current: gauge('betterdb.client.connections', '{connection}'),
  betterdb_client_connections_peak: gauge('betterdb.client.connections_peak', '{connection}'),
  betterdb_client_connections_by_name: gauge('betterdb.client.connections_by_name', '{connection}'),
  betterdb_client_connections_by_user: gauge('betterdb.client.connections_by_user', '{connection}'),
  betterdb_vector_index_docs: gauge('betterdb.vector_index.docs', '{document}'),
  betterdb_vector_index_memory_bytes: gauge('betterdb.vector_index.memory', 'By'),
  betterdb_vector_index_indexing_failures: gauge('betterdb.vector_index.indexing_failures', '{failure}'),
  betterdb_vector_index_percent_indexed: gauge('betterdb.vector_index.indexed', '%'),
  betterdb_inference_bucket_p50_us: described(
    INFERENCE_LATENCY,
    gauge('betterdb.inference.bucket.latency', 'us', withAttributes({ percentile: 'p50' })),
  ),
  betterdb_inference_bucket_p95_us: described(
    INFERENCE_LATENCY,
    gauge('betterdb.inference.bucket.latency', 'us', withAttributes({ percentile: 'p95' })),
  ),
  betterdb_inference_bucket_p99_us: described(
    INFERENCE_LATENCY,
    gauge('betterdb.inference.bucket.latency', 'us', withAttributes({ percentile: 'p99' })),
  ),
  betterdb_inference_unhealthy: gauge('betterdb.inference.bucket.unhealthy', '1'),
  betterdb_inference_sla_breach: gauge('betterdb.inference.sla_breach', '1'),
  betterdb_poll_stale: gauge('betterdb.poll.stale', '1'),
  betterdb_polls_total: counter('betterdb.poll.count', '{poll}'),
  betterdb_anomaly_events_total: counter('betterdb.anomaly.events', '{event}'),
  betterdb_anomaly_events_current: gauge('betterdb.anomaly.active', '{event}'),
  betterdb_anomaly_by_severity: gauge('betterdb.anomaly.by_severity', '{event}'),
  betterdb_anomaly_by_metric: gauge('betterdb.anomaly.by_metric', '{event}'),
  betterdb_correlated_groups_total: counter('betterdb.anomaly.correlated_groups', '{group}'),
  betterdb_correlated_groups_by_severity: gauge(
    'betterdb.anomaly.correlated_groups_by_severity',
    '{group}',
  ),
  betterdb_correlated_groups_by_pattern: gauge(
    'betterdb.anomaly.correlated_groups_by_pattern',
    '{group}',
  ),
  betterdb_anomaly_buffer_ready: gauge('betterdb.anomaly.buffer.ready', '1'),
  betterdb_anomaly_buffer_mean: gauge('betterdb.anomaly.buffer.mean', ''),
  betterdb_anomaly_buffer_stddev: gauge('betterdb.anomaly.buffer.stddev', ''),
  betterdb_metric_forecast_time_to_limit_seconds: gauge('betterdb.forecast.time_to_limit', 's'),
  betterdb_cve_findings: gauge('betterdb.cve.findings', '{finding}'),
  betterdb_cve_kev: gauge('betterdb.cve.kev', '{finding}'),
  betterdb_cve_dataset_stale: gauge('betterdb.cve.dataset_stale', '1'),
};

function isPassThrough(name: string): boolean {
  return PASS_THROUGH_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function resolveRule(metric: PromMetricJson): SemconvRule | null {
  if (metric.type !== 'gauge' && metric.type !== 'counter') {
    return null;
  }
  const rule = SEMCONV_RULES[metric.name];
  if (rule) {
    return rule;
  }
  if (!isPassThrough(metric.name)) {
    return null;
  }
  const unit = deriveUnit(metric.name);
  return metric.type === 'counter' ? counter(metric.name, unit) : gauge(metric.name, unit);
}

export function classifyFamily(name: string): 'mapped' | 'excluded' | 'passthrough' | 'unknown' {
  if (SEMCONV_RULES[name]) {
    return 'mapped';
  }
  if (EXCLUDED_FAMILIES.has(name)) {
    return 'excluded';
  }
  return isPassThrough(name) ? 'passthrough' : 'unknown';
}

export function planSemconvInstruments(snapshot: PromMetricJson[]): SemconvInstrumentSpec[] {
  const specs = new Map<string, SemconvInstrumentSpec>();
  for (const metric of snapshot) {
    const rule = resolveRule(metric);
    if (!rule || specs.has(rule.name)) {
      continue;
    }
    specs.set(rule.name, {
      name: rule.name,
      kind: rule.kind,
      unit: rule.unit,
      description: rule.description ?? metric.help ?? '',
    });
  }
  return [...specs.values()];
}

export function collectSemconvPoints(metric: PromMetricJson): SemconvCollection {
  const rule = resolveRule(metric);
  if (!rule) {
    return { points: [], skipped: 0 };
  }
  const points: SemconvDataPoint[] = [];
  let skipped = 0;
  for (const point of collectDataPoints(metric)) {
    const converted = rule.convert(point.value, point.attributes);
    if (!converted) {
      skipped += 1;
      continue;
    }
    points.push({ instrument: rule.name, ...converted });
  }
  return { points, skipped };
}
