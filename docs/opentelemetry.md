---
title: OpenTelemetry
nav_order: 3.5
---

# OpenTelemetry (OTLP)

BetterDB Monitor speaks OTLP in both directions. It **ingests** traces from your instrumented applications, and it can **export** its metrics and events to any OTLP collector.

One thing to be clear about up front: Monitor's metrics are Prometheus-first (see **[Prometheus Integration](prometheus-integration.md)**). The OTLP metrics export is a mirror of that registry, not the source of truth. And on the trace side Monitor is a **receiver**: it stores spans your apps send, it does not emit spans of its own.

## At a glance

| Signal  | Direction        | Endpoint                      | Default     |
| ------- | ---------------- | ----------------------------- | ----------- |
| Traces  | Ingest (receive) | `POST /v1/traces`             | on          |
| Metrics | Export (mirror)  | `${OTLP endpoint}/v1/metrics` | off, opt-in |
| Events  | Export (logs)    | `${OTLP endpoint}/v1/logs`    | off, opt-in |

Both exports are off until you set `OTEL_EXPORTER_OTLP_ENDPOINT`. The collector handles fan-out to Jaeger, Tempo, Cloudwatch, or whatever backend you run.

## Trace ingestion

Monitor exposes a standard OTLP/HTTP trace receiver at **`/v1/traces`**. Note this path sits at the server root, not under the `/api` prefix.

It accepts both OTLP encodings:

- `application/x-protobuf` - the OTel SDK default (`OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`)
- `application/json` - set `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`

Ingested spans from `@betterdb/*` instrumentation scopes (plus their root spans) are kept and rendered as request waterfalls in the AI Traces view, correlated with the live Valkey state underneath each request.

Point your application's OTLP exporter at Monitor:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://monitor-host:3001
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf          # or http/json
# only if you set OTEL_INGEST_TOKEN on Monitor:
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <token>
```

**Auth.** If `OTEL_INGEST_TOKEN` is set, requests must carry `Authorization: Bearer <token>`. The token is required in cloud mode, where `/v1/traces` is allowlisted past session auth. Set `OTEL_INGEST_ENABLED=false` to turn the receiver off entirely.

## Metrics export

Set `OTEL_EXPORTER_OTLP_ENDPOINT` and Monitor mirrors its Prometheus registry to OTLP metrics, pushing to `${endpoint}/v1/metrics` on an interval as service `betterdb-monitor`.

A caveat worth knowing: counters and gauges are mirrored, but **histograms and summaries are skipped** because they do not map cleanly onto the OTLP instruments here. So the OTLP mirror is a subset. For the complete set, including histograms and every `betterdb_*` family, scrape the Prometheus endpoint at `/api/prometheus/metrics` (see **[Prometheus Integration](prometheus-integration.md)** and the **[full metrics reference](prometheus-metrics.md)**).

The mirror reads the same registry as `/api/prometheus/metrics`, so stale-connection series are dropped from it on the same staleness bound (see `PROMETHEUS_STALENESS_MS`).

Tune the push interval with `OTEL_METRICS_EXPORT_INTERVAL_MS` (default `15000`).

### Export modes

`OTEL_METRICS_EXPORT_MODE` picks how metrics are named and grouped. It is read once at startup.

- **`mirror`** (default) keeps the Prometheus names (`betterdb_memory_used_bytes`) on one `betterdb-monitor` resource, with a `connection` attribute on every point.
- **`semconv`** sends one OTLP resource per monitored node, named after the OpenTelemetry Collector `redisreceiver` catalogue with a `valkey.` prefix, so dashboards built for that receiver work unchanged.

Any other value logs a warning and uses `mirror`. `METRICS_EXPORT_PROFILE` applies in both modes.

**Resource attributes in `semconv` mode**

| Attribute | Value |
| --- | --- |
| `service.name` | `valkey` or `redis` (`valkey` until the first poll detects the type) |
| `service.instance.id` | `host:port` |
| `db.system.name` | `valkey` or `redis` (omitted until detected) |
| `server.address` | host |
| `server.port` | port |
| `valkey.version` | server version (omitted until detected) |

Monitor process metrics (`betterdb_process_*`, `betterdb_nodejs_*`) stay on the `betterdb-monitor` resource under their Prometheus names. A point whose connection is not registered also lands there and keeps its `connection` attribute.

Monitor sends one OTLP request per node plus one for the monitor each interval.

**Metric names in `semconv` mode**

**Receiver-aligned**

| Prometheus family | Semconv metric | Unit |
| --- | --- | --- |
| `betterdb_memory_used_bytes` | `valkey.memory.used` | `By` |
| `betterdb_memory_used_rss_bytes` | `valkey.memory.rss` | `By` |
| `betterdb_memory_used_peak_bytes` | `valkey.memory.peak` | `By` |
| `betterdb_memory_max_bytes` | `valkey.maxmemory` | `By` |
| `betterdb_memory_fragmentation_ratio` | `valkey.memory.fragmentation_ratio` | `1` |
| `betterdb_cpu_sys_seconds_total` | `valkey.cpu.time` | `s` |
| `betterdb_cpu_user_seconds_total` | `valkey.cpu.time` | `s` |
| `betterdb_connected_clients` | `valkey.clients.connected` | `{client}` |
| `betterdb_blocked_clients` | `valkey.clients.blocked` | `{client}` |
| `betterdb_commands_processed_total` | `valkey.commands.processed` | `{command}` |
| `betterdb_connections_received_total` | `valkey.connections.received` | `{connection}` |
| `betterdb_instantaneous_ops_per_sec` | `valkey.commands` | `{ops}/s` |
| `betterdb_keyspace_hits_total` | `valkey.keyspace.hits` | `{hit}` |
| `betterdb_keyspace_misses_total` | `valkey.keyspace.misses` | `{miss}` |
| `betterdb_evicted_keys_total` | `valkey.keys.evicted` | `{key}` |
| `betterdb_expired_keys_total` | `valkey.keys.expired` | `{event}` |
| `betterdb_db_keys` | `valkey.db.keys` | `{key}` |
| `betterdb_db_keys_expiring` | `valkey.db.expires` | `{key}` |
| `betterdb_db_avg_ttl_seconds` | `valkey.db.avg_ttl` | `ms` |
| `betterdb_commandstats_calls_total` | `valkey.cmd.calls` | `{call}` |
| `betterdb_connected_slaves` | `valkey.slaves.connected` | `{replica}` |
| `betterdb_replication_offset` | `valkey.replication.offset` | `By` |
| `betterdb_uptime_in_seconds` | `valkey.uptime` | `s` |
| `betterdb_rdb_changes_since_last_save` | `valkey.rdb.changes_since_last_save` | `{change}` |
| `betterdb_cluster_enabled` | `valkey.cluster.cluster_enabled` | `1` |
| `betterdb_cluster_known_nodes` | `valkey.cluster.known_nodes` | `{node}` |
| `betterdb_cluster_slots_assigned` | `valkey.cluster.slots_assigned` | `{slot}` |
| `betterdb_cluster_slots_ok` | `valkey.cluster.slots_ok` | `{slot}` |
| `betterdb_cluster_slots_fail` | `valkey.cluster.slots_fail` | `{slot}` |
| `betterdb_cluster_slots_pfail` | `valkey.cluster.slots_pfail` | `{slot}` |
| `betterdb_instance_info` | `valkey.role` | `{role}` |

**BetterDB-only**

| Prometheus family | Semconv metric | Unit |
| --- | --- | --- |
| `betterdb_memory_fragmentation_bytes` | `betterdb.memory.fragmentation` | `By` |
| `betterdb_tracking_clients` | `betterdb.clients.tracking` | `{client}` |
| `betterdb_instantaneous_input_kbps` | `betterdb.net.input_rate` | `KiBy/s` |
| `betterdb_instantaneous_output_kbps` | `betterdb.net.output_rate` | `KiBy/s` |
| `betterdb_pubsub_channels` | `betterdb.pubsub.channels` | `{channel}` |
| `betterdb_pubsub_patterns` | `betterdb.pubsub.patterns` | `{pattern}` |
| `betterdb_repl_output_buffer_ratio` | `betterdb.replication.output_buffer_ratio` | `1` |
| `betterdb_master_link_up` | `betterdb.replication.master_link_up` | `1` |
| `betterdb_master_last_io_seconds_ago` | `betterdb.replication.master_last_io_age` | `s` |
| `betterdb_rdb_last_save_timestamp_seconds` | `betterdb.rdb.last_save_time` | `s` |
| `betterdb_rdb_last_bgsave_ok` | `betterdb.rdb.last_bgsave_ok` | `1` |
| `betterdb_aof_enabled` | `betterdb.aof.enabled` | `1` |
| `betterdb_aof_last_bgrewrite_ok` | `betterdb.aof.last_bgrewrite_ok` | `1` |
| `betterdb_cluster_size` | `betterdb.cluster.size` | `{node}` |
| `betterdb_cluster_stats_messages_crc_mismatch` | `betterdb.cluster.messages_crc_mismatch` | `{message}` |
| `betterdb_cluster_slot_keys` | `betterdb.cluster.slot.keys` | `{key}` |
| `betterdb_cluster_slot_expires` | `betterdb.cluster.slot.expires` | `{key}` |
| `betterdb_cluster_slot_reads_total` | `betterdb.cluster.slot.reads` | `{read}` |
| `betterdb_cluster_slot_writes_total` | `betterdb.cluster.slot.writes` | `{write}` |
| `betterdb_commandstats_latency_us` | `betterdb.cmd.latency_avg` | `us` |
| `betterdb_slowlog_length` | `betterdb.slowlog.length` | `{entry}` |
| `betterdb_slowlog_last_id` | `betterdb.slowlog.last_id` | `{id}` |
| `betterdb_slowlog_pattern_count` | `betterdb.slowlog.pattern.count` | `{entry}` |
| `betterdb_slowlog_pattern_avg_duration_us` | `betterdb.slowlog.pattern.duration_avg` | `us` |
| `betterdb_slowlog_pattern_percentage` | `betterdb.slowlog.pattern.share` | `%` |
| `betterdb_commandlog_large_request` | `betterdb.commandlog.large_request` | `{entry}` |
| `betterdb_commandlog_large_reply` | `betterdb.commandlog.large_reply` | `{entry}` |
| `betterdb_commandlog_large_request_by_pattern` | `betterdb.commandlog.large_request_by_pattern` | `{entry}` |
| `betterdb_commandlog_large_reply_by_pattern` | `betterdb.commandlog.large_reply_by_pattern` | `{entry}` |
| `betterdb_acl_denied` | `betterdb.acl.denied` | `{event}` |
| `betterdb_acl_denied_by_reason` | `betterdb.acl.denied_by_reason` | `{event}` |
| `betterdb_acl_denied_by_user` | `betterdb.acl.denied_by_user` | `{event}` |
| `betterdb_client_connections_current` | `betterdb.client.connections` | `{connection}` |
| `betterdb_client_connections_peak` | `betterdb.client.connections_peak` | `{connection}` |
| `betterdb_client_connections_by_name` | `betterdb.client.connections_by_name` | `{connection}` |
| `betterdb_client_connections_by_user` | `betterdb.client.connections_by_user` | `{connection}` |
| `betterdb_vector_index_docs` | `betterdb.vector_index.docs` | `{document}` |
| `betterdb_vector_index_memory_bytes` | `betterdb.vector_index.memory` | `By` |
| `betterdb_vector_index_indexing_failures` | `betterdb.vector_index.indexing_failures` | `{failure}` |
| `betterdb_vector_index_percent_indexed` | `betterdb.vector_index.indexed` | `%` |
| `betterdb_inference_bucket_p50_us` | `betterdb.inference.bucket.latency` | `us` |
| `betterdb_inference_bucket_p95_us` | `betterdb.inference.bucket.latency` | `us` |
| `betterdb_inference_bucket_p99_us` | `betterdb.inference.bucket.latency` | `us` |
| `betterdb_inference_unhealthy` | `betterdb.inference.bucket.unhealthy` | `1` |
| `betterdb_inference_sla_breach` | `betterdb.inference.sla_breach` | `1` |
| `betterdb_poll_stale` | `betterdb.poll.stale` | `1` |
| `betterdb_polls_total` | `betterdb.poll.count` | `{poll}` |
| `betterdb_anomaly_events_total` | `betterdb.anomaly.events` | `{event}` |
| `betterdb_anomaly_events_current` | `betterdb.anomaly.active` | `{event}` |
| `betterdb_anomaly_by_severity` | `betterdb.anomaly.by_severity` | `{event}` |
| `betterdb_anomaly_by_metric` | `betterdb.anomaly.by_metric` | `{event}` |
| `betterdb_correlated_groups_total` | `betterdb.anomaly.correlated_groups` | `{group}` |
| `betterdb_correlated_groups_by_severity` | `betterdb.anomaly.correlated_groups_by_severity` | `{group}` |
| `betterdb_correlated_groups_by_pattern` | `betterdb.anomaly.correlated_groups_by_pattern` | `{group}` |
| `betterdb_anomaly_buffer_ready` | `betterdb.anomaly.buffer.ready` | `1` |
| `betterdb_anomaly_buffer_mean` | `betterdb.anomaly.buffer.mean` | — |
| `betterdb_anomaly_buffer_stddev` | `betterdb.anomaly.buffer.stddev` | — |
| `betterdb_metric_forecast_time_to_limit_seconds` | `betterdb.forecast.time_to_limit` | `s` |
| `betterdb_cve_findings` | `betterdb.cve.findings` | `{finding}` |
| `betterdb_cve_kev` | `betterdb.cve.kev` | `{finding}` |
| `betterdb_cve_dataset_stale` | `betterdb.cve.dataset_stale` | `1` |

Conversions: `db` values drop the `db` prefix (`db0` → `0`), `valkey.db.avg_ttl` is in milliseconds, the two CPU families become `valkey.cpu.time` with `state=sys|user`, `betterdb_instance_info` becomes `valkey.role{role=primary|replica}` (the version moves to the resource), `command` is renamed `cmd`, and the three inference percentile families become `betterdb.inference.bucket.latency{percentile}`. `betterdb_keyspace_keys` and `betterdb_keyspace_keys_expiring` are not exported in this mode because they are sums of `valkey.db.*`.

## Event export

When an OTLP endpoint is configured, Monitor also emits discrete monitoring events as OTLP log records to `${endpoint}/v1/logs` (logger `betterdb-events`). These are the same events that drive webhooks: instance up/down, cluster failover, cluster bus corruption, and compliance alerts.

## Environment variables

| Variable                          | Default | Description                                                                                                                                      |
| --------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OTEL_INGEST_ENABLED`             | `true`  | Enable the `/v1/traces` OTLP trace receiver.                                                                                                     |
| `OTEL_INGEST_TOKEN`               | unset   | Bearer token required to post traces. Required in cloud mode.                                                                                    |
| `OTEL_EXPORTER_OTLP_ENDPOINT`     | unset   | Base URL of your OTLP/HTTP collector. Setting it enables the metrics and event exports; `/v1/metrics` and `/v1/logs` are appended automatically. |
| `OTEL_TELEMETRY_ENABLED`          | `true`  | Set `false` to disable the metrics and event exports even when an endpoint is set.                                                               |
| `OTEL_METRICS_EXPORT_INTERVAL_MS` | `15000` | Metrics mirror push interval in milliseconds (minimum `1000`).                                                                                   |
| `OTEL_METRICS_EXPORT_MODE`        | `mirror`| `mirror` or `semconv`. See [Export modes](#export-modes).                                                                                        |

## Kubernetes

The install chart wires the export endpoint through an env var. See **[Kubernetes install](install/kubernetes.md)** for a full manifest:

```yaml
env:
  - name: OTEL_EXPORTER_OTLP_ENDPOINT
    value: 'http://otel-collector.observability.svc.cluster.local:4318'
```

## OpenTelemetry Collector

A tested Collector config ships in `deploy/observability/collector/`:

- **`otel-collector.yaml`** — the base config. It receives OTLP on
  `0.0.0.0:4317` (grpc) and `0.0.0.0:4318` (http) — the same endpoint you
  point `OTEL_EXPORTER_OTLP_ENDPOINT` at — batches and memory-limits the
  stream, and re-exposes it as a Prometheus scrape target on `:8889`.
- **`otel-collector.fanout.yaml`** — the same intake, additionally exporting
  to a second OTLP backend of your choice via the `SECONDARY_OTLP_ENDPOINT`
  environment variable (for example a hosted metrics backend), alongside
  the same Prometheus exporter.

Both configs are plain YAML mounted into the Collector container — editing
them doesn't require rebuilding an image.

Monitor pushes its OTLP mirror on `OTEL_METRICS_EXPORT_INTERVAL_MS` (default
`15000`ms). Point Prometheus at the Collector's exporter on `:8889` rather
than at Monitor directly if you want the Collector in the path.

`connection` is a datapoint attribute, not a resource attribute, so the
Prometheus exporter turns it into a `connection` label on every metric
regardless of configuration. The exporter's
`resource_to_telemetry_conversion` setting covers the resource attributes
instead — Monitor sets exactly one, `service.name`, which the setting
promotes to a `service_name` label. That is why the
**[dashboard pack](prometheus-integration.md#grafana-dashboard-pack)**,
which is templated on `connection`, works unmodified whether Grafana points
at Monitor's own `/api/prometheus/metrics` or at the Collector's `:8889`.

See **[the observability pack README](../deploy/observability/README.md)**
for import instructions and a full docker-compose demo of Monitor, the
Collector, Prometheus, and Grafana running together.

## Summary

- **Traces:** Monitor receives OTLP traces at `/v1/traces` (JSON and protobuf). It does not export its own spans.
- **Metrics:** Prometheus-first at `/api/prometheus/metrics`; opt-in OTLP mirror of counters and gauges when an endpoint is set (histograms via Prometheus only).
- **Events:** opt-in OTLP logs for the same events that trigger webhooks.
