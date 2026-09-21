---
title: Adding query analytics to PMM's Valkey monitoring in 10 minutes
nav_order: 11
---

# Adding query analytics to PMM's Valkey monitoring in 10 minutes

Percona Monitoring and Management (PMM) already watches your Valkey
instances. This page covers where BetterDB Monitor fits alongside it, and
how to wire the two together without replacing anything PMM already does.

## What PMM already gives you

PMM's Valkey/Redis monitoring covers host-level and server vitals: CPU,
memory, disk and network for the node, plus the server-level `INFO` metrics
— uptime, connected clients, keyspace hits/misses, replication status — on
its stock Valkey dashboards.

## What BetterDB adds

BetterDB Monitor adds the metric families PMM doesn't collect today:

- **Slowlog pattern analysis** — `betterdb_slowlog_pattern_count`,
  `betterdb_slowlog_pattern_avg_duration_us`,
  `betterdb_slowlog_pattern_percentage`, `betterdb_slowlog_length`: which
  _query patterns_ are slow, not just which individual commands were.
- **Commandlog pattern analysis** — `betterdb_commandlog_large_request_by_pattern`,
  `betterdb_commandlog_large_reply_by_pattern`: oversized requests and
  replies, grouped by pattern.
- **Cluster slot distribution** — `betterdb_cluster_slot_keys`,
  `betterdb_cluster_slot_reads_total`, `betterdb_cluster_slot_writes_total`,
  `betterdb_cluster_slot_expires`: per-slot key counts and read/write
  volume, for spotting hot or unbalanced slots.
- **Anomaly and forecast series** — `betterdb_anomaly_events_total`,
  `betterdb_anomaly_by_severity`, `betterdb_correlated_groups_total`,
  `betterdb_metric_forecast_time_to_limit_seconds`: detected anomalies
  grouped by severity and correlated pattern, and a forecast of when a
  trending metric will hit its limit.

## Wiring it up

Pick whichever fits your Prometheus setup better:

1. **Run the monitor next to your Valkey**, pointed at it with `DB_HOST` /
   `DB_PORT` (and credentials, if set), then add a scrape job to the
   Prometheus instance PMM reads from:

   ```yaml
   scrape_configs:
     - job_name: 'betterdb'
       metrics_path: '/api/prometheus/metrics'
       static_configs:
         - targets: ['<monitor-host>:3001']
   ```

2. **Or**, if you'd rather not add a scrape target, point the monitor's
   OTLP mirror at a Collector you already run:
   `OTEL_EXPORTER_OTLP_ENDPOINT=http://<collector>:4318`, then scrape the
   Collector's Prometheus exporter instead. See
   **[OpenTelemetry Collector](opentelemetry.md#opentelemetry-collector)**
   for the config.

Either path lands the same `betterdb_*` series in the Prometheus PMM
already queries.

## Importing the dashboards

Import **BetterDB · Query Patterns** and **BetterDB · Anomalies** from
`deploy/observability/dashboards/` into the same Grafana that renders your
PMM dashboards — see
**[the observability pack README](../deploy/observability/README.md)** for
the import steps. They sit fine next to PMM's stock Valkey dashboards; both
read from the same Prometheus, just different metric families.

## What's not covered yet

The docker-compose demo in `deploy/observability/demo/` ships Grafana only
— it doesn't include a PMM container. If you want to try the wiring above
end-to-end, bring your own PMM install and point it at the same Prometheus
the demo (or your own monitor) is feeding.
