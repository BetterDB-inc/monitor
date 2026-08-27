---
title: Prometheus Integration
nav_order: 3
---

# Prometheus Integration

BetterDB Monitor exports **110+ metrics** at `/api/prometheus/metrics` — raw node-level metrics from `INFO`, cluster and per-slot statistics, persisted forensics (slowlog/commandlog patterns, ACL denials, client activity), and precomputed anomaly signals.

See the **[full metrics reference](prometheus-metrics.md)** for every metric, its labels, and cardinality notes.

## What's Exported

| Category | Examples | Source |
|----------|----------|--------|
| Server / node | `betterdb_uptime_in_seconds`, `betterdb_instance_info` | `INFO server` |
| Memory | `betterdb_memory_used_bytes`, `betterdb_memory_fragmentation_ratio`, `betterdb_memory_used_peak_bytes` | `INFO memory` |
| CPU | `betterdb_cpu_sys_seconds_total`, `betterdb_cpu_user_seconds_total` | `INFO cpu` |
| Stats / keyspace | `betterdb_keyspace_hits_total`, `betterdb_evicted_keys_total`, `betterdb_db_keys`, `betterdb_db_avg_ttl_seconds` | `INFO stats`, `INFO keyspace` |
| Clients | `betterdb_connected_clients`, `betterdb_blocked_clients`, `betterdb_client_connections_by_user` | `INFO clients`, `CLIENT LIST` |
| Replication | `betterdb_replication_offset`, `betterdb_connected_slaves`, `betterdb_repl_output_buffer_ratio` | `INFO replication` |
| Command stats | `betterdb_commandstats_calls_total`, `betterdb_commandstats_latency_us` | `INFO commandstats` |
| Cluster | `betterdb_cluster_size`, `betterdb_cluster_slots_ok`/`_fail`/`_pfail`, `betterdb_cluster_known_nodes` | `CLUSTER INFO` |
| Per-slot stats | `betterdb_cluster_slot_keys`, `betterdb_cluster_slot_reads_total`, `betterdb_cluster_slot_writes_total` | `CLUSTER SLOT-STATS` (Valkey 8.0+) |
| Slowlog patterns | `betterdb_slowlog_pattern_count`, `betterdb_slowlog_pattern_avg_duration_us` | Persisted slowlog history |
| COMMANDLOG | `betterdb_commandlog_large_request_by_pattern`, `betterdb_commandlog_large_reply_by_pattern` | `COMMANDLOG` (Valkey 8.1+) |
| ACL audit | `betterdb_acl_denied`, `betterdb_acl_denied_by_user` | Persisted `ACL LOG` history |
| Anomaly detection | `betterdb_anomaly_events_total`, `betterdb_anomaly_by_severity` | BetterDB detectors |
| Vector search | `betterdb_vector_index_memory_bytes` | `FT.INFO` |

All metrics carry a `connection` label, so a single BetterDB instance monitoring multiple databases exports each family per connection. Node.js process metrics are included with the same `betterdb_` prefix.

## Scrape Config

```yaml
scrape_configs:
  - job_name: 'betterdb'
    static_configs:
      - targets: ['localhost:3001']
    metrics_path: '/api/prometheus/metrics'
    scrape_interval: 15s
```

## Useful Queries

```promql
# Cache hit ratio per connection
rate(betterdb_keyspace_hits_total[5m])
  / (rate(betterdb_keyspace_hits_total[5m]) + rate(betterdb_keyspace_misses_total[5m]))

# Memory utilization vs maxmemory
betterdb_memory_used_bytes / betterdb_memory_max_bytes > 0.9

# Hottest cluster slots by write volume
topk(10, rate(betterdb_cluster_slot_writes_total[5m]))

# Slowest command patterns
topk(5, betterdb_slowlog_pattern_avg_duration_us)

# Anomaly rate
rate(betterdb_anomaly_events_total[5m])

# Critical anomalies in last hour
betterdb_anomaly_by_severity{severity="critical"}
```

## Anomaly Metrics

Anomaly detection publishes precomputed signals alongside the raw metrics:

| Metric | Type | Labels |
|--------|------|--------|
| `betterdb_anomaly_events_total` | Counter | severity, metric_type, anomaly_type |
| `betterdb_anomaly_events_current` | Gauge | severity |
| `betterdb_anomaly_by_severity` | Gauge | severity |
| `betterdb_anomaly_by_metric` | Gauge | metric_type |
| `betterdb_correlated_groups_total` | Counter | pattern, severity |
| `betterdb_correlated_groups_by_pattern` | Gauge | pattern |
| `betterdb_anomaly_buffer_ready` | Gauge | metric_type |
| `betterdb_anomaly_buffer_mean` | Gauge | metric_type |
| `betterdb_anomaly_buffer_stddev` | Gauge | metric_type |

## Alert Rules

See `docs/alertmanager-rules.yml` for ready-to-use Alertmanager rules.

## Configuration

The anomaly summary update interval can be configured via `ANOMALY_PROMETHEUS_INTERVAL_MS` (default: 30000ms).
