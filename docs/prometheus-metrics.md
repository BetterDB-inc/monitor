---
title: Prometheus Metrics
nav_order: 3
---

# Prometheus Metrics Reference

Complete reference for all metrics exposed by BetterDB Monitor at the `/prometheus/metrics` endpoint.

## Table of Contents

- [Overview](#overview)
- [Metrics Categories](#metrics-categories)
  - [ACL Audit Metrics](#acl-audit-metrics)
  - [Client Analytics Metrics](#client-analytics-metrics)
  - [Slowlog Metrics](#slowlog-metrics)
  - [COMMANDLOG Metrics](#commandlog-metrics-valkey-81)
  - [Vector Index Metrics](#vector-index-metrics)
  - [Server Info Metrics](#server-info-metrics)
  - [Memory Metrics](#memory-metrics)
  - [Stats Metrics](#stats-metrics)
  - [CPU Metrics](#cpu-metrics)
  - [Replication Metrics](#replication-metrics)
  - [Keyspace Metrics](#keyspace-metrics)
  - [Cluster Metrics](#cluster-metrics)
  - [Anomaly Detection Metrics](#anomaly-detection-metrics)
  - [Internal Metrics](#internal-metrics)
  - [Node.js Process Metrics](#nodejs-process-metrics)
- [Scrape Configuration](#scrape-configuration)
- [Useful PromQL Queries](#useful-promql-queries)
- [Alertmanager Rules](#alertmanager-rules)

## Overview

BetterDB Monitor exposes Prometheus-compatible metrics at:

```
GET /prometheus/metrics
Content-Type: text/plain; version=0.0.4; charset=utf-8
```

All custom metrics are prefixed with `betterdb_`. Standard Node.js process metrics from `prom-client` are also included with the same prefix.

**Scrape Interval**: Recommended 15s
**Metrics Update**: Metrics are computed on-demand during each scrape

## Metrics Categories

### ACL Audit Metrics

Track ACL denied events captured from the monitored Valkey/Redis instance.

| Metric | Type | Labels | Description | Example |
|--------|------|--------|-------------|---------|
| `betterdb_acl_denied` | gauge | - | Total ACL denied events captured | `42` |
| `betterdb_acl_denied_by_reason` | gauge | `reason` | ACL denied events by reason (auth, command, key, channel) | `15` |
| `betterdb_acl_denied_by_user` | gauge | `username` | ACL denied events by username | `8` |

**Cardinality Warning**: `betterdb_acl_denied_by_user` cardinality scales with number of unique usernames experiencing failures.

### Client Analytics Metrics

Monitor client connection patterns and trends.

| Metric | Type | Labels | Description | Example |
|--------|------|--------|-------------|---------|
| `betterdb_client_connections_current` | gauge | - | Current number of client connections | `127` |
| `betterdb_client_connections_peak` | gauge | - | Peak connections in retention period | `256` |
| `betterdb_client_connections_by_name` | gauge | `client_name` | Current connections by client name | `12` |
| `betterdb_client_connections_by_user` | gauge | `user` | Current connections by ACL user | `25` |

**Cardinality Warning**: Label-based metrics scale with unique client names and usernames.

### Slowlog Metrics

Analyze slow query patterns aggregated from SLOWLOG data.

| Metric | Type | Labels | Description | Example |
|--------|------|--------|-------------|---------|
| `betterdb_slowlog_length` | gauge | - | Current slowlog length | `128` |
| `betterdb_slowlog_last_id` | gauge | - | ID of last slowlog entry | `12345` |
| `betterdb_slowlog_pattern_count` | gauge | `pattern` | Number of slow queries per pattern | `24` |
| `betterdb_slowlog_pattern_avg_duration_us` | gauge | `pattern` | Average duration in microseconds per pattern | `1250000` |
| `betterdb_slowlog_pattern_percentage` | gauge | `pattern` | Percentage of slow queries per pattern | `18.75` |

**Pattern Examples**: `GET *`, `HGETALL *`, `SCAN *`

### COMMANDLOG Metrics (Valkey 8.1+)

Valkey-specific metrics for tracking large request/reply commands.

| Metric | Type | Labels | Description | Example |
|--------|------|--------|-------------|---------|
| `betterdb_commandlog_large_request` | gauge | - | Total large request entries | `15` |
| `betterdb_commandlog_large_reply` | gauge | - | Total large reply entries | `8` |
| `betterdb_commandlog_large_request_by_pattern` | gauge | `pattern` | Large request count by command pattern | `5` |
| `betterdb_commandlog_large_reply_by_pattern` | gauge | `pattern` | Large reply count by command pattern | `3` |

**Availability**: Only populated when connected to Valkey 8.1+. Returns no data for Redis or older Valkey versions.

### Vector Index Metrics

Per-index health metrics for vector search indexes, populated by `VectorSearchService` every 30 s. Gauges are emitted once per `(connection, index)` pair, and stale labels are automatically removed when an index is dropped between polls.

| Metric | Type | Labels | Description | Example |
|--------|------|--------|-------------|---------|
| `betterdb_vector_index_docs` | gauge | `index` | Current document count for a vector index | `30000` |
| `betterdb_vector_index_memory_bytes` | gauge | `index` | Current memory usage for a vector index, in bytes | `62914560` |
| `betterdb_vector_index_indexing_failures` | gauge | `index` | Cumulative `hash_indexing_failures` for a vector index | `0` |
| `betterdb_vector_index_percent_indexed` | gauge | `index` | Percent of documents indexed (0–100) | `100` |

**Availability**: Only populated when connected to an instance with the Search module loaded (RediSearch or [`valkey-search`](https://github.com/valkey-io/valkey-search)). Returns no data otherwise. See [Vector / AI](vector-ai/README.md) for the feature overview and the REST endpoints that back the monitor UI.

**Cardinality Warning**: Label cardinality scales with the number of indexes per connection. Typical deployments have single-digit index counts; if you run hundreds of indexes per instance, monitor scrape size accordingly.

### Server Info Metrics

Basic server identification and uptime.

| Metric | Type | Labels | Description | Example |
|--------|------|--------|-------------|---------|
| `betterdb_uptime_in_seconds` | gauge | - | Server uptime in seconds | `864000` |
| `betterdb_instance_info` | gauge | `version`, `role`, `os` | Instance information (always 1) | `1` |

**Label Example**: `version="8.0.1"`, `role="master"`, `os="Linux 5.15.0"`

### Memory Metrics

Detailed memory usage and fragmentation tracking.

| Metric | Type | Labels | Description | Example |
|--------|------|--------|-------------|---------|
| `betterdb_memory_used_bytes` | gauge | - | Total allocated memory in bytes | `1073741824` |
| `betterdb_memory_used_rss_bytes` | gauge | - | RSS memory usage in bytes | `1200000000` |
| `betterdb_memory_used_peak_bytes` | gauge | - | Peak memory usage in bytes | `1500000000` |
| `betterdb_memory_max_bytes` | gauge | - | Maximum memory limit in bytes (0 if unlimited) | `2147483648` |
| `betterdb_memory_fragmentation_ratio` | gauge | - | Memory fragmentation ratio | `1.15` |
| `betterdb_memory_fragmentation_bytes` | gauge | - | Memory fragmentation in bytes | `126000000` |

### Stats Metrics

Operational statistics and throughput.

| Metric | Type | Labels | Description | Example |
|--------|------|--------|-------------|---------|
| `betterdb_connections_received_total` | gauge | - | Total connections received | `45678` |
| `betterdb_commands_processed_total` | gauge | - | Total commands processed | `12456789` |
| `betterdb_instantaneous_ops_per_sec` | gauge | - | Current operations per second | `2500` |
| `betterdb_instantaneous_input_kbps` | gauge | - | Current input kilobytes per second | `125.5` |
| `betterdb_instantaneous_output_kbps` | gauge | - | Current output kilobytes per second | `856.3` |
| `betterdb_keyspace_hits_total` | gauge | - | Total keyspace hits | `9876543` |
| `betterdb_keyspace_misses_total` | gauge | - | Total keyspace misses | `234567` |
| `betterdb_evicted_keys_total` | gauge | - | Total evicted keys | `1234` |
| `betterdb_expired_keys_total` | gauge | - | Total expired keys | `56789` |
| `betterdb_pubsub_channels` | gauge | - | Number of pub/sub channels | `12` |
| `betterdb_pubsub_patterns` | gauge | - | Number of pub/sub patterns | `3` |

### CPU Metrics

Server CPU consumption from the Valkey/Redis INFO CPU section.

| Metric | Type | Labels | Description | Example |
|--------|------|--------|-------------|---------|
| `betterdb_cpu_sys_seconds_total` | gauge | `connection` | Cumulative system CPU time consumed by the server in seconds | `123.45` |
| `betterdb_cpu_user_seconds_total` | gauge | `connection` | Cumulative user CPU time consumed by the server in seconds | `456.78` |

**System vs User CPU**

`cpu_sys_seconds_total` tracks time the CPU spent in kernel space on behalf of the Valkey process - network I/O syscalls, memory allocation, and other OS-level operations. `cpu_user_seconds_total` tracks time spent executing Valkey's own code in userspace - command processing, data structure operations, Lua scripts, and so on.

For a lightly loaded instance, system CPU is typically higher than user because most work is network I/O. A spike in user CPU points to CPU-intensive commands (large `SORT` operations, complex Lua scripts, big key scans). A spike in system CPU points to network or memory pressure.

**Note**: These are cumulative counters exposed as gauges. Use `rate()` in PromQL to compute per-second CPU usage.

### Replication Metrics

Replication status and offset tracking.

| Metric | Type | Labels | Description | Example |
|--------|------|--------|-------------|---------|
| `betterdb_connected_slaves` | gauge | - | Number of connected replicas | `2` |
| `betterdb_replication_offset` | gauge | - | Replication offset | `123456789` |
| `betterdb_master_link_up` | gauge | - | 1 if link to master is up (replica only) | `1` |
| `betterdb_master_last_io_seconds_ago` | gauge | - | Seconds since last I/O with master (replica only) | `2` |

### Keyspace Metrics

Per-database key statistics.

| Metric | Type | Labels | Description | Example |
|--------|------|--------|-------------|---------|
| `betterdb_db_keys` | gauge | `db` | Total keys in database | `125000` |
| `betterdb_db_keys_expiring` | gauge | `db` | Keys with expiration in database | `45000` |
| `betterdb_db_avg_ttl_seconds` | gauge | `db` | Average TTL in seconds | `3600` |

**Label Example**: `db="db0"`, `db="db1"`

### Cluster Metrics

Cluster mode health and slot distribution.

| Metric | Type | Labels | Description | Example |
|--------|------|--------|-------------|---------|
| `betterdb_cluster_enabled` | gauge | - | 1 if cluster mode is enabled | `1` |
| `betterdb_cluster_known_nodes` | gauge | - | Number of known cluster nodes | `6` |
| `betterdb_cluster_size` | gauge | - | Number of master nodes in cluster | `3` |
| `betterdb_cluster_slots_assigned` | gauge | - | Number of assigned slots | `16384` |
| `betterdb_cluster_slots_ok` | gauge | - | Number of slots in OK state | `16384` |
| `betterdb_cluster_slots_fail` | gauge | - | Number of slots in FAIL state | `0` |
| `betterdb_cluster_slots_pfail` | gauge | - | Number of slots in PFAIL state | `0` |

#### Cluster Slot Metrics (Valkey 8.0+)

| Metric | Type | Labels | Description | Example |
|--------|------|--------|-------------|---------|
| `betterdb_cluster_slot_keys` | gauge | `slot` | Keys in cluster slot | `512` |
| `betterdb_cluster_slot_expires` | gauge | `slot` | Expiring keys in cluster slot | `128` |
| `betterdb_cluster_slot_reads_total` | gauge | `slot` | Total reads for cluster slot | `45678` |
| `betterdb_cluster_slot_writes_total` | gauge | `slot` | Total writes for cluster slot | `12345` |

**Availability**: Only populated when connected to Valkey 8.0+ cluster. Limited to top 100 slots by key count.

### Anomaly Detection Metrics

Real-time anomaly detection system metrics.

#### Event Metrics

| Metric | Type | Labels | Description | Example |
|--------|------|--------|-------------|---------|
| `betterdb_anomaly_events_total` | counter | `severity`, `metric_type`, `anomaly_type` | Total anomaly events detected | `42` |
| `betterdb_anomaly_events_current` | gauge | `severity` | Unresolved anomalies by severity | `3` |
| `betterdb_anomaly_by_severity` | gauge | `severity` | Anomalies in last hour by severity | `12` |
| `betterdb_anomaly_by_metric` | gauge | `metric_type` | Anomalies in last hour by metric | `8` |

**Label Values**:
- `severity`: `info`, `warning`, `critical`
- `metric_type`: `connections`, `ops_per_sec`, `memory_used`, `input_kbps`, `output_kbps`, `slowlog_last_id`, `acl_denied`, `evicted_keys`, `blocked_clients`, `keyspace_misses`, `fragmentation_ratio`, `cpu_utilization`, `replication_role`
- `anomaly_type`: `spike`, `drop`

#### Correlation Metrics

| Metric | Type | Labels | Description | Example |
|--------|------|--------|-------------|---------|
| `betterdb_correlated_groups_total` | counter | `pattern`, `severity` | Total correlated anomaly groups | `15` |
| `betterdb_correlated_groups_by_severity` | gauge | `severity` | Groups in last hour by severity | `8` |
| `betterdb_correlated_groups_by_pattern` | gauge | `pattern` | Groups in last hour by pattern | `5` |

**Pattern Values**: `traffic_burst`, `batch_job`, `memory_pressure`, `slow_queries`, `auth_attack`, `connection_leak`, `cache_thrashing`, `node_failover`, `unknown`

#### Buffer Stats Metrics

| Metric | Type | Labels | Description | Example |
|--------|------|--------|-------------|---------|
| `betterdb_anomaly_buffer_ready` | gauge | `metric_type` | Buffer ready state (1=ready, 0=warming) | `1` |
| `betterdb_anomaly_buffer_mean` | gauge | `metric_type` | Rolling mean for anomaly detection | `2450` |
| `betterdb_anomaly_buffer_stddev` | gauge | `metric_type` | Rolling stddev for anomaly detection | `125.5` |

### Internal Metrics

BetterDB Monitor application health metrics.

| Metric | Type | Labels | Description | Example |
|--------|------|--------|-------------|---------|
| `betterdb_polls_total` | counter | - | Total number of poll cycles completed | `123456` |
| `betterdb_poll_duration_seconds` | histogram | `service` | Duration of poll cycles in seconds | buckets: 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10 |

**Service Values**: Names of polling services (audit, client-analytics, metrics, etc.)

### Node.js Process Metrics

Standard process metrics provided by `prom-client` with `betterdb_` prefix.

#### CPU & Memory

| Metric | Type | Description |
|--------|------|-------------|
| `betterdb_process_cpu_user_seconds_total` | counter | Total user CPU time spent in seconds |
| `betterdb_process_cpu_system_seconds_total` | counter | Total system CPU time spent in seconds |
| `betterdb_process_cpu_seconds_total` | counter | Total user and system CPU time spent in seconds |
| `betterdb_process_resident_memory_bytes` | gauge | Resident memory size in bytes |
| `betterdb_process_virtual_memory_bytes` | gauge | Virtual memory size in bytes |
| `betterdb_process_heap_bytes` | gauge | Process heap size in bytes |

#### File Descriptors

| Metric | Type | Description |
|--------|------|-------------|
| `betterdb_process_open_fds` | gauge | Number of open file descriptors |
| `betterdb_process_max_fds` | gauge | Maximum number of open file descriptors |

#### Event Loop

| Metric | Type | Description |
|--------|------|-------------|
| `betterdb_nodejs_eventloop_lag_seconds` | gauge | Lag of event loop in seconds |
| `betterdb_nodejs_eventloop_lag_min_seconds` | gauge | Minimum recorded event loop delay |
| `betterdb_nodejs_eventloop_lag_max_seconds` | gauge | Maximum recorded event loop delay |
| `betterdb_nodejs_eventloop_lag_mean_seconds` | gauge | Mean of recorded event loop delays |
| `betterdb_nodejs_eventloop_lag_stddev_seconds` | gauge | Standard deviation of recorded event loop delays |
| `betterdb_nodejs_eventloop_lag_p50_seconds` | gauge | 50th percentile of recorded event loop delays |
| `betterdb_nodejs_eventloop_lag_p90_seconds` | gauge | 90th percentile of recorded event loop delays |
| `betterdb_nodejs_eventloop_lag_p99_seconds` | gauge | 99th percentile of recorded event loop delays |

#### Heap & GC

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `betterdb_nodejs_heap_size_total_bytes` | gauge | - | Process heap size from Node.js in bytes |
| `betterdb_nodejs_heap_size_used_bytes` | gauge | - | Process heap size used from Node.js in bytes |
| `betterdb_nodejs_external_memory_bytes` | gauge | - | Node.js external memory size in bytes |
| `betterdb_nodejs_heap_space_size_total_bytes` | gauge | `space` | Process heap space size total in bytes |
| `betterdb_nodejs_heap_space_size_used_bytes` | gauge | `space` | Process heap space size used in bytes |
| `betterdb_nodejs_heap_space_size_available_bytes` | gauge | `space` | Process heap space size available in bytes |
| `betterdb_nodejs_gc_duration_seconds` | histogram | `kind` | Garbage collection duration (major, minor, incremental, weakcb) |

## Scrape Configuration

### Basic Prometheus Configuration

```yaml
scrape_configs:
  - job_name: 'betterdb'
    static_configs:
      - targets: ['localhost:3001']
    metrics_path: '/prometheus/metrics'
    scrape_interval: 15s
    scrape_timeout: 10s
```

### Multi-Instance Setup

```yaml
scrape_configs:
  - job_name: 'betterdb'
    static_configs:
      - targets:
        - 'betterdb-prod-1:3001'
        - 'betterdb-prod-2:3001'
        - 'betterdb-staging:3001'
        labels:
          env: 'production'
    metrics_path: '/prometheus/metrics'
    scrape_interval: 15s
```

### With Service Discovery (Kubernetes)

```yaml
scrape_configs:
  - job_name: 'betterdb'
    kubernetes_sd_configs:
      - role: pod
    relabel_configs:
      - source_labels: [__meta_kubernetes_pod_label_app]
        action: keep
        regex: betterdb-monitor
      - source_labels: [__meta_kubernetes_pod_ip]
        action: replace
        target_label: __address__
        replacement: '${1}:3001'
    metrics_path: '/prometheus/metrics'
    scrape_interval: 15s
```

## Useful PromQL Queries

### Anomaly Detection

```promql
# Anomaly detection rate (events per minute)
rate(betterdb_anomaly_events_total[5m]) * 60

# Critical anomalies in last hour
betterdb_anomaly_by_severity{severity="critical"}

# Detection system readiness percentage
sum(betterdb_anomaly_buffer_ready) / count(betterdb_anomaly_buffer_ready) * 100

# Memory pressure incidents in last hour
increase(betterdb_correlated_groups_total{pattern="memory_pressure"}[1h])

# Top metrics causing anomalies
topk(5, betterdb_anomaly_by_metric)

# Unresolved critical anomalies
betterdb_anomaly_events_current{severity="critical"}
```

### CPU Utilization

```promql
# Per-second CPU usage (system + user combined)
rate(betterdb_cpu_sys_seconds_total[5m]) + rate(betterdb_cpu_user_seconds_total[5m])

# System vs user CPU breakdown
rate(betterdb_cpu_sys_seconds_total[5m])
rate(betterdb_cpu_user_seconds_total[5m])
```

### Memory & Performance

```promql
# Memory usage percentage (if maxmemory is set)
(betterdb_memory_used_bytes / betterdb_memory_max_bytes) * 100

# Memory fragmentation ratio (alert if > 1.5)
betterdb_memory_fragmentation_ratio

# Cache hit rate percentage
(betterdb_keyspace_hits_total / (betterdb_keyspace_hits_total + betterdb_keyspace_misses_total)) * 100

# Operations per second trend
rate(betterdb_commands_processed_total[5m])

# Network throughput (combined input + output)
betterdb_instantaneous_input_kbps + betterdb_instantaneous_output_kbps
```

### Client Analytics

```promql
# Connection growth rate
rate(betterdb_connections_received_total[5m])

# Current connection count by user
sum by (user) (betterdb_client_connections_by_user)

# Peak vs current connections
betterdb_client_connections_peak - betterdb_client_connections_current
```

### Slowlog Analysis

```promql
# Top 5 slow query patterns
topk(5, betterdb_slowlog_pattern_count)

# Slowest query patterns by average duration
topk(5, betterdb_slowlog_pattern_avg_duration_us)

# Slowlog growth rate
rate(betterdb_slowlog_length[5m])
```

### Cluster Health

```promql
# Cluster slot health percentage
(betterdb_cluster_slots_ok / betterdb_cluster_slots_assigned) * 100

# Failed slots alert
betterdb_cluster_slots_fail + betterdb_cluster_slots_pfail

# Replication lag (for replicas)
betterdb_master_last_io_seconds_ago
```

### Application Health

```promql
# BetterDB Monitor event loop lag (alert if > 100ms)
betterdb_nodejs_eventloop_lag_p99_seconds > 0.1

# Poll duration 99th percentile
histogram_quantile(0.99, rate(betterdb_poll_duration_seconds_bucket[5m]))

# High cardinality metric check (client names)
count(betterdb_client_connections_by_name)
```

## Alertmanager Rules

The following alert rules are production-ready. See `docs/alertmanager-rules.yml` for the complete YAML configuration.

### Critical Alerts

**BetterDBCriticalAnomaly** - Fires immediately when a critical anomaly is detected
```promql
increase(betterdb_anomaly_events_total{severity="critical"}[5m]) > 0
```

**BetterDBMemoryPressure** - Memory pressure pattern detected
```promql
increase(betterdb_correlated_groups_total{pattern="memory_pressure"}[10m]) > 0
```

**BetterDBAuthAnomaly** - Potential authentication attack
```promql
increase(betterdb_correlated_groups_total{pattern="auth_attack"}[5m]) > 0
```

### Warning Alerts

**BetterDBWarningSpike** - Multiple warning anomalies in short period
```promql
increase(betterdb_anomaly_events_total{severity="warning"}[5m]) > 5
```

**BetterDBConnectionLeak** - Possible connection leak pattern
```promql
increase(betterdb_correlated_groups_total{pattern="connection_leak"}[10m]) > 0
for: 5m
```

**BetterDBTrafficBurst** - Traffic burst detected
```promql
increase(betterdb_correlated_groups_total{pattern="traffic_burst"}[5m]) > 0
```

**BetterDBUnresolvedCriticalAnomalies** - Multiple unresolved critical anomalies
```promql
betterdb_anomaly_events_current{severity="critical"} > 3
for: 10m
```

**BetterDBPersistentAnomalies** - Persistent anomalies over time
```promql
betterdb_anomaly_by_severity{severity!="info"} > 10
for: 30m
```

### Info Alerts

**BetterDBAnomalyDetectionWarming** - Anomaly detection system warming up
```promql
(sum(betterdb_anomaly_buffer_ready) / count(betterdb_anomaly_buffer_ready)) < 1
for: 5m
```

## Grafana Integration

### Import Ready-Made Dashboard

1. Navigate to Grafana → Dashboards → Import
2. Use BetterDB Monitor dashboard ID: `[Coming Soon]`
3. Select your Prometheus datasource
4. Click Import

### Creating Custom Dashboards

**Recommended Panels**:

1. **Anomaly Overview** - Gauge showing unresolved critical anomalies
2. **Anomaly Timeline** - Graph of `rate(betterdb_anomaly_events_total[5m])` by severity
3. **Pattern Detection** - Bar chart of `betterdb_correlated_groups_by_pattern`
4. **Memory Usage** - Graph showing `betterdb_memory_used_bytes` vs `betterdb_memory_max_bytes`
5. **Cache Hit Rate** - Graph showing cache hit rate percentage
6. **Connection Trends** - Graph of `betterdb_client_connections_current` and peak
7. **Slow Query Patterns** - Table showing top patterns from `betterdb_slowlog_pattern_*`
8. **Buffer Readiness** - Heatmap of `betterdb_anomaly_buffer_ready` by metric type

### Example Panel Query (Memory Usage)

```json
{
  "expr": "betterdb_memory_used_bytes",
  "legendFormat": "Used Memory",
  "refId": "A"
},
{
  "expr": "betterdb_memory_max_bytes",
  "legendFormat": "Max Memory",
  "refId": "B"
}
```

## Configuration

### Metrics Update Interval

The anomaly detection Prometheus summary is updated every 30 seconds by default. Configure via:

```bash
ANOMALY_PROMETHEUS_INTERVAL_MS=30000
```

Or update at runtime via the `/settings` API endpoint:

```bash
curl -X PUT http://localhost:3001/settings \
  -H "Content-Type: application/json" \
  -d '{"anomalyPrometheusIntervalMs": 15000}'
```

### Cardinality Management

High-cardinality labels can impact Prometheus performance. Monitor these metrics:

- `betterdb_client_connections_by_name` - Scales with unique client names
- `betterdb_client_connections_by_user` - Scales with unique usernames
- `betterdb_cluster_slot_*` - Limited to top 100 slots automatically

If cardinality becomes an issue, consider:
- Aggregating client names using `relabel_configs` in Prometheus
- Filtering specific labels using `metric_relabel_configs`
- Reducing retention period for client analytics data

## Troubleshooting

### Missing Metrics

**COMMANDLOG metrics not appearing?**
- Check Valkey version: Requires Valkey 8.1+
- Verify connection: Ensure BetterDB is connected to Valkey (not Redis)

**Cluster slot metrics not appearing?**
- Check Valkey version: Requires Valkey 8.0+
- Verify cluster mode: Ensure the instance is in cluster mode

**Anomaly metrics showing zeros?**
- Wait for warmup: Anomaly detection requires 30 samples (30 seconds at 1s poll rate)
- Check buffer readiness: Query `betterdb_anomaly_buffer_ready`

### High Scrape Duration

If `/prometheus/metrics` takes >1s to respond:
- Reduce slowlog analysis sample size (default: 128 entries)
- Reduce cluster slot stats limit (default: 100 slots)
- Increase scrape timeout in Prometheus config
- Check if database is responding slowly

### Stale Metrics

If metrics appear outdated:
- Verify BetterDB Monitor is running: Check `betterdb_process_start_time_seconds`
- Check database connectivity: Review `/health` endpoint
- Verify polling services: Check `betterdb_polls_total` is incrementing
