---
title: Prometheus Metrics
nav_order: 3
---

# Prometheus Metrics Reference

Complete reference for all metrics exposed by BetterDB Monitor at the `/api/prometheus/metrics` endpoint.

## Table of Contents

- [Overview](#overview)
- [Export Profiles](#export-profiles)
- [Cardinality Contract](#cardinality-contract)
- [Metrics Categories](#metrics-categories)
  - [ACL Audit Metrics](#acl-audit-metrics)
  - [Client Analytics Metrics](#client-analytics-metrics)
  - [Slowlog Metrics](#slowlog-metrics)
  - [COMMANDLOG Metrics](#commandlog-metrics-valkey-81)
  - [Vector Index Metrics](#vector-index-metrics)
  - [Commandstats Metrics](#commandstats-metrics)
  - [Inference Latency Metrics](#inference-latency-metrics)
  - [Server Info Metrics](#server-info-metrics)
  - [Memory Metrics](#memory-metrics)
  - [Stats Metrics](#stats-metrics)
  - [CPU Metrics](#cpu-metrics)
  - [Replication Metrics](#replication-metrics)
  - [Keyspace Metrics](#keyspace-metrics)
  - [Persistence Metrics](#persistence-metrics)
  - [Cluster Metrics](#cluster-metrics)
  - [Anomaly Detection Metrics](#anomaly-detection-metrics)
  - [Metric Forecasting Metrics](#metric-forecasting-metrics)
  - [Internal Metrics](#internal-metrics)
  - [Node.js Process Metrics](#nodejs-process-metrics)
- [Scrape Configuration](#scrape-configuration)
- [Useful PromQL Queries](#useful-promql-queries)
- [Alertmanager Rules](#alertmanager-rules)

## Overview

BetterDB Monitor exposes Prometheus-compatible metrics at:

```
GET /api/prometheus/metrics
Content-Type: text/plain; version=0.0.4; charset=utf-8
```

All custom metrics are prefixed with `betterdb_`. Standard Node.js process metrics from `prom-client` are also included with the same prefix.

**Scrape Interval**: Recommended 15s
**Metrics Update**: Metrics are computed on-demand during each scrape

## Export Profiles

`METRICS_EXPORT_PROFILE` controls how much of the metric surface below is exported:

- `full` (default) — every metric in this reference is exported.
- `vitals` — a fixed set of series per connection: no per-db, per-slot, or pattern-labelled series. Cardinality stays flat regardless of key count, database count, or cluster size.

Both the scrape endpoint (`/api/prometheus/metrics`) and the OTLP mirror honour the profile — whichever families `vitals` allows are what both exporters emit.

`vitals` only reduces what is exported: storage-backed collectors (ACL, client, slowlog/commandlog patterns, commandstats) and per-db series are still collected on each scrape, so it lowers series count, not scrape cost.

| Connection type    | Series per connection (`vitals`) |
| ------------------ | -------------------------------- |
| Standalone primary | 33                               |
| Standalone replica | 34                               |
| Cluster primary    | 39                               |
| Cluster replica    | 40                               |

These counts assume the instance reports every `INFO` section. A managed provider that withholds `# Keyspace` or `# Persistence` yields that many series minus the withheld families — the gauges are omitted rather than reported as `0`, so a stripped section never reads as an emptied keyspace or a failed background save. The replication gauges follow the reported role: `betterdb_connected_slaves` for a primary, `betterdb_master_link_up` and `betterdb_master_last_io_seconds_ago` for a replica, and none of the three when the role is missing or unrecognised.

BetterDB's own Node.js process metrics (`betterdb_process_*`, `betterdb_nodejs_*`) are added once per BetterDB instance in both profiles.

`vitals` exports these families:

- Server: `betterdb_uptime_in_seconds`, `betterdb_instance_info`
- Clients: `betterdb_connected_clients`, `betterdb_blocked_clients`, `betterdb_tracking_clients`
- Memory: `betterdb_memory_used_bytes`, `betterdb_memory_used_rss_bytes`, `betterdb_memory_used_peak_bytes`, `betterdb_memory_max_bytes`, `betterdb_memory_fragmentation_ratio`, `betterdb_memory_fragmentation_bytes`
- Stats: `betterdb_connections_received_total`, `betterdb_commands_processed_total`, `betterdb_instantaneous_ops_per_sec`, `betterdb_instantaneous_input_kbps`, `betterdb_instantaneous_output_kbps`, `betterdb_keyspace_hits_total`, `betterdb_keyspace_misses_total`, `betterdb_evicted_keys_total`, `betterdb_expired_keys_total`
- CPU: `betterdb_cpu_sys_seconds_total`, `betterdb_cpu_user_seconds_total`
- Keyspace totals: `betterdb_keyspace_keys`, `betterdb_keyspace_keys_expiring`
- Persistence: `betterdb_rdb_changes_since_last_save`, `betterdb_rdb_last_save_timestamp_seconds`, `betterdb_rdb_last_bgsave_ok`, `betterdb_aof_enabled`, `betterdb_aof_last_bgrewrite_ok`
- Replication: `betterdb_connected_slaves`, `betterdb_replication_offset`, `betterdb_master_link_up`, `betterdb_master_last_io_seconds_ago`
- Cluster health: `betterdb_cluster_enabled`, `betterdb_cluster_known_nodes`, `betterdb_cluster_size`, `betterdb_cluster_slots_assigned`, `betterdb_cluster_slots_ok`, `betterdb_cluster_slots_fail`, `betterdb_cluster_slots_pfail`
- `betterdb_poll_stale`

See [Configuration Reference](configuration.md#prometheus-metrics) for the `METRICS_EXPORT_PROFILE` and `METRICS_SLOT_STATS_TOP_N` env vars.

## Cardinality Contract

This section states how many series a scrape can hold, so you can size Prometheus before you add connections. Every series except the Node.js process metrics carries a `connection` label. The total is therefore a fixed instance overhead plus a budget per connection.

```
total = P + A + Σ over connections (F + V)
```

- `P`: process metrics, paid once per BetterDB instance.
- `A`: the anomaly summary, paid once per instance under `full`.
- `F`: the fixed series for the connection's type and profile.
- `V`: the variable series. Under `vitals` this is always 0.

The OTLP mirror exports the same series as the scrape, so the same budget applies to both.

### Instance overhead

| Source                                                              | Series                                                                        | Profile |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------- |
| Node.js process metrics (`betterdb_process_*`, `betterdb_nodejs_*`) | about 55 on Node 22. The count shifts slightly with heap spaces and GC kinds. | both    |
| Anomaly summary and baseline buffers                                | up to 181, while anomaly detection runs                                       | `full`  |

The anomaly summary and buffer gauges are published once per instance under the default connection's label, not once per connection. Their bounds:

| Gauges                                                                                                      | Label               | Bound         | Series |
| ----------------------------------------------------------------------------------------------------------- | ------------------- | ------------- | ------ |
| `betterdb_anomaly_events_current`, `betterdb_anomaly_by_severity`, `betterdb_correlated_groups_by_severity` | severity            | 3 values each | 9      |
| `betterdb_anomaly_by_metric`                                                                                | metric type         | 40            | 40     |
| `betterdb_correlated_groups_by_pattern`                                                                     | correlation pattern | 12            | 12     |
| the three `betterdb_anomaly_buffer_*` gauges                                                                | metric type         | 40 each       | 120    |

Total: 9 + 40 + 12 + 120 = 181.

### Fixed series per connection (`F`)

| Connection type    | `vitals` | `full` |
| ------------------ | -------- | ------ |
| Standalone primary | 33       | 73     |
| Standalone replica | 34       | 74     |
| Cluster primary    | 39       | 80     |
| Cluster replica    | 40       | 81     |

The `vitals` column is the budget from [Export Profiles](#export-profiles).

The `full` column starts from the INFO-derived series: the `vitals` families plus `betterdb_pubsub_channels` and `betterdb_pubsub_patterns`. That gives 35, 36, 41 and 42 series. Each family below then adds its series once its collector has data. The `full` column is the ceiling with every one of them present:

| Family                                                                                   | Series | Present when                                                                                    |
| ---------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------- |
| `betterdb_acl_denied`                                                                    | 1      | ACL audit data is stored                                                                        |
| `betterdb_client_connections_current`, `betterdb_client_connections_peak`                | 2      | client snapshots are stored                                                                     |
| `betterdb_slowlog_length`, `betterdb_slowlog_last_id`                                    | 2      | the slowlog is readable                                                                         |
| `betterdb_commandlog_large_request`, `betterdb_commandlog_large_reply`                   | 2      | the server supports COMMANDLOG (Valkey 8.1+)                                                    |
| `betterdb_cluster_stats_messages_crc_mismatch`                                           | 1      | cluster mode, when the server reports it                                                        |
| `betterdb_cve_findings` (4 severities), `betterdb_cve_kev`, `betterdb_cve_dataset_stale` | 6      | a CVE scan has run for the connection                                                           |
| `betterdb_polls_total`                                                                   | 1      | always                                                                                          |
| `betterdb_poll_duration_seconds`                                                         | 24     | 2 services (`audit`, `client-analytics`) × 12 series each (9 buckets, `+Inf`, `_sum`, `_count`) |

Under `vitals`, none of these families are exported, and neither are the counters or the histogram.

### Variable series per connection (`V`, `full` only)

A family marked **removed** tracks only its current label values: a value that disappears loses its series. A family marked **zeroed** instead holds a series at `0` for every value it has seen since BetterDB started. A zeroed family therefore grows until one of these happens:

- the process restarts
- the connection is removed
- the connection goes stale (see [Internal Metrics](#internal-metrics))

| Family                                                                                       | Series       | What bounds it                                                                                                                                                 | Stale values |
| -------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `betterdb_db_keys`, `betterdb_db_keys_expiring`, `betterdb_db_avg_ttl_seconds`               | 3 × D        | D is the number of databases that have held keys. It cannot exceed the server's `databases` setting (default 16). In cluster mode this is normally just `db0`. | zeroed       |
| `betterdb_cluster_slot_keys`, `_expires`, `_reads_total`, `_writes_total`                    | 4 × N        | N is `METRICS_SLOT_STATS_TOP_N` (default 100, maximum 16384). Only cluster connections on Valkey 8.0+ emit these.                                              | removed      |
| `betterdb_commandstats_calls_total`, `betterdb_commandstats_latency_us`                      | 2 × C        | C is the number of commands with at least one call. The command table (with any module commands) caps it; typically a few dozen.                               | removed      |
| `betterdb_repl_output_buffer_ratio`                                                          | R            | R is the number of connected replicas.                                                                                                                         | removed      |
| `betterdb_vector_index_docs`, `_memory_bytes`, `_indexing_failures`, `_percent_indexed`      | 4 × I        | I is the number of search indexes.                                                                                                                             | removed      |
| `betterdb_inference_bucket_p50_us`, `_p95_us`, `_p99_us`, `betterdb_inference_unhealthy`     | 4 × (2 + I′) | One `read` bucket, one `write` bucket, and one `FT.SEARCH:<index>` bucket for each of the I′ indexes that appear in the slowlog or COMMANDLOG window.          | removed      |
| `betterdb_inference_sla_breach`                                                              | ≤ I          | One per index with an SLA configured.                                                                                                                          | removed      |
| `betterdb_metric_forecast_time_to_limit_seconds`                                             | ≤ 4          | The four forecast metric kinds.                                                                                                                                | removed      |
| `betterdb_acl_denied_by_reason`                                                              | ≤ 4          | The ACL LOG reasons: `auth`, `command`, `key`, `channel`.                                                                                                      | zeroed       |
| `betterdb_acl_denied_by_user`                                                                | U            | Distinct usernames in retained ACL audit history.                                                                                                              | zeroed       |
| `betterdb_client_connections_by_name`, `betterdb_client_connections_by_user`                 | K + L        | Distinct client names (K) and users (L) in retained client-snapshot history.                                                                                   | zeroed       |
| `betterdb_slowlog_pattern_count`, `_avg_duration_us`, `_percentage`                          | 3 × S        | S is the number of distinct command/key patterns. Each poll reads the latest 128 slowlog entries.                                                              | zeroed       |
| `betterdb_commandlog_large_request_by_pattern`, `betterdb_commandlog_large_reply_by_pattern` | Q + Q′       | Distinct patterns in the latest 128 entries of each COMMANDLOG type.                                                                                           | zeroed       |
| `betterdb_anomaly_events_total` (counter)                                                    | ≤ 240        | 3 severities × 40 metric types × 2 anomaly types.                                                                                                              | counter      |
| `betterdb_correlated_groups_total` (counter)                                                 | ≤ 36         | 12 correlation patterns × 3 severities.                                                                                                                        | counter      |

Patterns are fingerprinted before they become label values. Each key segment is split on `:` or `/`. A segment that is numeric, a UUID, an alphanumeric token of 20 or more characters, or a hex string of 6 or more characters becomes `*`. So `user:1234:profile` and `user:9876:profile` share the pattern `GET user:*:profile`.

### Worst cases

- **Full slot coverage.** With `METRICS_SLOT_STATS_TOP_N=16384`, one cluster connection exports 65,536 slot series. At the default of 100 it exports at most 400.
- **Pattern churn.** Fingerprinting does not catch short, non-hex dynamic segments such as `session:ab12x` or `user:alice`. Each distinct key then becomes its own pattern. A workload like this can add up to 128 new slowlog patterns per poll. On servers with COMMANDLOG (Valkey 8.1+) it can also add up to 128 new large-request and 128 new large-reply patterns per poll. Because the pattern families are zeroed rather than removed, over the process lifetime they are bounded only by the number of distinct keys that reach the slowlog or COMMANDLOG. The client-name and ACL-username families behave the same way when names are generated per session.
- **Many databases.** A standalone server that uses all 16 databases adds 48 per-db series.

If a worst case applies, use one of these:

- Switch to `METRICS_EXPORT_PROFILE=vitals`, which drops every variable family.
- Lower `METRICS_SLOT_STATS_TOP_N`.
- Drop the pattern families with `metric_relabel_configs`.

### Worked example

This example uses `full` with 5 standalone primaries and 2 cluster primaries, assuming each connection has:

- 2 populated databases for a standalone primary, or `db0` only for a cluster primary
- default `METRICS_SLOT_STATS_TOP_N` (100)
- 40 active commands
- no search indexes
- 20 slowlog patterns
- 10 large-request and 10 large-reply patterns
- 5 client names, 2 client users and 1 denied ACL user
- all 4 ACL reasons
- 4 forecasts
- no anomaly events

| Term                | Standalone primary | Cluster primary |
| ------------------- | ------------------ | --------------- |
| `F`                 | 73                 | 80              |
| Per-db              | 6                  | 3               |
| Slot stats          | 0                  | 400             |
| Commandstats        | 80                 | 80              |
| Inference latency   | 8                  | 8               |
| Forecast            | 4                  | 4               |
| Slowlog patterns    | 60                 | 60              |
| COMMANDLOG patterns | 20                 | 20              |
| Client name/user    | 7                  | 7               |
| ACL reason/user     | 5                  | 5               |
| **Per connection**  | **263**            | **667**         |

The total with `full` is 55 + 5 × 263 + 2 × 667 = **2,704 series**. Add up to 181 more while anomaly detection runs.

The same fleet under `vitals` exports 55 + 5 × 33 + 2 × 39 = **298 series**, and that number does not change with key count, database count, pattern churn or cluster size.

## Metrics Categories

### ACL Audit Metrics

Track ACL denied events captured from the monitored Valkey/Redis instance.

| Metric                          | Type  | Labels     | Description                                               | Example |
| ------------------------------- | ----- | ---------- | --------------------------------------------------------- | ------- |
| `betterdb_acl_denied`           | gauge | -          | Total ACL denied events captured                          | `42`    |
| `betterdb_acl_denied_by_reason` | gauge | `reason`   | ACL denied events by reason (auth, command, key, channel) | `15`    |
| `betterdb_acl_denied_by_user`   | gauge | `username` | ACL denied events by username                             | `8`     |

**Cardinality Warning**: `betterdb_acl_denied_by_user` cardinality scales with number of unique usernames experiencing failures.

### Client Analytics Metrics

Monitor client connection patterns and trends.

| Metric                                | Type  | Labels        | Description                                      | Example |
| ------------------------------------- | ----- | ------------- | ------------------------------------------------ | ------- |
| `betterdb_client_connections_current` | gauge | -             | Current number of client connections             | `127`   |
| `betterdb_client_connections_peak`    | gauge | -             | Peak connections in retention period             | `256`   |
| `betterdb_client_connections_by_name` | gauge | `client_name` | Current connections by client name               | `12`    |
| `betterdb_client_connections_by_user` | gauge | `user`        | Current connections by ACL user                  | `25`    |
| `betterdb_connected_clients`          | gauge | -             | Number of client connections (from INFO clients) | `127`   |
| `betterdb_blocked_clients`            | gauge | -             | Clients blocked on BLPOP, BRPOP, etc             | `2`     |
| `betterdb_tracking_clients`           | gauge | -             | Clients being tracked for client-side caching    | `5`     |

**Cardinality Warning**: Label-based metrics scale with unique client names and usernames.

### Slowlog Metrics

Analyze slow query patterns aggregated from SLOWLOG data.

| Metric                                     | Type  | Labels    | Description                                  | Example   |
| ------------------------------------------ | ----- | --------- | -------------------------------------------- | --------- |
| `betterdb_slowlog_length`                  | gauge | -         | Current slowlog length                       | `128`     |
| `betterdb_slowlog_last_id`                 | gauge | -         | ID of last slowlog entry                     | `12345`   |
| `betterdb_slowlog_pattern_count`           | gauge | `pattern` | Number of slow queries per pattern           | `24`      |
| `betterdb_slowlog_pattern_avg_duration_us` | gauge | `pattern` | Average duration in microseconds per pattern | `1250000` |
| `betterdb_slowlog_pattern_percentage`      | gauge | `pattern` | Percentage of slow queries per pattern       | `18.75`   |

**Pattern Examples**: `GET *`, `HGETALL *`, `SCAN *`

### COMMANDLOG Metrics (Valkey 8.1+)

Valkey-specific metrics for tracking large request/reply commands.

| Metric                                         | Type  | Labels    | Description                            | Example |
| ---------------------------------------------- | ----- | --------- | -------------------------------------- | ------- |
| `betterdb_commandlog_large_request`            | gauge | -         | Total large request entries            | `15`    |
| `betterdb_commandlog_large_reply`              | gauge | -         | Total large reply entries              | `8`     |
| `betterdb_commandlog_large_request_by_pattern` | gauge | `pattern` | Large request count by command pattern | `5`     |
| `betterdb_commandlog_large_reply_by_pattern`   | gauge | `pattern` | Large reply count by command pattern   | `3`     |

**Availability**: Only populated when connected to Valkey 8.1+. Returns no data for Redis or older Valkey versions.

### Vector Index Metrics

Per-index health metrics for vector search indexes, populated by `VectorSearchService` every 30 s. Gauges are emitted once per `(connection, index)` pair, and stale labels are automatically removed when an index is dropped between polls.

| Metric                                    | Type  | Labels  | Description                                            | Example    |
| ----------------------------------------- | ----- | ------- | ------------------------------------------------------ | ---------- |
| `betterdb_vector_index_docs`              | gauge | `index` | Current document count for a vector index              | `30000`    |
| `betterdb_vector_index_memory_bytes`      | gauge | `index` | Current memory usage for a vector index, in bytes      | `62914560` |
| `betterdb_vector_index_indexing_failures` | gauge | `index` | Cumulative `hash_indexing_failures` for a vector index | `0`        |
| `betterdb_vector_index_percent_indexed`   | gauge | `index` | Percent of documents indexed (0–100)                   | `100`      |

**Availability**: Only populated when connected to an instance with the Search module loaded (RediSearch or [`valkey-search`](https://github.com/valkey-io/valkey-search)). Returns no data otherwise. See [Vector / AI](vector-ai/README.md) for the feature overview and the REST endpoints that back the monitor UI.

**Cardinality Warning**: Label cardinality scales with the number of indexes per connection. Typical deployments have single-digit index counts; if you run hundreds of indexes per instance, monitor scrape size accordingly.

### Commandstats Metrics

Per-command execution counts and latency sourced from `INFO commandstats`, populated by `CommandstatsPollerService` every 60 s. Gauges are emitted once per `(connection, command)` pair, and stale labels are automatically removed when a command disappears between polls (e.g., after `CONFIG RESETSTAT`).

| Metric                              | Type  | Labels    | Description                                                                              | Example |
| ----------------------------------- | ----- | --------- | ---------------------------------------------------------------------------------------- | ------- |
| `betterdb_commandstats_calls_total` | gauge | `command` | Cumulative number of times a command has been executed (`calls` from INFO commandstats)  | `1523`  |
| `betterdb_commandstats_latency_us`  | gauge | `command` | Rolling average command latency in microseconds (`usec_per_call` from INFO commandstats) | `29700` |

`calls_total` is published as a gauge (not a counter) because the source value is the absolute cumulative count reported by the server, not an increment computed in-process. This makes `rate()` queries behave correctly across both incremental polls and `CONFIG RESETSTAT`-driven counter resets, without needing Prometheus-side counter-reset detection.

**Cardinality Warning**: Label cardinality scales with the number of distinct commands executed per connection. A typical Valkey workload exposes a few dozen; modules like RediSearch add another handful. If your workload uses a very large module surface, monitor scrape size accordingly.

### Inference Latency Metrics

Percentile latency for inference-shaped buckets, sourced from per-entry duration tables (`command_log_entries` on Valkey 8.1+, `slowlog_entries` elsewhere). Buckets are `FT.SEARCH:<index-name>` per configured index, plus aggregate `read` (GET/MGET) and `write` (SET/HSET family). Populated by the `InferenceLatencyService` evaluation loop; stale labels are removed when a bucket disappears.

| Metric                             | Type  | Labels   | Description                                                                           | Example |
| ---------------------------------- | ----- | -------- | ------------------------------------------------------------------------------------- | ------- |
| `betterdb_inference_bucket_p50_us` | gauge | `bucket` | p50 latency in microseconds for an inference bucket                                   | `4200`  |
| `betterdb_inference_bucket_p95_us` | gauge | `bucket` | p95 latency in microseconds for an inference bucket                                   | `18500` |
| `betterdb_inference_bucket_p99_us` | gauge | `bucket` | p99 latency in microseconds for an inference bucket                                   | `31000` |
| `betterdb_inference_unhealthy`     | gauge | `bucket` | Whether a bucket is unhealthy (p50 > 10 ms for `FT.SEARCH:*`): 1 unhealthy, 0 healthy | `0`     |
| `betterdb_inference_sla_breach`    | gauge | `index`  | Whether the configured per-index p99 SLA is currently breached: 1 breached, 0 ok      | `0`     |

**Threshold-gating bias**: the source tables only store entries slower than the configured threshold directive (`commandlog-execution-slower-than` or `slowlog-log-slower-than`), so percentiles skew toward the tail. The `/inference-latency/profile` HTTP response exposes the active directive + value so consumers can qualify the number.

**Cardinality Warning**: `FT.SEARCH` buckets scale with the number of vector indexes per connection. `inference_sla_breach` only emits for indexes with an active SLA configured (Pro tier). Aggregate `read` / `write` buckets are constant cardinality.

### Server Info Metrics

Basic server identification and uptime.

| Metric                       | Type  | Labels                  | Description                     | Example  |
| ---------------------------- | ----- | ----------------------- | ------------------------------- | -------- |
| `betterdb_uptime_in_seconds` | gauge | -                       | Server uptime in seconds        | `864000` |
| `betterdb_instance_info`     | gauge | `version`, `role`, `os` | Instance information (always 1) | `1`      |

**Label Example**: `version="8.0.1"`, `role="master"`, `os="Linux 5.15.0"`

### Memory Metrics

Detailed memory usage and fragmentation tracking.

| Metric                                | Type  | Labels | Description                                    | Example      |
| ------------------------------------- | ----- | ------ | ---------------------------------------------- | ------------ |
| `betterdb_memory_used_bytes`          | gauge | -      | Total allocated memory in bytes                | `1073741824` |
| `betterdb_memory_used_rss_bytes`      | gauge | -      | RSS memory usage in bytes                      | `1200000000` |
| `betterdb_memory_used_peak_bytes`     | gauge | -      | Peak memory usage in bytes                     | `1500000000` |
| `betterdb_memory_max_bytes`           | gauge | -      | Maximum memory limit in bytes (0 if unlimited) | `2147483648` |
| `betterdb_memory_fragmentation_ratio` | gauge | -      | Memory fragmentation ratio                     | `1.15`       |
| `betterdb_memory_fragmentation_bytes` | gauge | -      | Memory fragmentation in bytes                  | `126000000`  |

### Stats Metrics

Operational statistics and throughput.

| Metric                                | Type  | Labels | Description                         | Example    |
| ------------------------------------- | ----- | ------ | ----------------------------------- | ---------- |
| `betterdb_connections_received_total` | gauge | -      | Total connections received          | `45678`    |
| `betterdb_commands_processed_total`   | gauge | -      | Total commands processed            | `12456789` |
| `betterdb_instantaneous_ops_per_sec`  | gauge | -      | Current operations per second       | `2500`     |
| `betterdb_instantaneous_input_kbps`   | gauge | -      | Current input kilobytes per second  | `125.5`    |
| `betterdb_instantaneous_output_kbps`  | gauge | -      | Current output kilobytes per second | `856.3`    |
| `betterdb_keyspace_hits_total`        | gauge | -      | Total keyspace hits                 | `9876543`  |
| `betterdb_keyspace_misses_total`      | gauge | -      | Total keyspace misses               | `234567`   |
| `betterdb_evicted_keys_total`         | gauge | -      | Total evicted keys                  | `1234`     |
| `betterdb_expired_keys_total`         | gauge | -      | Total expired keys                  | `56789`    |
| `betterdb_pubsub_channels`            | gauge | -      | Number of pub/sub channels          | `12`       |
| `betterdb_pubsub_patterns`            | gauge | -      | Number of pub/sub patterns          | `3`        |

### CPU Metrics

Server CPU consumption from the Valkey/Redis INFO CPU section.

| Metric                            | Type  | Labels       | Description                                                  | Example  |
| --------------------------------- | ----- | ------------ | ------------------------------------------------------------ | -------- |
| `betterdb_cpu_sys_seconds_total`  | gauge | `connection` | Cumulative system CPU time consumed by the server in seconds | `123.45` |
| `betterdb_cpu_user_seconds_total` | gauge | `connection` | Cumulative user CPU time consumed by the server in seconds   | `456.78` |

**System vs User CPU**

`cpu_sys_seconds_total` tracks time the CPU spent in kernel space on behalf of the Valkey process - network I/O syscalls, memory allocation, and other OS-level operations. `cpu_user_seconds_total` tracks time spent executing Valkey's own code in userspace - command processing, data structure operations, Lua scripts, and so on.

For a lightly loaded instance, system CPU is typically higher than user because most work is network I/O. A spike in user CPU points to CPU-intensive commands (large `SORT` operations, complex Lua scripts, big key scans). A spike in system CPU points to network or memory pressure.

**Note**: These are cumulative counters exposed as gauges. Use `rate()` in PromQL to compute per-second CPU usage.

### Replication Metrics

Replication status and offset tracking.

| Metric                                | Type  | Labels    | Description                                                                                 | Example     |
| ------------------------------------- | ----- | --------- | ------------------------------------------------------------------------------------------- | ----------- |
| `betterdb_connected_slaves`           | gauge | -         | Number of connected replicas                                                                | `2`         |
| `betterdb_repl_output_buffer_ratio`   | gauge | `replica` | Replica output buffer size as a fraction of the client-output-buffer-limit slave hard limit | `0.12`      |
| `betterdb_replication_offset`         | gauge | -         | Replication offset                                                                          | `123456789` |
| `betterdb_master_link_up`             | gauge | -         | 1 if link to master is up (replica only)                                                    | `1`         |
| `betterdb_master_last_io_seconds_ago` | gauge | -         | Seconds since last I/O with master (replica only)                                           | `2`         |

**Note**: after a failover, the previous role's series (`betterdb_connected_slaves` or `betterdb_master_link_up` / `betterdb_master_last_io_seconds_ago`) are removed, and `betterdb_instance_info` keeps one series per connection.

### Keyspace Metrics

Per-database key statistics.

| Metric                            | Type  | Labels | Description                                  | Example  |
| --------------------------------- | ----- | ------ | -------------------------------------------- | -------- |
| `betterdb_db_keys`                | gauge | `db`   | Total keys in database                       | `125000` |
| `betterdb_db_keys_expiring`       | gauge | `db`   | Keys with expiration in database             | `45000`  |
| `betterdb_db_avg_ttl_seconds`     | gauge | `db`   | Average TTL in seconds                       | `3600`   |
| `betterdb_keyspace_keys`          | gauge | -      | Total keys across all databases              | `125000` |
| `betterdb_keyspace_keys_expiring` | gauge | -      | Keys with an expiration across all databases | `45000`  |

**Label Example**: `db="db0"`, `db="db1"`

### Persistence Metrics

RDB and AOF persistence status from the Valkey/Redis INFO persistence section.

| Metric                                     | Type  | Labels | Description                                 | Example      |
| ------------------------------------------ | ----- | ------ | ------------------------------------------- | ------------ |
| `betterdb_rdb_changes_since_last_save`     | gauge | -      | Writes since the last RDB save              | `128`        |
| `betterdb_rdb_last_save_timestamp_seconds` | gauge | -      | Unix time of the last successful RDB save   | `1737400000` |
| `betterdb_rdb_last_bgsave_ok`              | gauge | -      | 1 if the last RDB background save succeeded | `1`          |
| `betterdb_aof_enabled`                     | gauge | -      | 1 if AOF persistence is enabled             | `1`          |
| `betterdb_aof_last_bgrewrite_ok`           | gauge | -      | 1 if the last AOF rewrite succeeded         | `1`          |

### Cluster Metrics

Cluster mode health and slot distribution.

| Metric                            | Type  | Labels | Description                       | Example |
| --------------------------------- | ----- | ------ | --------------------------------- | ------- |
| `betterdb_cluster_enabled`        | gauge | -      | 1 if cluster mode is enabled      | `1`     |
| `betterdb_cluster_known_nodes`    | gauge | -      | Number of known cluster nodes     | `6`     |
| `betterdb_cluster_size`           | gauge | -      | Number of master nodes in cluster | `3`     |
| `betterdb_cluster_slots_assigned` | gauge | -      | Number of assigned slots          | `16384` |
| `betterdb_cluster_slots_ok`       | gauge | -      | Number of slots in OK state       | `16384` |
| `betterdb_cluster_slots_fail`     | gauge | -      | Number of slots in FAIL state     | `0`     |
| `betterdb_cluster_slots_pfail`    | gauge | -      | Number of slots in PFAIL state    | `0`     |

#### Cluster Slot Metrics (Valkey 8.0+)

| Metric                               | Type  | Labels | Description                   | Example |
| ------------------------------------ | ----- | ------ | ----------------------------- | ------- |
| `betterdb_cluster_slot_keys`         | gauge | `slot` | Keys in cluster slot          | `512`   |
| `betterdb_cluster_slot_expires`      | gauge | `slot` | Expiring keys in cluster slot | `128`   |
| `betterdb_cluster_slot_reads_total`  | gauge | `slot` | Total reads for cluster slot  | `45678` |
| `betterdb_cluster_slot_writes_total` | gauge | `slot` | Total writes for cluster slot | `12345` |

**Availability**: Only populated when connected to Valkey 8.0+ cluster. Limited to the top `METRICS_SLOT_STATS_TOP_N` slots by key count (default 100; `0` disables). A slot that leaves the top N is removed rather than reported as 0, so a cluster connection exports at most 4 × N slot series. Not exported under `vitals`.

### Anomaly Detection Metrics

Real-time anomaly detection system metrics.

#### Event Metrics

| Metric                            | Type    | Labels                                    | Description                        | Example |
| --------------------------------- | ------- | ----------------------------------------- | ---------------------------------- | ------- |
| `betterdb_anomaly_events_total`   | counter | `severity`, `metric_type`, `anomaly_type` | Total anomaly events detected      | `42`    |
| `betterdb_anomaly_events_current` | gauge   | `severity`                                | Unresolved anomalies by severity   | `3`     |
| `betterdb_anomaly_by_severity`    | gauge   | `severity`                                | Anomalies in last hour by severity | `12`    |
| `betterdb_anomaly_by_metric`      | gauge   | `metric_type`                             | Anomalies in last hour by metric   | `8`     |

**Label Values**:

- `severity`: `info`, `warning`, `critical`
- `metric_type`: `connections`, `ops_per_sec`, `memory_used`, `input_kbps`, `output_kbps`, `slowlog_last_id`, `acl_denied`, `evicted_keys`, `blocked_clients`, `keyspace_misses`, `fragmentation_ratio`, `cpu_utilization`, `replication_role`
- `anomaly_type`: `spike`, `drop`

#### Correlation Metrics

| Metric                                   | Type    | Labels                | Description                     | Example |
| ---------------------------------------- | ------- | --------------------- | ------------------------------- | ------- |
| `betterdb_correlated_groups_total`       | counter | `pattern`, `severity` | Total correlated anomaly groups | `15`    |
| `betterdb_correlated_groups_by_severity` | gauge   | `severity`            | Groups in last hour by severity | `8`     |
| `betterdb_correlated_groups_by_pattern`  | gauge   | `pattern`             | Groups in last hour by pattern  | `5`     |

**Pattern Values**: `traffic_burst`, `batch_job`, `memory_pressure`, `slow_queries`, `auth_attack`, `connection_leak`, `cache_thrashing`, `node_failover`, `unknown`

#### Buffer Stats Metrics

| Metric                           | Type  | Labels        | Description                             | Example |
| -------------------------------- | ----- | ------------- | --------------------------------------- | ------- |
| `betterdb_anomaly_buffer_ready`  | gauge | `metric_type` | Buffer ready state (1=ready, 0=warming) | `1`     |
| `betterdb_anomaly_buffer_mean`   | gauge | `metric_type` | Rolling mean for anomaly detection      | `2450`  |
| `betterdb_anomaly_buffer_stddev` | gauge | `metric_type` | Rolling stddev for anomaly detection    | `125.5` |

### Metric Forecasting Metrics

Forward-looking projections of when a tracked metric will reach its configured ceiling.

| Metric                                           | Type  | Labels        | Description                                                       | Example |
| ------------------------------------------------ | ----- | ------------- | ----------------------------------------------------------------- | ------- |
| `betterdb_metric_forecast_time_to_limit_seconds` | gauge | `metric_kind` | Projected seconds until the metric reaches its configured ceiling | `3600`  |

### CVE Detection Metrics

Latest CVE scan rollup per connection. Updated on storage-based poll.

| Metric | Type | Labels | Description | Example |
|--------|------|--------|-------------|---------|
| `betterdb_cve_findings` | gauge | `connection`, `severity` | Current CVE findings by severity from the latest scan | `2` |
| `betterdb_cve_kev` | gauge | `connection` | Current KEV-exploited CVE findings from the latest scan | `1` |
| `betterdb_cve_dataset_stale` | gauge | `connection` | Whether the CVE scan is partial or sources are missing: 1 stale, 0 ok | `0` |

### Internal Metrics

BetterDB Monitor application health metrics.

| Metric                           | Type      | Labels       | Description                                                                                         | Example                                            |
| -------------------------------- | --------- | ------------ | --------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `betterdb_polls_total`           | counter   | -            | Total number of poll cycles completed                                                               | `123456`                                           |
| `betterdb_poll_duration_seconds` | histogram | `service`    | Duration of poll cycles in seconds                                                                  | buckets: 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10 |
| `betterdb_poll_stale`            | gauge     | `connection` | `1` when the connection has had no successful `INFO` read within the staleness bound, `0` otherwise | `0`                                                |

**Service Values**: Names of polling services (audit, client-analytics, metrics, etc.)

**Staleness**: If a connection has no successful `INFO` read within `PROMETHEUS_STALENESS_MS` (default: 3 × `PROMETHEUS_POLL_INTERVAL_MS`), all of its gauge series are removed from the exposition and from the OTLP mirror. A dead or wedged connection then shows up as a gap instead of a flat line. Counters and `betterdb_poll_stale` stay, so `betterdb_poll_stale == 1` tells a stale connection apart from one that was never collected. INFO-based series return on the next successful poll; series owned by other collectors (commandstats and inference latency refresh every 60s, the vector index every 30s, the anomaly summary on its own cadence) return on their own refresh cycle instead. Deleting a connection removes its gauge series on the next poll cycle, not immediately.

**Alerting note**: this is a behaviour change — alert rules that test a gauge's value directly (e.g. `betterdb_inference_unhealthy == 1`) will now resolve when a connection dies or is removed, since the series disappears instead of holding its last value. Alert on `betterdb_poll_stale == 1` as well to catch that case.

### Node.js Process Metrics

Standard process metrics provided by `prom-client` with `betterdb_` prefix.

#### CPU & Memory

| Metric                                      | Type    | Description                                     |
| ------------------------------------------- | ------- | ----------------------------------------------- |
| `betterdb_process_cpu_user_seconds_total`   | counter | Total user CPU time spent in seconds            |
| `betterdb_process_cpu_system_seconds_total` | counter | Total system CPU time spent in seconds          |
| `betterdb_process_cpu_seconds_total`        | counter | Total user and system CPU time spent in seconds |
| `betterdb_process_resident_memory_bytes`    | gauge   | Resident memory size in bytes                   |
| `betterdb_process_virtual_memory_bytes`     | gauge   | Virtual memory size in bytes                    |
| `betterdb_process_heap_bytes`               | gauge   | Process heap size in bytes                      |

#### File Descriptors

| Metric                      | Type  | Description                             |
| --------------------------- | ----- | --------------------------------------- |
| `betterdb_process_open_fds` | gauge | Number of open file descriptors         |
| `betterdb_process_max_fds`  | gauge | Maximum number of open file descriptors |

#### Event Loop

| Metric                                         | Type  | Description                                      |
| ---------------------------------------------- | ----- | ------------------------------------------------ |
| `betterdb_nodejs_eventloop_lag_seconds`        | gauge | Lag of event loop in seconds                     |
| `betterdb_nodejs_eventloop_lag_min_seconds`    | gauge | Minimum recorded event loop delay                |
| `betterdb_nodejs_eventloop_lag_max_seconds`    | gauge | Maximum recorded event loop delay                |
| `betterdb_nodejs_eventloop_lag_mean_seconds`   | gauge | Mean of recorded event loop delays               |
| `betterdb_nodejs_eventloop_lag_stddev_seconds` | gauge | Standard deviation of recorded event loop delays |
| `betterdb_nodejs_eventloop_lag_p50_seconds`    | gauge | 50th percentile of recorded event loop delays    |
| `betterdb_nodejs_eventloop_lag_p90_seconds`    | gauge | 90th percentile of recorded event loop delays    |
| `betterdb_nodejs_eventloop_lag_p99_seconds`    | gauge | 99th percentile of recorded event loop delays    |

#### Heap & GC

| Metric                                            | Type      | Labels  | Description                                                     |
| ------------------------------------------------- | --------- | ------- | --------------------------------------------------------------- |
| `betterdb_nodejs_heap_size_total_bytes`           | gauge     | -       | Process heap size from Node.js in bytes                         |
| `betterdb_nodejs_heap_size_used_bytes`            | gauge     | -       | Process heap size used from Node.js in bytes                    |
| `betterdb_nodejs_external_memory_bytes`           | gauge     | -       | Node.js external memory size in bytes                           |
| `betterdb_nodejs_heap_space_size_total_bytes`     | gauge     | `space` | Process heap space size total in bytes                          |
| `betterdb_nodejs_heap_space_size_used_bytes`      | gauge     | `space` | Process heap space size used in bytes                           |
| `betterdb_nodejs_heap_space_size_available_bytes` | gauge     | `space` | Process heap space size available in bytes                      |
| `betterdb_nodejs_gc_duration_seconds`             | histogram | `kind`  | Garbage collection duration (major, minor, incremental, weakcb) |

## Scrape Configuration

### Basic Prometheus Configuration

```yaml
scrape_configs:
  - job_name: 'betterdb'
    static_configs:
      - targets: ['localhost:3001']
    metrics_path: '/api/prometheus/metrics'
    scrape_interval: 15s
    scrape_timeout: 10s
    authorization:
      type: Bearer
      credentials: '<PROMETHEUS_METRICS_TOKEN>'
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
    metrics_path: '/api/prometheus/metrics'
    scrape_interval: 15s
```

If `PROMETHEUS_METRICS_TOKEN` is set, add the `authorization` block from the basic example above.

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
    metrics_path: '/api/prometheus/metrics'
    scrape_interval: 15s
```

If `PROMETHEUS_METRICS_TOKEN` is set, add the `authorization` block from the basic example above.

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

> **Note**: API calls need a signed-in session when user control is enabled — see [Authenticating API Requests](configuration.md#authenticating-api-requests).

```bash
curl -b cookies.txt -X PUT http://localhost:3001/settings \
  -H "Content-Type: application/json" \
  -d '{"anomalyPrometheusIntervalMs": 15000}'
```

### Authentication

By default the endpoint is open and unauthenticated, matching every scrape example above.

- `PROMETHEUS_METRICS_ENABLED` — set to `false` to return 404 from `/api/prometheus/metrics`; the OTLP mirror keeps exporting regardless.
- `PROMETHEUS_METRICS_TOKEN` — when set, a scrape must send `Authorization: Bearer <token>`; a missing or wrong token returns 401.

In `CLOUD_MODE`, `PROMETHEUS_METRICS_TOKEN` is required whenever the endpoint is enabled: startup fails validation if it's unset, and an enabled endpoint with no token configured answers 401 at request time.

### Cardinality Management

High-cardinality labels can impact Prometheus performance. See [Cardinality Contract](#cardinality-contract) for the full series budget and its worst cases. Monitor these metrics:

- `betterdb_client_connections_by_name` - Scales with unique client names
- `betterdb_client_connections_by_user` - Scales with unique usernames
- `betterdb_cluster_slot_*` - Limited to the top `METRICS_SLOT_STATS_TOP_N` slots by key count (default 100; `0` disables the call entirely). A slot that leaves the top N is removed rather than reported as 0, so a cluster connection exports at most 4 × N slot series.

If cardinality becomes an issue, consider:

- Setting `METRICS_EXPORT_PROFILE=vitals` for a fixed, bounded series budget per connection regardless of key count, database count, or cluster size
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

**Getting a 401 Unauthorized?**

- The token is missing or wrong: send `Authorization: Bearer <PROMETHEUS_METRICS_TOKEN>`

**Getting a 404 Not Found?**

- The endpoint is disabled: `PROMETHEUS_METRICS_ENABLED` is set to `false`

### High Scrape Duration

If `/api/prometheus/metrics` takes >1s to respond:

- Reduce slowlog analysis sample size (default: 128 entries)
- Reduce `METRICS_SLOT_STATS_TOP_N` (default: 100 slots; `0` disables the call)
- Increase scrape timeout in Prometheus config
- Check if database is responding slowly

### Stale Metrics

If metrics appear outdated:

- Verify BetterDB Monitor is running: Check `betterdb_process_start_time_seconds`
- Check database connectivity: Review `/health` endpoint
- Verify polling services: Check `betterdb_polls_total` is incrementing
