import {
  SEMCONV_RULES,
  classifyFamily,
  collectSemconvPoints,
  planSemconvInstruments,
} from '../semconv-map';
import type { PromMetricJson } from '../prom-otel-bridge';
import { buildPrometheus } from './prometheus-harness';

const CONN = '10.0.0.1:6379';

function family(
  name: string,
  values: Array<{ value: number; labels?: Record<string, string | number> }>,
  type = 'gauge',
): PromMetricJson {
  return { name, help: `${name} help`, type, values };
}

function one(name: string, value: number, labels: Record<string, string | number> = {}, type = 'gauge') {
  return collectSemconvPoints(family(name, [{ value, labels: { connection: CONN, ...labels } }], type));
}

describe('planSemconvInstruments', () => {
  it.each([
    ['betterdb_memory_used_bytes', 'valkey.memory.used', 'gauge', 'By'],
    ['betterdb_memory_used_rss_bytes', 'valkey.memory.rss', 'gauge', 'By'],
    ['betterdb_memory_used_peak_bytes', 'valkey.memory.peak', 'gauge', 'By'],
    ['betterdb_memory_max_bytes', 'valkey.maxmemory', 'gauge', 'By'],
    ['betterdb_memory_fragmentation_ratio', 'valkey.memory.fragmentation_ratio', 'gauge', '1'],
    ['betterdb_cpu_sys_seconds_total', 'valkey.cpu.time', 'counter', 's'],
    ['betterdb_connected_clients', 'valkey.clients.connected', 'updown', '{client}'],
    ['betterdb_blocked_clients', 'valkey.clients.blocked', 'updown', '{client}'],
    ['betterdb_commands_processed_total', 'valkey.commands.processed', 'counter', '{command}'],
    ['betterdb_connections_received_total', 'valkey.connections.received', 'counter', '{connection}'],
    ['betterdb_instantaneous_ops_per_sec', 'valkey.commands', 'gauge', '{ops}/s'],
    ['betterdb_keyspace_hits_total', 'valkey.keyspace.hits', 'counter', '{hit}'],
    ['betterdb_keyspace_misses_total', 'valkey.keyspace.misses', 'counter', '{miss}'],
    ['betterdb_evicted_keys_total', 'valkey.keys.evicted', 'counter', '{key}'],
    ['betterdb_expired_keys_total', 'valkey.keys.expired', 'counter', '{event}'],
    ['betterdb_db_keys', 'valkey.db.keys', 'gauge', '{key}'],
    ['betterdb_db_keys_expiring', 'valkey.db.expires', 'gauge', '{key}'],
    ['betterdb_db_avg_ttl_seconds', 'valkey.db.avg_ttl', 'gauge', 'ms'],
    ['betterdb_commandstats_calls_total', 'valkey.cmd.calls', 'counter', '{call}'],
    ['betterdb_connected_slaves', 'valkey.slaves.connected', 'updown', '{replica}'],
    ['betterdb_replication_offset', 'valkey.replication.offset', 'gauge', 'By'],
    ['betterdb_uptime_in_seconds', 'valkey.uptime', 'counter', 's'],
    ['betterdb_rdb_changes_since_last_save', 'valkey.rdb.changes_since_last_save', 'updown', '{change}'],
    ['betterdb_cluster_enabled', 'valkey.cluster.cluster_enabled', 'gauge', '1'],
    ['betterdb_cluster_known_nodes', 'valkey.cluster.known_nodes', 'gauge', '{node}'],
    ['betterdb_cluster_slots_assigned', 'valkey.cluster.slots_assigned', 'gauge', '{slot}'],
    ['betterdb_cluster_slots_ok', 'valkey.cluster.slots_ok', 'gauge', '{slot}'],
    ['betterdb_cluster_slots_fail', 'valkey.cluster.slots_fail', 'gauge', '{slot}'],
    ['betterdb_cluster_slots_pfail', 'valkey.cluster.slots_pfail', 'gauge', '{slot}'],
    ['betterdb_instance_info', 'valkey.role', 'updown', '{role}'],
    ['betterdb_memory_fragmentation_bytes', 'betterdb.memory.fragmentation', 'gauge', 'By'],
    ['betterdb_tracking_clients', 'betterdb.clients.tracking', 'gauge', '{client}'],
    ['betterdb_instantaneous_input_kbps', 'betterdb.net.input_rate', 'gauge', 'KiBy/s'],
    ['betterdb_instantaneous_output_kbps', 'betterdb.net.output_rate', 'gauge', 'KiBy/s'],
    ['betterdb_pubsub_channels', 'betterdb.pubsub.channels', 'gauge', '{channel}'],
    ['betterdb_pubsub_patterns', 'betterdb.pubsub.patterns', 'gauge', '{pattern}'],
    ['betterdb_repl_output_buffer_ratio', 'betterdb.replication.output_buffer_ratio', 'gauge', '1'],
    ['betterdb_master_link_up', 'betterdb.replication.master_link_up', 'gauge', '1'],
    ['betterdb_master_last_io_seconds_ago', 'betterdb.replication.master_last_io_age', 'gauge', 's'],
    ['betterdb_rdb_last_save_timestamp_seconds', 'betterdb.rdb.last_save_time', 'gauge', 's'],
    ['betterdb_rdb_last_bgsave_ok', 'betterdb.rdb.last_bgsave_ok', 'gauge', '1'],
    ['betterdb_aof_enabled', 'betterdb.aof.enabled', 'gauge', '1'],
    ['betterdb_aof_last_bgrewrite_ok', 'betterdb.aof.last_bgrewrite_ok', 'gauge', '1'],
    ['betterdb_cluster_size', 'betterdb.cluster.size', 'gauge', '{node}'],
    ['betterdb_cluster_stats_messages_crc_mismatch', 'betterdb.cluster.messages_crc_mismatch', 'gauge', '{message}'],
    ['betterdb_cluster_slot_keys', 'betterdb.cluster.slot.keys', 'gauge', '{key}'],
    ['betterdb_cluster_slot_expires', 'betterdb.cluster.slot.expires', 'gauge', '{key}'],
    ['betterdb_cluster_slot_reads_total', 'betterdb.cluster.slot.reads', 'counter', '{read}'],
    ['betterdb_cluster_slot_writes_total', 'betterdb.cluster.slot.writes', 'counter', '{write}'],
    ['betterdb_commandstats_latency_us', 'betterdb.cmd.latency_avg', 'gauge', 'us'],
    ['betterdb_slowlog_length', 'betterdb.slowlog.length', 'gauge', '{entry}'],
    ['betterdb_slowlog_last_id', 'betterdb.slowlog.last_id', 'gauge', '{id}'],
    ['betterdb_slowlog_pattern_count', 'betterdb.slowlog.pattern.count', 'gauge', '{entry}'],
    ['betterdb_slowlog_pattern_avg_duration_us', 'betterdb.slowlog.pattern.duration_avg', 'gauge', 'us'],
    ['betterdb_slowlog_pattern_percentage', 'betterdb.slowlog.pattern.share', 'gauge', '%'],
    ['betterdb_commandlog_large_request', 'betterdb.commandlog.large_request', 'gauge', '{entry}'],
    ['betterdb_commandlog_large_reply', 'betterdb.commandlog.large_reply', 'gauge', '{entry}'],
    ['betterdb_commandlog_large_request_by_pattern', 'betterdb.commandlog.large_request_by_pattern', 'gauge', '{entry}'],
    ['betterdb_commandlog_large_reply_by_pattern', 'betterdb.commandlog.large_reply_by_pattern', 'gauge', '{entry}'],
    ['betterdb_acl_denied', 'betterdb.acl.denied', 'gauge', '{event}'],
    ['betterdb_acl_denied_by_reason', 'betterdb.acl.denied_by_reason', 'gauge', '{event}'],
    ['betterdb_acl_denied_by_user', 'betterdb.acl.denied_by_user', 'gauge', '{event}'],
    ['betterdb_client_connections_current', 'betterdb.client.connections', 'gauge', '{connection}'],
    ['betterdb_client_connections_peak', 'betterdb.client.connections_peak', 'gauge', '{connection}'],
    ['betterdb_client_connections_by_name', 'betterdb.client.connections_by_name', 'gauge', '{connection}'],
    ['betterdb_client_connections_by_user', 'betterdb.client.connections_by_user', 'gauge', '{connection}'],
    ['betterdb_vector_index_docs', 'betterdb.vector_index.docs', 'gauge', '{document}'],
    ['betterdb_vector_index_memory_bytes', 'betterdb.vector_index.memory', 'gauge', 'By'],
    ['betterdb_vector_index_indexing_failures', 'betterdb.vector_index.indexing_failures', 'gauge', '{failure}'],
    ['betterdb_vector_index_percent_indexed', 'betterdb.vector_index.indexed', 'gauge', '%'],
    ['betterdb_inference_bucket_p50_us', 'betterdb.inference.bucket.latency', 'gauge', 'us'],
    ['betterdb_inference_unhealthy', 'betterdb.inference.bucket.unhealthy', 'gauge', '1'],
    ['betterdb_inference_sla_breach', 'betterdb.inference.sla_breach', 'gauge', '1'],
    ['betterdb_poll_stale', 'betterdb.poll.stale', 'gauge', '1'],
    ['betterdb_polls_total', 'betterdb.poll.count', 'counter', '{poll}'],
    ['betterdb_anomaly_events_total', 'betterdb.anomaly.events', 'counter', '{event}'],
    ['betterdb_anomaly_events_current', 'betterdb.anomaly.active', 'gauge', '{event}'],
    ['betterdb_anomaly_by_severity', 'betterdb.anomaly.by_severity', 'gauge', '{event}'],
    ['betterdb_anomaly_by_metric', 'betterdb.anomaly.by_metric', 'gauge', '{event}'],
    ['betterdb_correlated_groups_total', 'betterdb.anomaly.correlated_groups', 'counter', '{group}'],
    ['betterdb_correlated_groups_by_severity', 'betterdb.anomaly.correlated_groups_by_severity', 'gauge', '{group}'],
    ['betterdb_correlated_groups_by_pattern', 'betterdb.anomaly.correlated_groups_by_pattern', 'gauge', '{group}'],
    ['betterdb_anomaly_buffer_ready', 'betterdb.anomaly.buffer.ready', 'gauge', '1'],
    ['betterdb_anomaly_buffer_mean', 'betterdb.anomaly.buffer.mean', 'gauge', ''],
    ['betterdb_anomaly_buffer_stddev', 'betterdb.anomaly.buffer.stddev', 'gauge', ''],
    ['betterdb_metric_forecast_time_to_limit_seconds', 'betterdb.forecast.time_to_limit', 'gauge', 's'],
    ['betterdb_cve_findings', 'betterdb.cve.findings', 'gauge', '{finding}'],
    ['betterdb_cve_kev', 'betterdb.cve.kev', 'gauge', '{finding}'],
    ['betterdb_cve_dataset_stale', 'betterdb.cve.dataset_stale', 'gauge', '1'],
  ])('%s → %s (%s, %s)', (prom, name, kind, unit) => {
    expect(planSemconvInstruments([family(prom, [])])).toEqual([
      { name, kind, unit, description: `${prom} help` },
    ]);
  });

  it('plans one instrument for families that merge into the same name', () => {
    const specs = planSemconvInstruments([
      family('betterdb_cpu_sys_seconds_total', []),
      family('betterdb_cpu_user_seconds_total', []),
      family('betterdb_inference_bucket_p50_us', []),
      family('betterdb_inference_bucket_p95_us', []),
      family('betterdb_inference_bucket_p99_us', []),
    ]);
    expect(specs.map((spec) => spec.name)).toEqual([
      'valkey.cpu.time',
      'betterdb.inference.bucket.latency',
    ]);
  });

  it('does not plan excluded families, histograms or unknown families', () => {
    expect(
      planSemconvInstruments([
        family('betterdb_keyspace_keys', []),
        family('betterdb_keyspace_keys_expiring', []),
        family('betterdb_poll_duration_seconds', [], 'histogram'),
        family('betterdb_not_in_the_table', []),
      ]),
    ).toEqual([]);
  });

  it('passes monitor process families through under their own names', () => {
    expect(
      planSemconvInstruments([
        family('betterdb_process_resident_memory_bytes', []),
        family('betterdb_process_cpu_seconds_total', [], 'counter'),
        family('betterdb_nodejs_eventloop_lag_seconds', []),
        family('betterdb_nodejs_gc_duration_seconds', [], 'histogram'),
      ]),
    ).toEqual([
      {
        name: 'betterdb_process_resident_memory_bytes',
        kind: 'gauge',
        unit: 'By',
        description: 'betterdb_process_resident_memory_bytes help',
      },
      {
        name: 'betterdb_process_cpu_seconds_total',
        kind: 'counter',
        unit: '',
        description: 'betterdb_process_cpu_seconds_total help',
      },
      {
        name: 'betterdb_nodejs_eventloop_lag_seconds',
        kind: 'gauge',
        unit: 's',
        description: 'betterdb_nodejs_eventloop_lag_seconds help',
      },
    ]);
  });
});

describe('collectSemconvPoints', () => {
  it('keeps the connection attribute and value for a plain family', () => {
    expect(one('betterdb_memory_used_bytes', 1000)).toEqual({
      points: [{ instrument: 'valkey.memory.used', value: 1000, attributes: { connection: CONN } }],
      skipped: 0,
    });
  });

  it('adds the cpu state', () => {
    expect(one('betterdb_cpu_sys_seconds_total', 1.5).points[0].attributes).toEqual({
      connection: CONN,
      state: 'sys',
    });
    expect(one('betterdb_cpu_user_seconds_total', 2.5).points[0].attributes).toEqual({
      connection: CONN,
      state: 'user',
    });
  });

  it('normalises the db label and converts avg ttl to milliseconds', () => {
    expect(one('betterdb_db_keys', 10, { db: 'db0' }).points[0]).toEqual({
      instrument: 'valkey.db.keys',
      value: 10,
      attributes: { connection: CONN, db: '0' },
    });
    expect(one('betterdb_db_avg_ttl_seconds', 1.5, { db: 'db12' }).points[0]).toEqual({
      instrument: 'valkey.db.avg_ttl',
      value: 1500,
      attributes: { connection: CONN, db: '12' },
    });
  });

  it('skips a db label that is not db<N>', () => {
    expect(one('betterdb_db_keys', 10, { db: 'other' })).toEqual({ points: [], skipped: 1 });
  });

  it('renames command to cmd', () => {
    expect(one('betterdb_commandstats_calls_total', 9, { command: 'get' }).points[0]).toEqual({
      instrument: 'valkey.cmd.calls',
      value: 9,
      attributes: { connection: CONN, cmd: 'get' },
    });
  });

  it('maps instance_info to valkey.role and drops version and os', () => {
    expect(
      one('betterdb_instance_info', 1, { version: '8.1.0', role: 'master', os: 'Linux' }).points,
    ).toEqual([{ instrument: 'valkey.role', value: 1, attributes: { connection: CONN, role: 'primary' } }]);
    expect(
      one('betterdb_instance_info', 1, { version: '8.1.0', role: 'slave', os: 'Linux' }).points[0]
        .attributes.role,
    ).toBe('replica');
  });

  it('skips an unknown role', () => {
    expect(one('betterdb_instance_info', 1, { version: 'unknown', role: 'unknown', os: 'unknown' })).toEqual({
      points: [],
      skipped: 1,
    });
  });

  it('adds the inference percentile', () => {
    expect(one('betterdb_inference_bucket_p95_us', 42, { bucket: 'b1' }).points[0]).toEqual({
      instrument: 'betterdb.inference.bucket.latency',
      value: 42,
      attributes: { connection: CONN, bucket: 'b1', percentile: 'p95' },
    });
  });

  it('drops NaN values without counting them as skipped', () => {
    expect(one('betterdb_memory_used_bytes', Number.NaN)).toEqual({ points: [], skipped: 0 });
  });

  it('returns nothing for an excluded family', () => {
    expect(one('betterdb_keyspace_keys', 15)).toEqual({ points: [], skipped: 0 });
  });
});

describe('family coverage', () => {
  it('maps, excludes or passes through every family the Prometheus service registers', async () => {
    const { service } = buildPrometheus();
    const names = (await service.collectMetricsAsJson()).map((metric) => metric.name);
    expect(names.length).toBeGreaterThan(80);
    expect(names.filter((name) => classifyFamily(name) === 'unknown')).toEqual([]);
  });

  it('has no table entry for a family the Prometheus service does not register', async () => {
    const { service } = buildPrometheus();
    const names = new Set((await service.collectMetricsAsJson()).map((metric) => metric.name));
    expect(Object.keys(SEMCONV_RULES).filter((name) => !names.has(name))).toEqual([]);
  });
});
