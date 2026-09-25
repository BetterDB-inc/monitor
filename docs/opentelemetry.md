---
title: OpenTelemetry
nav_order: 3.5
---

# OpenTelemetry (OTLP)

BetterDB Monitor speaks OTLP in both directions. It **ingests** traces from your instrumented applications and metrics pushed by an OpenTelemetry Collector for instances it doesn't connect to, and it can **export** its metrics and events to any OTLP collector.

One thing to be clear about up front: Monitor's metrics are Prometheus-first (see **[Prometheus Integration](prometheus-integration.md)**). The OTLP metrics export is a mirror of that registry, not the source of truth. And on the trace side Monitor is a **receiver**: it stores spans your apps send, it does not emit spans of its own.

## At a glance

| Signal                       | Direction        | Endpoint                      | Default     |
| ---------------------------- | ---------------- | ----------------------------- | ----------- |
| Traces                       | Ingest (receive) | `POST /v1/traces`             | on          |
| Metrics (external instances) | Ingest (receive) | `POST /v1/external/metrics`   | on          |
| Metrics                      | Export (mirror)  | `${OTLP endpoint}/v1/metrics` | off, opt-in |
| Events                       | Export (logs)    | `${OTLP endpoint}/v1/logs`    | off, opt-in |

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

**Auth.** If `OTEL_INGEST_TOKEN` is set, requests must carry `Authorization: Bearer <token>`. The token is required in cloud mode, where `/v1/traces` is allowlisted past session auth. Set `OTEL_INGEST_ENABLED=false` (or `0`) to turn the receiver off entirely.

The same `OTEL_INGEST_ENABLED` gate and `OTEL_INGEST_TOKEN` also cover `POST /v1/external/metrics` — see **Metrics ingestion** below.

## Metrics ingestion

BetterDB Monitor can also ingest OTLP _metrics_, at **`POST /v1/external/metrics`**, for instances it doesn't dial itself — a Redis or Valkey behind a firewall, or one whose credentials you'd rather not hand to Monitor. An OpenTelemetry Collector scrapes the instance and pushes metrics here instead.

**Register the instance first.** Add Connection → OTLP push, giving the host and port the collector reports. Metrics for an instance that isn't registered are dropped (`unknown_instance`); metrics for an instance BetterDB already polls directly are also dropped (`already_polled`).

**Identity.** Each `ResourceMetrics` payload is matched to a connection by `service.instance.id` (`host:port`, or Valkey Admin's `host-port` form), falling back to `server.address` plus `server.port`. `redisreceiver` doesn't set `server.address`/`server.port` by default, so the collector config needs `resource_attributes.server.address.enabled: true` and `server.port.enabled: true`.

**Collector config.** The Add Connection → OTLP push tab generates this config with your host, port and this server's URL filled in:

```yaml
receivers:
  redis:
    endpoint: <host>:<port>
    collection_interval: 15s
    resource_attributes:
      server.address:
        enabled: true
      server.port:
        enabled: true
    metrics:
      redis.maxmemory:
        enabled: true
      redis.role:
        enabled: true
      redis.cmd.calls:
        enabled: true
      redis.cmd.usec:
        enabled: true

exporters:
  otlphttp/betterdb:
    metrics_endpoint: <betterdb-url>/v1/external/metrics
    headers:
      Authorization: 'Bearer ${env:BETTERDB_OTEL_INGEST_TOKEN}'

service:
  pipelines:
    metrics:
      receivers: [redis]
      exporters: [otlphttp/betterdb]
```

Use `metrics_endpoint`, not the plain `endpoint` — `endpoint` appends the standard `/v1/metrics` path and misses this route entirely.

**Compression.** Request bodies compressed with `gzip` (the `otlphttp` exporter's default) or `deflate` are accepted on both `/v1/external/metrics` and `/v1/traces`; any other `Content-Encoding` is rejected with `415`. Request bodies are limited to 1 MiB after decompression, and oversize requests are rejected; if the collector config adds a `batch` processor, keep `send_batch_max_size` small enough to stay under this limit.

**Supported vocabularies.** Monitor understands the `redis.*` names emitted by the collector-contrib `redisreceiver`, and the equivalent `valkey.*` names from Valkey Admin's exporter (only `valkey.memory.used` and `valkey.cpu.time` are confirmed against a real deployment so far; the rest of the `valkey.*` mapping assumes it mirrors `redisreceiver`). Only cumulative sums and gauges are accepted — histograms, summaries and delta-temporality sums are rejected outright (`unsupported_type` / `unsupported_temporality`). Each accepted point maps to exactly one INFO field; nothing is summed:

| OTLP metric (`redis.` or `valkey.`)     | Point attributes                                                                    | INFO section.field                                                                                                |
| --------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `memory.used`                           | —                                                                                   | `memory.used_memory`                                                                                              |
| `memory.rss`                            | —                                                                                   | `memory.used_memory_rss`                                                                                          |
| `memory.peak`                           | —                                                                                   | `memory.used_memory_peak`                                                                                         |
| `memory.lua`                            | —                                                                                   | `memory.used_memory_lua`                                                                                          |
| `memory.fragmentation_ratio`            | —                                                                                   | `memory.mem_fragmentation_ratio`                                                                                  |
| `memory.used_memory_overhead`           | —                                                                                   | `memory.used_memory_overhead`                                                                                     |
| `memory.used_memory_startup`            | —                                                                                   | `memory.used_memory_startup`                                                                                      |
| `maxmemory`                             | —                                                                                   | `memory.maxmemory`                                                                                                |
| `cpu.time`                              | `state` ∈ sys, sys_children, sys_main_thread, user, user_children, user_main_thread | `cpu.used_cpu_<state>`                                                                                            |
| `commands`                              | —                                                                                   | `stats.instantaneous_ops_per_sec`                                                                                 |
| `commands.processed`                    | —                                                                                   | `stats.total_commands_processed`                                                                                  |
| `connections.received`                  | —                                                                                   | `stats.total_connections_received`                                                                                |
| `connections.rejected`                  | —                                                                                   | `stats.rejected_connections`                                                                                      |
| `keys.evicted`                          | —                                                                                   | `stats.evicted_keys`                                                                                              |
| `keys.expired`                          | —                                                                                   | `stats.expired_keys`                                                                                              |
| `keyspace.hits`                         | —                                                                                   | `stats.keyspace_hits`                                                                                             |
| `keyspace.misses`                       | —                                                                                   | `stats.keyspace_misses`                                                                                           |
| `net.input`                             | —                                                                                   | `stats.total_net_input_bytes`                                                                                     |
| `net.output`                            | —                                                                                   | `stats.total_net_output_bytes`                                                                                    |
| `latest_fork`                           | —                                                                                   | `stats.latest_fork_usec`                                                                                          |
| `clients.connected`                     | —                                                                                   | `clients.connected_clients`                                                                                       |
| `clients.blocked`                       | —                                                                                   | `clients.blocked_clients`                                                                                         |
| `clients.max_input_buffer`              | —                                                                                   | `clients.client_recent_max_input_buffer`                                                                          |
| `clients.max_output_buffer`             | —                                                                                   | `clients.client_recent_max_output_buffer`                                                                         |
| `slaves.connected`                      | —                                                                                   | `replication.connected_slaves`                                                                                    |
| `replication.offset`                    | —                                                                                   | `replication.master_repl_offset`                                                                                  |
| `replication.backlog_first_byte_offset` | —                                                                                   | `replication.repl_backlog_first_byte_offset`                                                                      |
| `role`                                  | `role` ∈ primary, replica; value 1                                                  | `replication.role` = `master` / `slave` (a point whose value isn't 1 is skipped silently, not counted as dropped) |
| `uptime`                                | —                                                                                   | `server.uptime_in_seconds`                                                                                        |
| `rdb.changes_since_last_save`           | —                                                                                   | `persistence.rdb_changes_since_last_save`                                                                         |
| `db.keys` / `db.expires` / `db.avg_ttl` | `db`                                                                                | composite `keyspace.db<N>` → `keys` / `expires` / `avg_ttl`                                                       |
| `cmd.calls` / `cmd.usec`                | `cmd`                                                                               | composite `commandstats.cmdstat_<cmd>` → `calls` / `usec`                                                         |
| resource `redis.version`                | —                                                                                   | `server.redis_version`, plus capabilities                                                                         |

**What works.** Memory history and forecasting, anomaly detection (INFO-based detectors, limited to the fields the collector pushes), health and instance-down webhooks, and commandstats all run against pushed data the same as a polled connection.

**What doesn't.** Every view that needs a live command against the instance stays unavailable: slow log, clients, latency, key analytics, cluster, security/audit, vector search, and the other live-only pages. They show: "Not available for OTLP-ingested connections — this view needs a live connection." Migration is a related but separate case — it's blocked at the source/target picker instead, with its own message ("One or more selected instances only pushes OTLP metrics. Migration needs a live connection to both instances."), since an OTLP-ingested connection is never a valid migration source or target.

**Prometheus.** OTLP-push connections are exported at `/api/prometheus/metrics` like polled ones, with one difference: a series exists only for a field the collector actually pushed. A field that was never pushed, or stopped being pushed, has no series rather than a `0`. Cluster, slot-stats, raw slow log, ACL and client-analytics series are never produced for these connections, and webhooks or compliance alerts that depend on an unpushed field (for example `maxclients` or `maxmemory_policy`) don't fire. Ingest itself is counted by `betterdb_otlp_metric_points_accepted_total` and `betterdb_otlp_metric_points_dropped_total{reason}` (full export profile only).

**Drop reasons.** A response's `partialSuccess.errorMessage` summarises rejected points by reason, for example `unknown_instance=12 unmapped_metric=3`:

| Reason                    | Meaning                                                                                                                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unidentified`            | The resource has no `service.instance.id`, or one that can't be parsed as `host:port`/`host-port`, and there's no `server.address`/`server.port` fallback either — so no instance could be resolved. |
| `unknown_instance`        | The resolved host:port isn't a registered connection.                                                                                                                                                |
| `already_polled`          | The resolved host:port is a connection BetterDB already polls directly (not registered as OTLP push).                                                                                                |
| `unsupported_type`        | The point is a histogram, exponential histogram, or summary.                                                                                                                                         |
| `unsupported_temporality` | The point is a sum with delta (not cumulative) temporality.                                                                                                                                          |
| `unmapped_metric`         | The metric name or its attributes don't match anything in the table above.                                                                                                                           |
| `cardinality_limit`       | The point would add a new `keyspace` or `commandstats` entry beyond the per-connection cap (256 databases, 1024 commands). Entries whose values have all gone stale free their slot.                 |

**Staleness.** `OTEL_METRICS_STALE_AFTER_MS` (default 5 minutes) sets how long a pushed point stays valid. Set it well above the exporter's push interval (at least 2x); a window shorter than the interval makes health flap down and up between pushes, so values under 60000 are rejected at startup. Once every field has gone stale with no fresh push (a `keyspace` or `commandstats` entry only counts while its `keys` or `calls` value is fresh), the connection shows as disconnected and health fires an instance-down event. Staleness counts from when Monitor received a point, so a collector whose clock runs behind does not age data out early. A point's own timestamp only decides which of two values for the same field is newer (a point stamped ahead of Monitor's clock is treated as received now). After a BetterDB restart, a connection stays disconnected until the next push arrives — nothing is lost, since prior history is kept in storage.

**Memory snapshots.** A pushed instance gets a memory snapshot whenever `used_memory` is present. Any other snapshot field the exporter didn't push (`used_memory_rss`, `used_memory_peak`, `mem_fragmentation_ratio`, `allocator_frag_ratio`, the io-thread read/write counters and the like) is stored as `0` rather than left blank. `redisreceiver` never emits `allocator_frag_ratio` or the io-thread counters, and of the memory fields only `valkey.memory.used` is confirmed for Valkey Admin's exporter.

**Auth.** Ingestion is gated the same way as trace ingestion: `OTEL_INGEST_ENABLED` and `OTEL_INGEST_TOKEN` (mandatory in cloud mode).

## Metrics export

Set `OTEL_EXPORTER_OTLP_ENDPOINT` and Monitor mirrors its Prometheus registry to OTLP metrics, pushing to `${endpoint}/v1/metrics` on an interval as service `betterdb-monitor`.

A caveat worth knowing: counters and gauges are mirrored, but **histograms and summaries are skipped** because they do not map cleanly onto the OTLP instruments here. So the OTLP mirror is a subset. For the complete set, including histograms and every `betterdb_*` family, scrape the Prometheus endpoint at `/api/prometheus/metrics` (see **[Prometheus Integration](prometheus-integration.md)** and the **[full metrics reference](prometheus-metrics.md)**).

The mirror reads the same registry as `/api/prometheus/metrics`, so stale-connection series are dropped from it on the same staleness bound (see `PROMETHEUS_STALENESS_MS`).

Tune the push interval with `OTEL_METRICS_EXPORT_INTERVAL_MS` (default `15000`).

## Event export

When an OTLP endpoint is configured, Monitor also emits discrete monitoring events as OTLP log records to `${endpoint}/v1/logs` (logger `betterdb-events`). These are the same events that drive webhooks: instance up/down, cluster failover, cluster bus corruption, and compliance alerts.

## Environment variables

| Variable                          | Default  | Description                                                                                                                                      |
| --------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OTEL_INGEST_ENABLED`             | `true`   | Enable the OTLP receivers: `/v1/traces` (traces) and `/v1/external/metrics` (metrics ingestion).                                                 |
| `OTEL_INGEST_TOKEN`               | unset    | Bearer token required to post traces or push metrics. Required in cloud mode.                                                                    |
| `OTEL_METRICS_STALE_AFTER_MS`     | `300000` | Age after which a pushed metric is ignored; min `60000`. Must exceed the exporter push interval (at least 2x).                                   |
| `OTEL_EXPORTER_OTLP_ENDPOINT`     | unset    | Base URL of your OTLP/HTTP collector. Setting it enables the metrics and event exports; `/v1/metrics` and `/v1/logs` are appended automatically. |
| `OTEL_TELEMETRY_ENABLED`          | `true`   | Set `false` to disable the metrics and event exports even when an endpoint is set.                                                               |
| `OTEL_METRICS_EXPORT_INTERVAL_MS` | `15000`  | Metrics mirror push interval in milliseconds (minimum `1000`).                                                                                   |

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
- **Metrics ingestion:** Monitor receives OTLP metrics at `/v1/external/metrics` for registered OTLP-push connections, driving memory history, forecasting, anomaly detection, health and the Prometheus export for instances it doesn't dial directly.
- **Metrics:** Prometheus-first at `/api/prometheus/metrics`; opt-in OTLP mirror of counters and gauges when an endpoint is set (histograms via Prometheus only).
- **Events:** opt-in OTLP logs for the same events that trigger webhooks.
