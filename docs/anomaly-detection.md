---
title: Anomaly Detection
nav_order: 4
---

# Anomaly Detection Guide

Comprehensive guide to BetterDB's real-time anomaly detection system for Valkey and Redis databases.

## Table of Contents

- [Overview](#overview)
- [How It Works](#how-it-works)
- [Detected Patterns](#detected-patterns)
- [Incident Sequence Rules](#incident-sequence-rules)
- [Per-node coverage](#per-node-coverage)
- [Checks that run once per cluster](#checks-that-run-once-per-cluster)
- [Failing node on cluster events](#failing-node-on-cluster-events)
- [Severity Levels](#severity-levels)
- [Monitored Metrics](#monitored-metrics)
- [Configuration](#configuration)
- [API Endpoints](#api-endpoints)
- [Tuning Guide](#tuning-guide)
- [Integration with Alerting](#integration-with-alerting)
- [Troubleshooting](#troubleshooting)

## Overview

BetterDB's anomaly detection system continuously monitors your Valkey/Redis instance for unusual behavior patterns. It uses statistical analysis to establish baselines and detect deviations that could indicate problems before they impact your application.

### Why Anomaly Detection Matters

Traditional monitoring relies on static thresholds ("alert if memory > 80%"), but these fail to catch:
- **Gradual degradation** - Slow memory leaks that don't cross thresholds
- **Unusual patterns** - Connection spikes that are abnormal for *your* baseline
- **Correlated issues** - Multiple metrics changing together (memory + evictions + fragmentation)
- **Attack patterns** - Authentication failures that spike beyond normal rates

BetterDB's detection adapts to *your* normal behavior and alerts when something deviates significantly.

### Key Benefits

- **Automatic baselining** - No manual threshold configuration
- **Pattern correlation** - Identifies root causes by linking related anomalies
- **Actionable recommendations** - Each pattern includes specific remediation steps
- **Low false positives** - Requires multiple consecutive samples to confirm anomalies
- **Prometheus integration** - Export metrics for alerting and dashboards

## How It Works

### Architecture Flow

```
┌─────────────────┐
│   Valkey/Redis  │
│      INFO       │
└────────┬────────┘
         │ Poll (1s intervals)
         ▼
┌─────────────────┐
│ Metric Extractor│ ← Extracts 11 key metrics
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Circular Buffer │ ← Stores last 300 samples (5 min)
│  (Per Metric)   │   Calculates mean & stddev
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Spike Detector  │ ← Z-score analysis
│  (Per Metric)   │   Severity classification
└────────┬────────┘
         │ Anomaly Events
         ▼
┌─────────────────┐
│   Correlator    │ ← Groups related anomalies
│                 │   Identifies patterns
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Pattern Groups  │ ← Diagnosis + Recommendations
│  + Prometheus   │
└─────────────────┘
```

### 1. Baseline Collection

Each monitored metric maintains a **circular buffer** of 300 samples (5 minutes at 1-second intervals):
- **Minimum samples**: 30 (warmup period)
- **Rolling window**: Last 300 samples only
- **Statistics**: Continuously calculates mean (μ) and standard deviation (σ)

**Example**: For the `connections` metric, if your baseline is 250 ± 25 connections, the buffer tracks this automatically.

### 2. Z-Score Calculation

For each new sample, calculate how many standard deviations it is from the mean:

```
Z-score = (current_value - mean) / stddev
```

**Interpretation**:
- Z = 0: Value is exactly at the mean
- Z = 2: Value is 2 standard deviations above mean (unusual)
- Z = 3: Value is 3 standard deviations above mean (very unusual)
- Z = -2: Value is 2 standard deviations below mean (drop)

### 3. Spike/Drop Detection

An anomaly is triggered when:
1. **Z-score exceeds threshold** (e.g., |Z| > 2.0 for warning)
2. **OR absolute threshold exceeded** (e.g., ACL denied > 50 for critical)
3. **Consecutive samples required** (default: 3 consecutive to reduce noise)
4. **Cooldown period respected** (default: 60s between alerts for same metric)

**Severity determination**:
- **WARNING**: Z ≥ 2.0 (or warning threshold)
- **CRITICAL**: Z ≥ 3.0 (or critical threshold)

### 4. Correlation of Related Anomalies

Every 5 seconds, the correlator examines recent anomalies and groups them by:
- **Time proximity** - Events within 5-second window
- **Pattern matching** - Specific combinations of metrics

**Example**: If `connections`, `ops_per_sec`, and `memory_used` all spike together within 5 seconds, this correlates to a **BATCH_JOB** pattern.

### 5. Pattern Diagnosis

Each pattern includes:
- **Diagnosis** - What the pattern means operationally
- **Recommendations** - Specific actions to investigate or remediate
- **Severity** - Inherited from highest severity anomaly in the group

## Detected Patterns

### AUTH_ATTACK

**Triggers**: Spike in `acl_denied` metric

**What it means**: Elevated ACL denial rate, possibly indicating:
- Brute force authentication attempt
- Misconfigured client credentials
- Expired or revoked ACL permissions

**Recommended actions**:
- Review ACL denied clients in the audit trail
- Check for suspicious IP addresses or patterns
- Consider implementing rate limiting or IP blocking
- Verify ACL rules are configured correctly

**Example scenario**: A client repeatedly tries wrong passwords, causing 50+ ACL denials in 10 seconds.

---

### SLOW_QUERIES

**Triggers**: Spike in `slowlog_last_id` (rate of new slow queries per interval) or `blocked_clients` metrics

**What it means**: Elevated rate of new slow queries, indicating:
- Operations on large data structures
- Blocking operations (BLPOP, BRPOP)
- Inefficient command patterns
- Potential deadlocks

**Note**: Previous versions used `SLOWLOG LEN` (`slowlog_count`), which is capped at `slowlog-max-len` (default 128). Once the buffer is full, the count saturates and the detector goes blind. The current implementation uses `slowlog_last_id` — a monotonically increasing counter — and computes the delta per poll interval to determine how many new slow queries occurred.

**Recommended actions**:
- Review slow log entries to identify problematic commands
- Check for operations on large data structures
- Consider optimizing data access patterns
- Monitor blocked clients for potential deadlocks

**Example scenario**: Application starts scanning large hash keys, causing 50+ new slow queries per second (detected via `slowlog_last_id` delta).

---

### MEMORY_PRESSURE

**Triggers**:
- Spike in `memory_used` (required)
- Optionally with `evicted_keys` or `fragmentation_ratio` spikes

**What it means**: Memory consumption elevated beyond normal, possibly due to:
- Large data import or bulk write
- Memory leak in application
- Lack of TTLs on new keys
- Insufficient maxmemory configuration

**Recommended actions**:
- Check memory usage trends and plan for scaling
- Review eviction policy settings
- Identify large keys or data structures
- Consider increasing maxmemory or adding shards

**Example scenario**: Memory usage jumps from 2GB to 3.5GB while evictions increase from 0 to 500/sec, and fragmentation rises to 1.8.

---

### CACHE_THRASHING

**Triggers**: Concurrent spikes in `keyspace_misses` and `evicted_keys`

**What it means**: Cache is thrashing - keys are being evicted and immediately requested again:
- Working set exceeds available memory
- Poor cache hit rate due to eviction pressure
- Suboptimal eviction policy for workload

**Recommended actions**:
- Review cache hit ratio trends
- Check if working set exceeds available memory
- Consider increasing memory or adjusting TTLs
- Analyze access patterns for optimization opportunities

**Example scenario**: After deploying new feature, cache misses jump from 5% to 40% while evictions increase 10x.

---

### CONNECTION_LEAK

**Triggers**:
- Spike in `connections` WITHOUT corresponding spike in `ops_per_sec`

**What it means**: Connections are accumulating without proportional traffic:
- Connection pool leak in application
- Clients not closing connections properly
- Long-lived idle connections accumulating
- Connection creation faster than cleanup

**Recommended actions**:
- Check for idle connections in client analytics
- Review client applications for connection pool leaks
- Set timeout parameters (timeout, tcp-keepalive)
- Monitor connection creation vs. closure rates

**Example scenario**: Connection count rises from 200 to 800 over 10 minutes, but ops/sec remains constant at 2000.

---

### BATCH_JOB

**Triggers**: Concurrent spikes in `connections`, `ops_per_sec`, AND `memory_used`

**What it means**: Large-scale batch operation is running:
- Bulk data import job
- Backup or export process
- Migration script running
- Scheduled data processing

**Recommended actions**:
- Identify the client or job causing the spike
- Consider scheduling batch jobs during off-peak hours
- Implement rate limiting for bulk operations
- Monitor job duration and resource usage

**Example scenario**: Nightly ETL job starts, causing connections to spike from 100 to 500, ops/sec from 1000 to 15000, and memory from 1GB to 2GB.

---

### TRAFFIC_BURST

**Triggers**:
- Spikes in `connections` and `ops_per_sec` WITHOUT memory spike
- OR spikes in `input_kbps` / `output_kbps`

**What it means**: Sudden increase in legitimate traffic:
- Application feature launch
- Traffic surge (viral content, marketing campaign)
- Retry storm from upstream service
- Recurring traffic pattern (daily peak)

**Recommended actions**:
- Monitor traffic patterns for recurring spikes
- Ensure sufficient capacity for peak loads
- Review client connection pooling settings
- Consider implementing auto-scaling if cloud-hosted

**Example scenario**: Marketing campaign launches, ops/sec increases from 2000 to 12000, but memory usage remains stable.

---

### NODE_FAILOVER

**Triggers**: Replication role state change from `master` to `replica`

**What it means**: A primary failover or demotion has occurred — one of the most operationally significant events possible:
- Sentinel or cluster-initiated failover
- Manual FAILOVER command executed
- Potential split-brain scenario
- Network partition causing role change

**Detection method**: This is a *state-change* detector, not a z-score spike. The system tracks the replication role (`INFO replication.role`) across successive polls and emits a CRITICAL anomaly when a node transitions from master to replica.

**Recommended actions**:
- Verify the new primary is healthy and accepting writes
- Check replication lag on the new primary
- Review application connection strings for failover handling
- Inspect cluster logs for the cause of the failover
- Confirm no split-brain scenario exists

**Example scenario**: Sentinel detects the primary is unreachable and promotes a replica. The original primary comes back as a replica, triggering a NODE_FAILOVER anomaly.

---

### PERSISTENCE_STALL

**Triggers**: A running BGSAVE or AOF-rewrite fork child stops making progress, exceeds a time ceiling, or reports an error

**What it means**: The persistence fork child is stuck or failing, which can silently block writes, exhaust memory through copy-on-write growth, or leave you without a recent backup:
- Fork child wedged on disk I/O or an allocator error
- Out-of-memory during the fork causing runaway copy-on-write
- Full or failing persistence target (disk full, permissions)
- BGSAVE / BGREWRITEAOF that never completes

**Detection method**: This is a *state-change* detector, not a z-score spike. Per connection, it tracks each persistence child (RDB save and AOF rewrite) across successive polls from the INFO persistence section and emits:
- **CRITICAL** when RDB key progress freezes for `MONITOR_PERSISTENCE_STALL_SEC` (default 60s) while the save is still in progress
- **CRITICAL** when a child's elapsed time exceeds `MONITOR_PERSISTENCE_CRIT_SEC` (default 600s)
- **CRITICAL** on an `ok` to `err` transition of `rdb_last_bgsave_status` / `aof_last_bgrewrite_status`
- **WARNING** when elapsed time exceeds `MONITOR_PERSISTENCE_WARN_SEC` (default 120s) while the child is still advancing

Each condition fires once per episode and the tracking state clears when the child finishes. AOF rewrite has no per-key progress counter in INFO, so it relies on the time-based ceilings only (no frozen-progress detection).

**Recommended actions**:
- Check memory headroom and copy-on-write growth (`current_cow_size`)
- Inspect the server log for fork or allocator errors
- Consider `BGSAVE CANCEL` if the save is wedged
- Verify disk space and I/O on the persistence target

**Example scenario**: A BGSAVE begins, processes 1 of 42657 keys, then stops advancing while `rdb_bgsave_in_progress` stays 1. After 60s with no progress, a CRITICAL PERSISTENCE_STALL anomaly fires.

---

### RETRY_AMPLIFICATION

**Triggers**: Commands per client keep climbing while connected clients stay flat, error replies or connection churn move with them, and the server is under stress (a P99 latency regression, an error-reply burst or connection churn)

**What it means**: Clients are retrying failed or slow calls, and the retries add load that makes the server slower, which causes more retries. Unlike a transient retry burst, this loop does not settle on its own.

**Detection method**: A *state-based* detector over 60s windows, with a baseline taken from the median of the last 30 quiet windows. It raises no findings until it has collected 10 windows (10 minutes). A window is hot when:
- Commands per client is at least 1.3× baseline and ops/sec at least 1.2× baseline
- Connected clients stay within ±15% of baseline
- At least one stress signal is present: a P99 regression (counted for up to 30 min after the event, matching how often the latency detector re-emits, and dropped once the latency guard sees the command healthy for 5 samples in a row; a verdict from the guard counts for 5 min, and after that the 30-min hold applies), error replies at 3× baseline (minimum 1/s), or reconnects at 3× baseline (minimum 1/s)

A run of hot windows is classified once it reaches 3 windows. It qualifies in either of two shapes:
- **Rising**: load rises at least 10% across the run, is not falling, and moves with stress *inside the run*. That means Pearson r ≥ 0.5 between commands per client and an error or churn rate that reached its stress level in the run. A P99 regression makes a window hot but cannot qualify a run alone, because organic growth through a fixed pool slows the server in the same way. The minimum rise keeps a 3-point correlation on flat, noisy load from passing.
- **Step**: the last 3 windows are all at least 2× baseline, the latest is within 10% of their peak, and at least one of them shows retry evidence (an error-reply or reconnect burst). This catches a storm that jumps up, or overshoots and settles, then holds. Latency alone is not enough for a step, because a legitimate batch job through pooled clients looks the same.

Findings carry `pattern: 'rising' | 'step'`. `correlation` is the in-run r for rising findings and `null` for steps.

Runs that end before reaching 3 windows are recorded as transient. A run keeps at most 120 windows: its first and its latest 119. Past that, the correlation and related metrics come from those windows, and the reported length still counts the whole run.

An episode ends after 2 cold windows, or when the monitor misses samples for longer than 2 windows or 3 poll intervals, whichever is longer. Anything shorter counts as the same episode, so a brief blip does not re-alert on the same storm. After a longer gap, a storm that is still running opens a new episode, and its finding fires again after 3 hot windows. If the windows in hand at a gap qualify, the finding is still raised, dated at the end of the episode and attributed to the episode's own span from stored snapshots and the `CLIENT LIST` reads already taken in that span.

- **WARNING** when the run qualifies
- **CRITICAL** when saturation is active in the latest window. Load and client saturation follow their detectors' live state. Control-plane saturation, rejected-connection and lockout-risk events count for 5 minutes. Ordinary CPU anomalies do not count, because they are relative to the recent mean and can be drops.

If storage is unavailable, the finding stays as one event in memory and the shared persistence outbox retries it with the same ID, timestamp and related metrics. A level change while a save is pending raises a separate event. The `retry_amplification.detected` webhook goes out when the event is first saved, so it waits for the retry. If the outbox gives up on the event, no webhook goes out, and a run that is still hot raises the finding again. The episode's level counts as acknowledged as soon as the finding is raised, not when the save lands, so polls during a pending save do not raise it twice. The acknowledged level drops when the run's level drops, so a run that falls back to WARNING and climbs to CRITICAL again raises CRITICAL again. The outbox giving up on an event also resets it.

When other findings share the correlation window, the group takes the likely cause: control-plane saturation first, then an auth attack or a failover, then a persistence stall, then retry amplification, then replication divergence. Memory growth with evictions also goes ahead of retry amplification, because retries are the side effect there. The retry event stays in the group either way.

**OTLP-pushed instances**: Coverage follows the exporter's own push interval, taken from the median of the last 5 gaps between pushes, so a gap longer than 3 push intervals still counts as missed samples. Pushed metrics carry command, ops, client and connection counters but no error replies, and latency regressions are not tracked for pushed instances, so connection churn is the only stress signal there. Client attribution needs `CLIENT LIST` or stored client snapshots, and neither exists for a pushed instance, so `topContributors` is `null` there.

**Other nodes**: A cluster connection also evaluates every other primary in `CLUSTER NODES`, and a Sentinel connection with data-node credentials evaluates each primary it monitors, using the same node list as [replication divergence](#replication_divergence). Each node keeps its own baseline and alerts on its own, with the node's address as `nodeAddr` and in the webhook `instance`. These nodes are read with `INFO clients`, `INFO memory`, `INFO stats` and `INFO replication` per poll. The reconnect rate comes from `total_connections_received`, but client attribution needs `CLIENT LIST`, so `topContributors` is `null` for them. Latency, saturation and other findings of the connection the node was reached through are not used for it, so its trigger is errors or churn and its level stays `warning`. The status tool lists each of these nodes under `nodes`. Primaries monitored as their own connection are skipped.

**Limitations**: A plateau between 1.3× and 2× baseline that neither rises nor steps is not flagged. Client-side timeouts retried on the same connection, with no error replies or reconnects, leave no retry evidence on the server, so they are not flagged; the run stays a `candidate` in the status tool. The first 10 windows after monitoring starts are not screened, so if monitoring starts during elevated load, those windows raise the baseline and a later episode at a similar level may not be flagged. The baseline corrects itself as quiet windows replace them.

**Client attribution**: The message and the `retry_amplification.detected` webhook name up to five top clients, grouped by client name, then non-default ACL user, then IP. The list interleaves two rankings:
- Command-rate growth from `CLIENT LIST` `tot-cmds` (Valkey 8+), counting identities at 1.3× or more of their rate just before the episode and at 1 cmd/s or more during it, largest absolute increase first. Connections that opened during the episode count towards their identity, so a client that keeps reconnecting is still measured
- Reconnect counts from the stored client snapshots, across the whole episode (its newest 30 minutes when it runs longer), counting identities with at least 3 new connections and 1.3× or more of the span before it

Attribution sends no `CLIENT LIST` of its own. It reuses the client analytics poll, which runs on `CLIENT_ANALYTICS_POLL_INTERVAL_MS` (60s by default) on each monitored connection, including between episodes, so the rate just before an episode is known. Readings closer than 30s apart are skipped. If that poll is unavailable or the server stops answering it during an episode, the finding goes out with reconnect counts only. Reconnects come from the snapshots of the same poll. A client that connects, retries and disconnects between two captures does not appear, so short-lived retry connections can be undercounted. The reconnect rate in the trigger still includes them.

A connection is one identity across captures, by client id, address and opening time (`age`): a client caught by `CLIENT LIST` before it ran `CLIENT SETNAME` is counted under the name it set later, in both rankings, and a new connection that a restarted server gives the id and address of an older one (every client of a Unix socket shares the address) is a connection of its own when it opened more than 30s after it. The identity is resolved once over the whole attribution span, the episode and the span before it together, so a connection that was unnamed in the baseline and named during the episode is the same client in both and its churn is not read as growth. The connection count in the newest capture uses the same identities. A connection that is never seen named stays under its user or IP. A new connection counts in the part of the span it opened in, the baseline or the episode, whichever capture first listed it, so both parts are counted the same way and one that opened just before the episode counts once, in the baseline. A connection listed twice in one capture, as when two polls are stored with the same timestamp, counts once. The command rates take the identity the stored captures give a connection, so a rename recorded by a capture that the 30s spacing of the readings skipped names its rate and its reconnects alike.

BetterDB's own connections are recognised by name: `BetterDB-Monitor`, `BetterDB-Agent` and `BetterDB-CLI`, and names that start with one of them followed by `-`, such as the `BetterDB-Monitor-keyscan` key analytics clients. They stay in the captures, so the connection ids their reconnects consume are counted as theirs and not the application's, and are left out of the ranking. The remaining window is a capture taken during one of these connections' handshake, before `CLIENT SETNAME` has run on it: when no later capture lists it with its name, as with a short-lived key analytics client, it is counted under its user or IP.

The stored captures are read for at most the newest 30 minutes of the episode, as long as the detector's own baseline of 30 windows, and for as long a span before the episode; the captures in between are not read, so a long episode is attributed over its newest 30 minutes and compared with the 30 minutes before it started. A read that would aggregate more than 250,000 rows (two 30-minute spans of 60s captures of about 4,000 clients) stops there, in about 0.15s, and the span is shortened to fit: the rows per capture are counted from the index, and the longest span that holds at most 250,000 rows is read instead, the same length on both sides, so the episode keeps its newest captures and the baseline the ones nearest the episode start. Every capture in the span is read whole. With 10,000 clients that is about the newest 12 minutes of the episode and the 12 before it. The span is no shorter than one 60s window on each side; when even that holds more rows, reconnects are not ranked and the finding ranks by command rate only. Either way a warning is logged once per episode with the minutes covered, and the finding's message ends with a short note (`Reconnects ranked over the newest 12 min only.` or `Reconnects not ranked: too many client captures.`). On SQLite the reads run synchronously; the bound holds them to about 2-3 seconds (244,000 rows took 2.2-3.0s on a busy 16-core host, and the three reads of a shortened span 1.9-3.0s in all with 10,000 clients, 2.8-4.0s with 20,000).

The client ids consumed between two captures by connections that no capture lists are split evenly between the identities whose connections all opened in that interval. Each id is counted once: when the connection holding the highest id closes, the ids up to it are not counted again, and only a capture in which every connection opened after the previous one, with a lower highest id, is a server restart from which counting starts over. The interval between the last capture before the episode and the first one in it is split by time: each side counts the part of its ids that matches its share of the interval, so the ids are divided the way the connections are, by when they opened, and a steady pool does not read as episode reconnects. The shares are summed per identity and rounded once, to the nearest connection. The baseline's ids are counted from its first capture: when it is cut after a previous episode, the interval before that capture holds that episode's churn. The even split itself predates the identity rules above and is unchanged: when the monitor's own connections reconnect several times in one interval and one application connection opens after them, the application gets an even share of the monitor's ids, and one connection can reach the 3 reconnects a ranking needs. The stored captures keep a count, the oldest age and the highest id per identity, so without a count of the monitor's own connection opens per interval this case cannot be told from a retrier that keeps reconnecting and holds the newest id; any other split would credit that retrier's reconnects to the clients below it instead.

**Recommended actions**:
- Add exponential backoff with jitter and a retry budget
- Put a circuit breaker in front of the instance
- Set client timeouts above the observed P99
- Throttle the clients whose command rate grew the most, then shed load until latency recovers. The group's recommendation names them (see [Computed values](#computed-values))

### REPLICATION_DIVERGENCE

**Triggers**: A connected replica's byte gap to the primary keeps growing, stays far behind, or stops draining

**What it means**: The replica is falling behind even if `lag` still looks healthy, because `lag` measures how recently it acknowledged the stream, not how much it has applied:
- Slow apply path on the replica (CPU, disk or network)
- Bulk writes or resharding outrunning the replica
- Replica that stopped applying or acknowledging the stream

**Detection method**: This is a *window-based* detector, not a z-score spike. It compares each replica's offset with the primary's over windows of 30s or three poll intervals, whichever is longer, and emits:
- **WARNING** when the gap grows across 4 consecutive windows
- **WARNING** when the replica stays at least 30s behind for 2 windows, and **CRITICAL** at 120s
- **CRITICAL** when the write rate is back within 20% of its baseline, but the gap has not halved over 4 windows and at its pace so far would take more than 8 windows to clear. Halving the gap restarts the count
- **CRITICAL** when writes have stopped and the same check on the gap fails, so the replica is not applying the backlog. A window counts as stopped when the replication stream stays under 4 KiB/s, so PINGs count as idle
- **WARNING** after 2 windows without acknowledgements, and **CRITICAL** after 4. This needs a gap of at least 1 MiB

Gaps under 1 MiB or 5 seconds behind are ignored. Alerts only escalate, and close after 2 windows under those thresholds. See [`replication.divergence` and `replication.recovered`](./webhooks.md) for the webhook payloads.

Replica offsets come from the primary's own `INFO replication`, so detection runs on every connection that reports a primary role, and also on primaries reached through a cluster or Sentinel connection:

- A cluster connection reads `INFO` from every other primary listed in `CLUSTER NODES`, using the same per-node connections as cluster discovery. These connections log in with the cluster connection's own username and password. After a failover the new primary is picked up on the next poll, and open alerts on a node that is no longer a primary are closed. SSH-tunnelled cluster connections still read the other primaries, but the per-node connections dial the `CLUSTER NODES` addresses directly, outside the tunnel; when those reads fail, coverage says the connection is tunnelled. Cluster connections reached through the agent do not read other primaries: the monitor cannot dial them itself.
- A Sentinel connection reads `INFO` from each primary it monitors, but only when the connection has its own data-node username or password, so the Sentinel credentials are never sent to an address Sentinel reports. Set them under **Data node credentials** when adding the connection (`nodeUsername` and `nodePassword` on `POST /api/connections`). Data nodes that need no `AUTH` still need an explicit setting: tick **Connect to data nodes without a username** and leave the password empty. Without either, none of the Sentinel's primaries are checked; this is logged once per connection and shown as *not covered* (see below), unless every primary is already its own connection or checked by another one. The monitor does not try without credentials: on an authenticated node that would fail on every poll and read as unreachable rather than unconfigured. A data-node password that cannot be decrypted (`ENCRYPTION_KEY` missing or rotated) counts as no credentials. The connection form stores no data-node settings for a certificate-authenticated Sentinel; add one through the API with `nodeUsername` set to `""` to check the data nodes with the client certificate. SSH-tunnelled and agent connections are skipped. When data-node credentials are set but another stored secret (password, TLS key or SSH material) cannot be decrypted, the primaries are not checked either. The list follows `SENTINEL MASTERS`, refreshed every 15 seconds.
- Primaries that are already monitored as their own connected connection are skipped. Nodes flagged as failed or down are not read, but their open alerts stay open until they leave the topology. A connection takes every primary no other connection holds and reads up to 64 of them per poll, each with a 2 second timeout. With more than 64 it reads them in rotation, so each primary is checked once per sweep: with 200 primaries that is every 4 polls, about every 4 seconds at the default 1 second poll and every 40 seconds at a 10 second poll. A primary that needs watching is read on every poll, ahead of the rotation: one with an open alert or an alert state that has not cleared, without a synced replica, with slots migrating or a load skew being judged, or just taken over from another connection. A primary in retry backoff is not read while it waits, and goes ahead of the rotation once its retry is due. These take at most a quarter of the 64 reads; any more wait their turn. A primary that waits its turn keeps its alerts and signals, and the windows the per-node checks use stretch to the sweep, so a primary read every fourth poll is not treated as stale between two reads. A primary read on every poll keeps the windows of one poll, from its second such read in a row, so an open alert on it escalates as fast as on a connection's own node. A primary that can't be reached is retried after 1 poll, then after 2, 4 and up to 8 polls, until a read succeeds. Unreachable primaries are logged once, when the count changes. When several connections reach the same primary, such as two registered nodes of one cluster or two Sentinels, only the first checks it. Another connection takes over when the first can no longer read it, or stops polling for 30 seconds.

Alerts from these primaries carry the primary's address as `nodeAddr` and the address in the webhook `instance`, while `connectionId` stays the cluster or Sentinel connection.

**Coverage**: each poll records how many primaries the connection checked, could not reach (flagged down, in retry backoff, or failed to answer), saw refuse the credentials (`WRONGPASS`, `NOAUTH` or `NOPERM`, also while in backoff), has not read yet (`skipped`: waiting for its first turn in the rotation, or for its first read after the topology flagged it down, so `0` once the first sweep ends and every recovered primary has been read), and does not dial at all. A primary that waits its turn counts as its last read left it: checked, unreachable or refusing the credentials. `sweepMs` is how long the read schedule takes to go through every readable primary once, and `sweepPolls` the same in polls: one poll with up to 64 readable primaries, more when they are read in rotation. Both are worked out from the poll interval and the number of readable primaries, not measured, and both report one poll while no primary can be read. A primary the topology flags as down is counted by the one connection that holds it, like a reachable one, so two connections of one topology do not both count it; a connection whose topology still lists that primary as reachable takes it over and reads it, since `fail?` and `s_down` are one seed's view. Only one connection tries such a takeover at a time, and the down holder keeps the primary until that read succeeds, so a takeover read that fails, or is in backoff after one, is not counted by the connection that tried it. Any other primary whose read fails, or that is in backoff after one, is counted unreachable (or as refusing the credentials) by each connection that tried it: a failed read releases the primary so another connection of the topology can take it over on its next poll, and both report it until one reads it. `reason` says why the fan-out dials nothing: `no_sentinel_credentials`, `sentinel_credentials_unreadable` (the data-node password could not be decrypted), `connection_secrets_unreadable` (another stored secret could not be decrypted), `certificate_auth`, `agent_connection` (cluster or Sentinel), `ssh_tunnel` (Sentinel), `fanout_failed` (the cycle failed before the reads, for example on a storage error, or the deployment has no cluster discovery to dial the primaries, which is logged once per connection; these seven count the primaries left unchecked as `notDialed`), `topology_unknown` (`SENTINEL MASTERS` not read yet), `topology_unreadable` (`CLUSTER NODES` or `SENTINEL MASTERS` itself failed on the latest read), `no_targets` (every other primary is its own connection), `covered_elsewhere` (every other primary is claimed by another connection, which reads it or holds it as down; see that connection's coverage) or `not_applicable` (standalone). `reason` is `null` whenever the connection has primaries of its own to count, even if it dialed none of them because each is in backoff or flagged down, so check the counts as well as `reason` for gaps. The counts are recorded as soon as the reads settle, or before the work that precedes them when there is nothing to read. Coverage that no poll has refreshed for 3 poll intervals (at least 30 seconds), such as that of a disconnected connection, is marked stale and its gauges are withdrawn on the next poll of any connection, summary update or API read. The anomaly dashboard shows a notice above the overview when the selected connection's primaries are not, or only partly, covered, when they are read in rotation (as information, with how often each one is checked), when its coverage is stale (unless its last reason is `not_applicable`, `no_targets` or `covered_elsewhere`, which have no per-node checks to stop), or when the coverage cannot be loaded. The counts are returned by [`GET /api/anomaly/coverage`](#get-fan-out-coverage) and exported as `betterdb_anomaly_fanout_primaries{state}`, with the sweep as `betterdb_anomaly_fanout_sweep_seconds` (see [Prometheus metrics](./prometheus-metrics.md#fan-out-coverage-metrics)).

**Replica cross-check**: Before an alert is raised or escalated, the monitor reads `INFO replication` from the replica itself and then from the primary, and compares the replica's `slave_repl_offset` with the primary's `master_repl_offset`. The replica is read through its own connection when it is monitored as one and connected, by node through cluster discovery on a cluster connection, or by address with the data-node credentials on a Sentinel connection that has them. A primary registered from a Sentinel connection uses its Sentinel connection's replica list and credentials. On Sentinel, only replicas listed in `SENTINEL REPLICAS` are dialed, so the credentials never go to an address that only the primary reports. Other replicas are not read.

- If the replica's link is up and it is less than 1 MiB behind, the alert is skipped. The primary's view was stale because the replica's acknowledgements were late. The check runs again on the next window that would alert. A not-acking alert is never skipped this way: the primary still counts that replica as lagging for `min-replicas-to-write` and `WAIT`, and drops it at `repl-timeout`, so the alert is raised with the replica's view added, and the message says its acknowledgements are not reaching the primary.
- Otherwise the alert is raised, and the message adds the replica's own gap and link status. When the replica's link is up and it reports `slave_read_repl_offset`, the message also says whether it has received data it has not applied yet (slow apply) or has applied everything it received (the stream is not reaching it fast enough).
- If the replica cannot be read within 2 seconds, the poll has already spent 2 seconds on cross-checks, is not found, or follows a different replication ID than the primary, the alert is raised as before, without the replica's view.

**Recommended actions**:
- Compare the replica offset gap with the primary write rate over the next few minutes
- Check replica host CPU, disk and network for a slow apply path
- Review `client-output-buffer-limit replica` and `repl-backlog-size` against the write rate
- If bulk writes or resharding are driving it, throttle them until the replica catches up

**Example scenario**: A bulk import writes faster than a replica can apply. The gap grows for four windows while `lag` stays at 0, and a WARNING fires. The import ends and the write rate returns to baseline. Four windows later the gap has not halved and would take more than eight further windows to clear, so the alert escalates to CRITICAL.

---

### UNKNOWN

**Triggers**: Anomalies that don't match any defined pattern

**What it means**: Unusual behavior detected but correlation unclear:
- Novel issue not covered by patterns
- Single metric anomaly
- Metrics changed but pattern incomplete

**Recommended actions**:
- Investigate the specific metric trend
- Check for related system events
- Review application behavior during this time
- Correlate with external monitoring data

**Example scenario**: `fragmentation_ratio` spikes to 2.5 with no other metrics affected.

## Incident Sequence Rules

Anomalies on one connection, or one cluster, are grouped into incidents. An incident stays open while events keep arriving within two minutes of each other, for at most 30 minutes. A sequence rule recognises a known chain of failures inside an incident, adds its diagnosis and recommendations, and keeps a later step in the same incident across a quiet gap, as long as the rule's span and the incident's 30-minute limit allow it.

A rule's span is measured from its earliest matched event to its latest, using the time each event is stamped with. It is not how long a signal stays open: a warning raised earlier than the span allows does not count, however long it stays active. Optional signals are taken in when they are stamped within one span of the first step, before or after it. One optional signal can be taken into every match of a rule it falls within. An optional signal also joins an incident across a quiet gap once the rule has matched in it, when it is stamped within one span of that match's first step.

Steps count in order: each step must come after the steps before it, within the span. A step with a lead may also come before the steps before it, by up to its lead. A later step alone never joins or extends an incident. A lead step joins across a quiet gap once the steps before the step it may precede were seen. A first step joins an incident across a quiet gap only when the incident already holds a lead step of the rule, stamped within that lead. Rules marked "same connection" only chain events from one connection. The others chain events from any node of the same cluster. When two rules match the same incident and give the same recommendation, it is listed once, on the first match.

A metric marked ↑ only counts when it rose. A drop in that metric does not fill the step or optional signal, so a fall in ops/sec cannot stand in for a write rise. An event whose direction is not known, such as an incident's first event read back from storage, still counts.

A compound rule replaces the rules it combines. When `reshard_divergence_pressure` matches, a `reshard_under_writes` or `divergence_under_pressure` match that shares a step event with it is not listed. Optional signals they share do not count, so the incident shows one diagnosis instead of two. A sequence group recorded for one of those rules before the compound rule matched stays recorded.

Each recorded match sends one `anomaly.sequence.detected` webhook (Pro) with the diagnosis, the recommendations and, when `FRONTEND_URL` is set, a link to the incident. A compound rule that replaces an earlier match sends a second alert. Nothing is sent on recovery, and nothing is sent while the match cannot be stored; the alert goes out once the save succeeds. See the [webhook payload](./webhooks.md#anomalysequencedetected-pro).

| Rule | Steps | Lead | Optional | Span | Same connection |
| --- | --- | --- | --- | --- | --- |
| `recovery_amplification` | `resync_escalation` → `fork_memory_risk`, `repl_buffer_pressure`, `memory_used`↑, `memory_overhead` or `output_kbps`↑ | — | `connection_churn`↑ | 10 min | yes |
| `divergence_under_pressure` | `ops_per_sec`↑ or `input_kbps`↑ → `replication_divergence` → `memory_used`↑, `memory_overhead` or `repl_buffer_pressure` | pressure step: 15 min | `evicted_keys`↑, `evicted_clients`↑, `fork_memory_risk` | 15 min | yes |
| `reshard_under_writes` | `reshard_shard_skew` → `replication_divergence` | — | `command_p99` | 15 min | no |
| `reshard_divergence_pressure` | `reshard_shard_skew` → `replication_divergence` → `memory_used`↑, `memory_overhead` or `repl_buffer_pressure` | pressure step: 15 min | `ops_per_sec`↑, `input_kbps`↑, `command_p99`, `evicted_keys`↑, `evicted_clients`↑, `fork_memory_risk` | 15 min | yes |
| `retry_storm` | `command_p99`↑, `error_replies`↑ or `connection_churn`↑ → `retry_amplification` | — | `client_saturation`, `load_saturation`, `rejected_connections`, `client_lockout_risk` | 10 min | yes |
| `backlog_exhaustion` | `backlog_coverage_risk` → `resync_escalation` | `resync_escalation`: 5 min | — | 30 min | yes |

Why each span is that long:

- **recovery_amplification**: the cost of a full resync (fork, buffers, output) shows up within minutes of the escalation. Later pressure is unrelated.
- **divergence_under_pressure**: divergence needs its warm-up and at least two closed 30s windows after the write rise, and replica buffers grow minutes after that. The divergence detector counts memory and buffer pressure seen since its divergence span began, so pressure may come before the divergence anywhere in the span.
- **reshard_under_writes**: skew only fires during an active reshard, so the rule starts there. Replicas of the busy shards fall behind over the same minutes the divergence detector needs.
- **reshard_divergence_pressure**: it combines `reshard_under_writes` and `divergence_under_pressure`, so it keeps their 15 minute span and the pressure step's lead. All three must come from the same node. A skew on one shard and divergence on another can still match `reshard_under_writes`, which chains events from any node of the cluster. Each failure slows the others' recovery: slot migration adds writes the lagging replicas must apply, the unapplied writes hold memory and buffer space on the primary, memory pressure can fail slot imports and keep the reshard running, and a full replica buffer drops the link and forces a resync.
- **retry_storm**: retry amplification needs a sustained run of hot polls after the slow commands, errors or reconnects that start it. A retry amplification alert that names reconnects as its trigger fills both steps on its own, because the retry detector reads connection churn itself and a separate `connection_churn` alert often never fires, as on a fan-out primary. Saturation shows up within minutes of it or it has another cause. It is optional, because a retry loop that the server still absorbs is worth naming too, and it may come before the retry amplification anywhere in the span, since the retry detector rates a storm critical on saturation it already holds.
- **backlog_exhaustion**: a coverage warning can be raised well before the disconnect that exhausts it, so this rule allows the full incident span from the warning to the resync. A resync escalation is stamped with the time the replica disconnected, up to five minutes before it is raised, so it may be stamped up to five minutes before the coverage warning.

`reshard_shard_skew` fires when one shard's ops/sec, CPU, memory or write P99 is far above the others during a reshard, so it does not always mean slower writes. A `command_p99` regression is taken in as an optional step when there is one. A replica disconnect is stamped on `resync_escalation`, so it needs no step of its own. There is no general out-of-memory signal. Evictions and fork memory risk stand in for it.

## Per-node coverage

When a cluster or Sentinel group is registered through one connection (the seed), the seed runs every detector. Every other primary it reaches is read, up to 64 in parallel per poll and in rotation when there are more, and runs:

- replication divergence
- retry amplification, without client names: the alert says client names are not available because the node is not a registered connection
- backlog coverage risk and resync escalation
- fork memory risk
- replica output-buffer pressure, without the per-replica Prometheus gauge
- reshard pressure, including write P99 read from `INFO latencystats` at most every 30 seconds
- primary without replicas, without the early CRITICAL for persistence being off

On a cluster the seed also asks replicas for their own `CLUSTER NODES` line, to find slot state left on a replica (`replica_slot_state`). When several connections of the cluster are registered, only one of them asks (see [Checks that run once per cluster](#checks-that-run-once-per-cluster)). It reads 8 replicas per poll, and in rotation when there are more, so each replica is read once per replica sweep: with 250 replicas, every 32 polls. Up to 6 replicas that showed slot state are read on every poll until they are clean; any more keep their state and wait their turn. A replica that waits its turn keeps its open warning and is not counted as unreachable, and a new finding on it is raised only once the replica itself has been read. Events stored before they carried a dedupe key are closed once every replica has been read after a start, which takes one replica sweep instead of one poll.

Events from these primaries carry `nodeAddr`. Same-connection sequence rules (`backlog_exhaustion`, `recovery_amplification`) and the correlated signals on a divergence alert group them per node, so a non-seed shard's fork or output-buffer pressure shows on that shard's divergence, not the seed's. `divergence_under_pressure` cannot match on a non-seed shard, because its first step is a z-score write-rate spike, which only runs on registered connections.

A node's divergence, backlog coverage, resync escalation, fork memory and output-buffer events close when it leaves the topology, is claimed by another connection, or is registered as its own connection, and when the seed is removed. Retry amplification alerts are not closed this way; they stay open, as they do on the seed. Open backlog coverage, resync escalation, fork memory and output-buffer events are picked up again per node after a restart, so a node that is still at risk does not raise a duplicate, and the events of a node that did not come back are closed. An output-buffer event is picked up for the replica it was raised on, and a picked-up resync-loop event keeps its 5 minute cooldown. Events of a node whose seed is removed before they are picked up are closed too.

Each command to a primary gets 2 seconds of its own. One that does not answer in time drops that primary's connection once the poll's other commands on it have answered or timed out, so the next poll starts on a fresh one instead of queueing behind it. A primary that cannot be reached is backed off and logged as unreachable; none of the checks above run on it until it answers again. Z-score metrics and the other state-based detectors run only on registered connections. Register a node to get them. A primary whose replication ID matches a registered primary is treated as that connection and skipped, so a node Sentinel reports by IP is not checked twice when it is registered by hostname. The skip lasts while that connection is connected and polling; once it disconnects, or goes three poll intervals (at least 30 seconds) without a poll, the fan-out checks the primary again.

## Checks that run once per cluster

A cluster can have several connections: the seed and the nodes registered from it, or connections you added yourself. Each of them reads `CLUSTER NODES` and sees the same cluster. The checks below judge the cluster as a whole, so they run on one of those connections, the reader, and raise one alert per cluster instead of one per connection:

- two primaries that claim the same slots
- a replica stuck on a primary that is gone
- nodes that announce no hostname while the others do
- ghost members
- a node that was forgotten and joined again
- failover churn
- slot state left on a replica (`replica_slot_state`)

**Which connection reads.** A connection that can dial the other nodes goes before one that cannot. Among those, a connection you added goes before an automatically registered node, so the seed reads while it is connected. Between two connections of the same kind, the one with the lower id reads. A connection that takes the role from a reader that is still reading starts on its next poll, so the checks run once on the poll of the change.

**When the reader stops.** A reader that has not read the cluster for 60 seconds loses the role, and the next connection takes over. The checks do not run during those 60 seconds. Open alerts and the state behind them are kept, so the new reader does not raise them again, and a finding that was already waiting its 30 seconds does not start over. A reader that is removed, or that starts reading another cluster, is replaced on the next poll. The one thing that starts over is the history behind "a node that was forgotten and joined again": two connections can list different members after a `CLUSTER FORGET` that did not reach every node, so a node that comes back across a change of reader is not reported.

**When a cluster comes back with new node ids.** The connections that read the new nodes take the open alerts and the state behind them along once no connection has read the old nodes for 60 seconds. A connection that cannot be read does not hold them back for longer than that. A replica slot warning for a node that no longer exists is then closed.

**The connection on an alert.** These alerts are stored under the seed of the cluster, whichever connection reads, the same connection the `cluster.failover` event uses. A connection you added yourself has no seed and stores them under its own id. A change of reader does not change the connection on an open alert. Removing a connection does not raise a warning again. The one case that touches open alerts: when the connection a replica slot warning is stored under is removed and the cluster still has others, the warning is closed and the next reader raises what is still wrong, without the 30 second wait. When the last connection of a cluster is removed, its open replica slot warnings are closed.

**After a restart.** The reader reads the open replica slot warnings of every connection of the cluster from storage, also those of a connection that does not answer. A warning that is still true is not raised a second time, and one that is no longer true is closed. Where several connections had raised the same warning, one stays open and the others are closed. While those warnings cannot be read, the replica check waits.

**Connections that cannot reach other nodes.** A connection that cannot dial the other nodes, one that reads through an agent for example, cannot ask a replica for its own line. It reports the slot state of its own node only, whether it is the reader or not. The replicas are asked as long as one connection of the cluster can dial them, because that connection reads first.

Everything else stays per connection or per node: the cluster state, hot shards, slot migrations and the per-node checks above. The [topology divergence](#topology_divergence) rounds run on the reader as well when it can dial the other nodes, and its events are filed under the connection that runs the rounds, as before.

## Topology reads in a cluster with many connections

`CLUSTER NODES` answers with one line per node. Read on every connection on every poll, it grows with the square of the cluster. So in a cluster with more than nine connections it is read in turns:

- The reader reads `CLUSTER NODES` and `CLUSTER SHARDS` on every poll.
- Of the other connections, eight read on each poll of the reader, in the order of their ids. With 500 connections and a poll interval of 1 second, a connection has its turn about once a minute.

Every connection reads on every poll, as before, in a cluster with nine connections or fewer, while a cluster has no reader, while its reader has not read for 60 seconds, while its reader has not polled for more than 15 seconds, and while the last two polls of its reader were more than 15 seconds apart. With a poll interval above 15 seconds the turns are therefore never used.

**A poll without a turn.** The connection sends no `CLUSTER NODES` and no `CLUSTER SHARDS`. The checks that judge the node's own line (primary without replicas, reshard pressure, keys in slots the node does not own) and the hot shard check do not run on that poll: they never run on a line that was read earlier. The checks on `INFO` and the slot migration check run on every poll. The checks on other primaries go on from the view a connection of the cluster read last, for as long as it is at most 30 seconds old, or three poll intervals when that is longer.

**Reading outside a turn.** A connection reads on that same poll, whoever has the turn, when

- `INFO` shows another role than at its last read, so a promoted or demoted node is read at once
- its shard is expected to have replicas and `INFO` shows none in sync
- a primary without replicas warning for its shard is waiting its time or open

The 5 second threshold of [primary without replicas](#primary_without_replicas) holds on every node this way, also on one that is far from its turn.

**Reading sooner.** A connection is put ahead of the others on the next poll of the reader while its own line shows a slot that is migrating or importing, while it counts keys in slots its node does not own, and while a reshard skew finding on it is waiting or open. At most four connections go ahead per poll. When more ask, they take turns among themselves, and the other four turns of the poll go on down the list. A reshard counts as running until two polls after such a connection last showed a slot on the move, or two rounds of their turns when more than four ask. A slot that starts to move on a node not yet put ahead is first seen on that node's turn.

**What comes later.** A finding on a node that is in none of these cases is first seen when its connection has a turn, so up to one pass late: about a minute with 500 connections and a 1 second interval. A check that needs several readings in a row counts the readings, not the polls. Reshard skew, for example, needs three: the first can take a pass, the next two follow on the next polls because the connection is put ahead.

**Metrics and the failover webhook.** The Prometheus cluster metrics and the `cluster.failover` webhook read `CLUSTER NODES` on the same schedule, with turns of their own. A connection always reads on its first poll. While anomaly detection does not run, a cluster has no reader and every connection reads on every poll. A promotion is reported once: a connection that sees it later, on its turn, does not send it again, for ten minutes after the last connection saw it.

## Failing node on cluster events

On a cluster connection, an event names the node it is about in a `node` object:

```json
"node": {
  "nodeId": "e7d1eecce10fd6bb5eb35b9f99a514335d9ba9ca",
  "address": "10.0.1.12:6379",
  "role": "primary",
  "shardId": "8f3c1d5e0a9b4c7d2e6f1a0b3c4d5e6f7a8b9c0d",
  "availabilityZone": "eu-west-1a",
  "collected": true,
  "connectionId": "conn-7"
}
```

| Field | Meaning |
| --- | --- |
| `nodeId` | The node's cluster id |
| `address` | `host:port` as the cluster reports it, without the bus port |
| `role` | `primary`, `replica`, or `unknown` for a node that is still joining or has left the cluster view, and when the cluster view is too old to say |
| `shardId` | From `CLUSTER SHARDS`. Absent on servers without that command, on a Raft cluster (the command is not sent there), and on an event raised before any connection of the cluster has read the shards (a connection reads the nodes at the start of its first poll and the shards later in that poll; when another connection of the cluster has read the shards by then, the event takes them from that read). A poll whose `CLUSTER SHARDS` read fails takes the shards from the last read of the cluster with shards: a primary keeps the shard it had there, and a replica takes the shard its current master had there, so a replica that moved to another master since names the new shard. An event raised after it has no `shardId` only when that read did not list the event's node, or for a replica its master, such as a node that joined since, or when no read had the shards yet. It is stored when the event is raised and not filled in later, so an event raised without a `shardId` keeps none |
| `availabilityZone` | From the server, or from the connection's zone map. Absent when neither gives one |
| `collected` | `true` when a registered connection reads this node |
| `connectionId` | That connection. Absent when `collected` is `false` |

`nodeId`, `address`, `role`, `shardId` and `availabilityZone` are taken from the cluster view when the event is raised and stored with it, so an old event keeps the role and shard the node had then. The connections of one cluster share one view, the latest any of them read. When the view was read more than 3 poll intervals (at least 30 seconds) before or after the time of the event, the node is still named but its `role` is `unknown`, since a failover may have changed it. The node a connection reads is the exception, as described next. The node a connection reads takes its `role` from that connection's own `INFO` in the same poll, when that `INFO` was read within the same 3 poll intervals of the event, not from the view, which is read later in the poll. So an event raised in the poll that sees a failover names the new role. An event of a poll keeps the role of that poll's `INFO` also when another connection of the cluster reads the cluster before the event is raised. Only an event that carries another time than that `INFO` takes the role from the view, when the view was read after the `INFO`. A `replication_role` event always carries the role the node changed to, not the one it had before. `collected` and `connectionId` are not stored: they are worked out each time the event is read, from the connections registered at that moment. A node is collected when a registered connection reads it as its own node, or when a connection that belongs to the same cluster points at its address. A connection of another cluster that announces the same address does not count. Neither does a connection at that address that reads another node id there, which is the case for an event about a node that was replaced at the same address. Nor does a connection at that address whose last poll found an instance that is not part of a cluster. With auto-registration off only the seed is collected, plus any node that was registered as a connection by hand.

Events read from `GET /api/anomaly/events`, the events of each group of `GET /api/anomaly/groups`, the entries of `GET /api/anomaly/incidents` and `GET /api/anomaly/incidents/:id`, and the same reads over MCP all carry `node` on an event that has a node stored. An event that names no node, such as a `cluster_state` event, has no `node` field. Each hot shard of `GET /api/anomaly/hot-shards` carries the `node` of its primary. Webhooks carry it too (see [Failing node on cluster alerts](./webhooks.md#failing-node-on-cluster-alerts)). Existing fields (`nodeAddr`, `replicaAddr`, `sourceHost`, `sourcePort`) keep their meaning.

To see which nodes of a cluster are collected without waiting for an event, read `GET /api/metrics/cluster/nodes/discover` or the `get_cluster_nodes` MCP tool: every node carries `collected` and, when it is collected, `connectionId`. There a node is collected when a registered connection reads it as its own node, or when a connection points at its address or announced hostname. A connection at that address that is known to read another node does not count, whether that node belongs to another cluster, is another node of this one, or replaced a node that the cluster still lists as failed at that address. The node a connection reads is the one its own `CLUSTER NODES` reported on the last anomaly detection poll, the same one alerts use. Before the first poll of a connection, and when anomaly detection is not running, it is the node auto-registration saved for the connection, and a connection added by hand counts by its address alone.

In the web UI the node shows up as a link on the event timeline of the Overview page, in the event lists of the Anomalies page, in the incident list and on each incident timeline entry. The link opens the Nodes tab of the Cluster page with that node's row open, and carries a **Not collected** badge when `collected` is `false`. From that row the node can be connected with one click (see [Connecting a single node](cluster-auto-registration.md#connecting-a-single-node)).

Which node each event type names:

| Event types | `node` |
| --- | --- |
| `connections`, `ops_per_sec`, `memory_used`, `input_kbps`, `output_kbps`, `slowlog_last_id`, `slowlog_count`, `acl_denied`, `auth_failure_burst`, `rejected_connections`, `client_saturation`, `client_lockout_risk`, `evicted_clients`, `evicted_keys`, `blocked_clients`, `keyspace_misses`, `fragmentation_ratio`, `cpu_utilization`, `memory_overhead`, `load_saturation`, `large_reply_pressure`, `connection_churn`, `error_replies`, `command_p99`, `dataset_keys`, `persistence_child`, `replication_role`, `resync_loop`, `orphaned_slot_keys`, `lagging_promotion` | The node the connection reads |
| `primary_without_replicas`, `repl_buffer_pressure`, `fork_memory_risk`, `backlog_coverage_risk`, `retry_amplification`, `reshard_shard_skew` | The primary the reading was taken on: the node the connection reads, or the other primary in `nodeAddr` (see [Per-node coverage](#per-node-coverage)) |
| `hot_shard` | The primary of the hot shard |
| `replication_divergence`, `resync_escalation`, `replica_slot_state` | The replica in `replicaAddr`, not the primary the event was read on |
| `cluster_topology` | Duplicate primary: the primary with the stale claim. Replica stuck on a primary that is gone: the replica |
| `hostname_staleness` | The node whose announced hostname is stale |
| `ghost_membership` | Ghost entry: the live node at the endpoint the ghost entries point to. A ghost id is not a node, so the ghost ids stay in the message. Forget and rejoin: the node that rejoined after `CLUSTER FORGET` |
| `failover_churn` | The primary that owns the shard now |
| `slot_migration`, `slot_migration_stuck` | The source node of the migration |
| `config_drift`, `acl_drift` | A drift between nodes: the first node the event lists, which is the connection the event is filed under. The event compares the nodes and does not say which one is wrong, so this node may hold the value the others share; the message lists every node with its value. An ACL reload: the node whose ruleset changed |
| `topology_divergence` | The node whose view differs when one node disagrees with the others. None when several nodes stand on each side: `GET /api/anomaly/topology-divergence` lists every node of both sides |
| `partial_membership` | The node that has only partly joined, also when the connection's own node does not know it. None when no view has an address for it |
| `cluster_state` | None. `cluster_state:fail` is a state of the whole cluster, not of one node |
| `raft_health` | None. Elections and quorum are a state of the cluster's Raft group, not a fault of one node |
| `sentinel_endpoint_drift`, `sentinel_loop_stall` | None. These are about a Sentinel process, which is not a cluster node |

An event has no `node` in four more cases: the connection is not a cluster (a standalone or Sentinel-managed instance is its own node, named by `connectionId`); the event was raised before the first cluster view was read; the node it is about was in no view and the detector gave no address for it; or the event was stored by a version that did not have this field, since the node is not worked out again for an old event. A connection that stops being a cluster drops its view on the next poll that reads it, and its later events carry no `node`. A node that has left the view is still named when the detector knows its id and address, with `role` set to `unknown`. Correlated groups carry no `node` of their own; each event in the group does.

## Severity Levels

### INFO

**Z-score range**: Not currently used (reserved for future patterns)

**Characteristics**:
- Informational only
- No immediate action required
- Track over time for trends

**Example**: Minor fluctuation within expected variance

---

### WARNING

**Z-score threshold**: ≥ 2.0 (or metric-specific warning threshold)

**Characteristics**:
- Noticeable deviation from baseline
- Should be investigated during business hours
- May indicate developing issue
- Typically requires 2-3 consecutive samples

**Example**: Connection count is 2.2 standard deviations above normal (Z=2.2)

**Prometheus alert**: Fire after 5 warnings in 5 minutes

---

### CRITICAL

**Z-score threshold**: ≥ 3.0 (or metric-specific critical threshold)

**Characteristics**:
- Significant deviation from baseline
- Immediate investigation recommended
- Likely indicates active problem
- May require emergency response

**Example**: ACL denials are 3.5 standard deviations above normal (Z=3.5), suggesting authentication attack

**Prometheus alert**: Fire immediately on first critical event

### Per-Metric Thresholds

Some metrics have custom thresholds beyond Z-score:

| Metric | Warning Threshold | Critical Threshold | Consecutive Required | Cooldown |
|--------|-------------------|-------------------|---------------------|----------|
| `acl_denied` | 10/s | 50/s | 2 | 30s |
| `slowlog_last_id` | - | - | 1 | 30s |
| `memory_used` | - | - | 3 | 60s |
| `evicted_keys` | - | - | 2 | 30s |
| `fragmentation_ratio` | 1.5 | 2.0 | 5 | 120s |
| `error_replies` | 200/s | 2000/s | 2 | 60s |

`acl_denied`, `evicted_keys` and `keyspace_misses` read lifetime counters from `INFO stats`, so the detectors see the per-second rate since the previous poll, and absolute thresholds apply to that rate. A z-score spike below a per-second floor (`acl_denied` 1/s, `evicted_keys` 10/s, `keyspace_misses` 50/s) is ignored, so an occasional eviction or denial on an otherwise quiet server does not alert; absolute thresholds still apply below the floor. The first poll of a connection only records the counter. A counter that goes backwards (server restart, `CONFIG RESETSTAT`), or a change in the server's `run_id` (the connection now reaches a different server process, for example after a failover behind a Service), is treated as a reset: that poll adds no sample and the next poll measures from the new value. Absolute threshold overrides saved before this change keep their numbers but now mean events per second; BetterDB logs a warning at startup when any exist for these metrics.

`error_replies` needs at least 20/s to alert. On a quiet instance almost any burst scores a high Z-score, so a Z-score alone only reaches warning here, and critical needs the absolute threshold.

## Monitored Metrics

### connections
**What it measures**: Current number of client connections
**Why anomalies matter**: Sudden spikes may indicate connection leaks, DDoS, or batch jobs
**Typical baseline**: Varies by workload (50-5000)
**Source**: `INFO clients.connected_clients`

### ops_per_sec
**What it measures**: Instantaneous operations per second
**Why anomalies matter**: Indicates traffic changes, application issues, or attacks
**Typical baseline**: Varies widely (100-100000+)
**Source**: `INFO stats.instantaneous_ops_per_sec`

### memory_used
**What it measures**: Total allocated memory in bytes
**Why anomalies matter**: Sudden increases may indicate memory leaks or data bloat
**Typical baseline**: Depends on dataset size (100MB-100GB+)
**Source**: `INFO memory.used_memory`
**Config**: Custom thresholds (3 consecutive, 60s cooldown)

### input_kbps
**What it measures**: Current input kilobytes per second
**Why anomalies matter**: Large write operations or bulk imports
**Typical baseline**: Varies by write load (1-10000 kbps)
**Source**: `INFO stats.instantaneous_input_kbps`

### output_kbps
**What it measures**: Current output kilobytes per second
**Why anomalies matter**: Large read operations or data exports
**Typical baseline**: Varies by read load (1-10000 kbps)
**Source**: `INFO stats.instantaneous_output_kbps`

### slowlog_last_id
**What it measures**: Rate of new slow queries per poll interval (delta of `slowlog_last_id`)
**Why anomalies matter**: Indicates query performance degradation
**Typical baseline**: 0-5 new slow queries per interval
**Source**: `INFO stats → slowlog_last_id` (delta per interval)
**Config**: Custom thresholds (2 consecutive, 30s cooldown)
**Note**: Previous versions used `SLOWLOG LEN` (`slowlog_count`), which saturates at `slowlog-max-len` (default 128). Using `slowlog_last_id` delta avoids this blind spot.

### acl_denied
**What it measures**: ACL authentication denials per second
**Why anomalies matter**: Security concern - possible brute force or misconfig
**Typical baseline**: 0 (should be very low normally)
**Source**: `INFO stats.acl_access_denied_auth` (per-second rate between polls). Refused connections (`rejected_connections`, maxclients) have their own detector.
**Config**: Custom thresholds (WARNING: 10/s, CRITICAL: 50/s, 2 consecutive, 30s cooldown)

### evicted_keys
**What it measures**: Keys evicted due to maxmemory, per second
**Why anomalies matter**: Indicates memory pressure and cache thrashing
**Typical baseline**: 0 (ideally), or consistent low rate
**Source**: `INFO stats.evicted_keys` (per-second rate between polls)
**Config**: Custom thresholds (2 consecutive, 30s cooldown)

### blocked_clients
**What it measures**: Clients blocked on BLPOP, BRPOP, etc.
**Why anomalies matter**: May indicate queue backup or deadlock
**Typical baseline**: 0-10 (depends on usage of blocking commands)
**Source**: `INFO clients.blocked_clients`

### keyspace_misses
**What it measures**: Failed key lookups per second
**Why anomalies matter**: Poor cache hit rate impacts application performance
**Typical baseline**: Varies widely with read load
**Source**: `INFO stats.keyspace_misses` (per-second rate between polls)

### fragmentation_ratio
**What it measures**: Allocator fragmentation ratio, preferring `allocator_frag_ratio` with fallback to `mem_fragmentation_ratio`
**Why anomalies matter**: High fragmentation wastes memory and impacts performance
**Typical baseline**: 1.0-1.3 (ideal)
**Source**: `INFO memory.allocator_frag_ratio` (fallback: `INFO memory.mem_fragmentation_ratio`)
**Config**: Custom thresholds (WARNING: 1.5, CRITICAL: 2.0, 5 consecutive, 120s cooldown)
**Note**: `allocator_frag_ratio` isolates true allocator fragmentation, whereas `mem_fragmentation_ratio` (RSS / used_memory) is skewed by swap and OS-level memory management, leading to false positives. Older Redis versions that don't expose `allocator_frag_ratio` fall back to `mem_fragmentation_ratio` automatically.

### replication_role
**What it measures**: Replication role of the node (master=1, replica=0)
**Why anomalies matter**: A role transition from master to replica indicates a failover event
**Typical baseline**: Stable (should not change)
**Source**: `INFO replication.role`
**Detection method**: State-diff detector (not z-score based). Emits a CRITICAL anomaly when role transitions from master to replica.

### persistence_child
**What it measures**: Progress and health of the running BGSAVE / AOF-rewrite fork child
**Why anomalies matter**: A stuck or failing save can block writes, drive copy-on-write memory growth, or leave you without a recent backup
**Typical baseline**: Idle (no save in progress) most of the time
**Source**: `INFO persistence` (`rdb_bgsave_in_progress`, `current_save_keys_processed`/`current_save_keys_total`, `rdb_current_bgsave_time_sec`, `rdb_last_bgsave_status`, `aof_rewrite_in_progress`, `aof_current_rewrite_time_sec`, `aof_last_bgrewrite_status`)
**Detection method**: State-based detector (not z-score based). Emits CRITICAL on frozen key progress, an elapsed-time ceiling, or an `ok` to `err` status transition, and WARNING on a long-running-but-advancing child. See the [PERSISTENCE_STALL pattern](#persistence_stall) for thresholds.

### replication_divergence
**What it measures**: Bytes each connected replica is behind the primary, and how many seconds that is at the current write rate
**Why anomalies matter**: A replica can fall behind while `lag` stays low, which risks data loss on failover and full resyncs
**Typical baseline**: Near zero
**Source**: `INFO replication` (`master_repl_offset`, `slaveN` or `replicaN` offset, state and lag)
**Detection method**: Window-based detector (not z-score based). See the [REPLICATION_DIVERGENCE pattern](#replication_divergence) for thresholds. The anomaly page shows each replica's status. Divergence sends `replication.divergence` instead of `anomaly.detected`.

### connection_churn
**What it measures**: New connections per second, and new connections per command
**Why anomalies matter**: Clients reconnecting instead of reusing connections waste CPU on connection setup and TLS handshakes, and the client count doesn't show it
**Typical baseline**: Low on pooled workloads
**Source**: `INFO stats.total_connections_received`, `INFO stats.instantaneous_ops_per_sec` and `INFO clients.connected_clients`
**Detection method**: Z-score spike detector (warning 3.0, critical 5.0, 2 consecutive samples, 60s cooldown). Only fires at 10 or more new connections per second while `connected_clients` stays flat, with under 10% of the new connections retained, and only when new connections per command spike too. Clients that open a connection per request, such as PHP-FPM or serverless functions, stay quiet during a traffic surge because connections rise with commands. A storm that reissues the same commands per connection looks the same and also stays quiet.

### raft_health
**What it measures**: Raft elections and quorum on Valkey Cluster V2
**Why anomalies matter**: Repeated elections point to an unstable primary or a split network, and a lost quorum freezes writes
**Typical baseline**: No elections
**Source**: `CLUSTER INFO` (`cluster_raft_*` fields)
**Detection method**: State-based detector (not z-score based). Three elections inside 60 seconds raise a flapping warning, which resolves after 60 seconds with no new election. A node that can't reach a leader raises a critical event, which resolves when quorum returns. A connection that leaves Raft resolves both.

### primary_without_replicas
**What it measures**: Whether a primary that normally has replicas still has one in sync
**Why anomalies matter**: While no replica is in sync, the primary holds the only copy of the shard. With persistence off, losing it loses the shard's data. A Kubernetes operator roll that restarts both replicas of a shard before either is back in sync produces this window on every shard
**Typical baseline**: At least one replica in `state=online`
**Source**: `INFO replication` (`role`, `connected_slaves`, `slaveN` or `replicaN` state) of the primary, and the node's own line in `CLUSTER NODES` for its slots
**Detection method**: State-based detector (not z-score based). A WARNING is raised once the primary has had no replica in `state=online` for 5 seconds, and a CRITICAL once that has lasted 30 seconds. A replica that is attached but still syncing (for example `state=wait_bgsave`) does not count. Both events resolve after one connection sees a synced replica on 2 polls in a row. A replica that is in sync for a single poll does not restart the 30 seconds. An event resolved by hand while the primary still has no synced replica is raised again on the next poll. The message names the primary, its slots, how long the window has lasted and the attached, synced and expected replica counts:

```
CRITICAL: Primary 10.244.4.28:6379 (90735665) for slots 4096-5460 has had no synced replica for 31 s (0 attached, 0 synced, 2 expected). Persistence is off, so losing this node now loses its data. If a rolling update is in progress, pause it until a replica reports master_link_status:up.
```

It only fires for a shard that is expected to have replicas. The expected count is the highest `connected_slaves` the monitor has seen on that shard. It rises at once and is lowered only after 24 hours without seeing it, at which point an open event resolves. A standalone instance or a shard that never had a replica is never reported. Neither is a shard whose replicas were already missing when the monitor first saw it, because nothing is expected yet.

In a cluster, only a primary that owns slots is checked. A restarted node that reports `role:master` with no slots is not a primary at risk. One event per level is open per shard, whichever connections observe it: the connection that reads the cluster, a connection registered for the node itself, or both. The shard is identified by its slot ranges, so a failover or a primary that returns under a new address continues the same episode. A reshard changes the slot ranges of a shard, not its primary, so the shard keeps its expected replica count and its open events. A primary that only took slots from another shard is tracked as a new shard.

Outside a cluster, a primary is identified by its replication ID. Its own connection and [per-node coverage](#per-node-coverage) read the same ID, so they share one episode, and a connection that takes the primary over from another one continues it, also after the monitor restarts. A connection keeps the episode when the primary restarts and gets a new replication ID. A replica that is promoted starts with the replica count its former primary was expected to have, so it is reported when a failover leaves it without a replica.

The CRITICAL is raised at 5 seconds instead of 30 when no replica is attached at all and persistence is known to be off: `aof_enabled:0` and an empty `save`. `save` is read with `CONFIG GET` by the config drift check. When it cannot be read, or when the primary is read through another connection's [per-node coverage](#per-node-coverage), persistence counts as unknown and the CRITICAL waits for 30 seconds.

The detector is not held back during a planned rolling update, because that is when the window appears. If no connection observes the shard for 5 minutes, its open events are closed; for a primary read in rotation by a cluster or Sentinel connection the limit is 3 sweeps when that is longer, so an alert is not closed while its primary waits its turn. They are also closed when the last connection that observed the shard is removed. The expected replica count is kept, so a connection added in its place still alerts when the replicas are already gone.

The thresholds are set with `ANOMALY_PRIMARY_NO_REPLICA_WARN_MS` and `ANOMALY_PRIMARY_NO_REPLICA_CRIT_MS`. Set one to `0` to turn that level off, or both to turn the detector off. The early CRITICAL for persistence being off is raised at the WARNING threshold, so with that threshold at `0` it is off too and the CRITICAL waits for its own threshold.

### hot_shard
**What it measures**: CPU time per second on the slots of each shard, compared with the other shards of the cluster
**Why anomalies matter**: One shard carrying far more than the others is the first to saturate, while the cluster as a whole still looks healthy
**Typical baseline**: Shards within a small factor of each other
**Source**: `CLUSTER SLOT-STATS` on every primary, read by the Prometheus poll (the [shard load metrics](prometheus-metrics.md#cluster-shard-load-metrics-valkey-80))
**Detection method**: State-based detector (not z-score based). A shard is hot when its CPU rate is at least 2 times the cluster median and at least 100,000 CPU microseconds per second (10% of a core). A WARNING is raised once that has held for 60 seconds. It stays open while the shard is at least 1.5 times the median and at least three quarters of the floor, and resolves below that. One event is open per shard. The message names the shard, its address and its top slots by CPU.

The network rate of a hot shard (bytes in plus bytes out) is reported with it as detail, and its share of the cluster's bytes is in the message, but it never raises an event. Bytes out count the replication stream once per replica, so a shard with more replicas, or more writes to replicate, sends more without serving more clients.

The check needs three or more primaries that own slots, and Valkey 8.0+ with `cluster-slot-stats-enabled yes` on every node. It runs on the connection that reads the whole cluster, so a cluster whose nodes are registered one by one as separate connections is not checked. It is also off under the `vitals` export profile and with `METRICS_SLOT_STATS_TOP_N=0`, because the shard load is not measured then.

Nothing is raised, and open events are kept as they are, while slots are moving: during a reshard, for two samples after a slot changes owner, and after a counter reset. `reshard_shard_skew` covers the reshard itself. A slot migration in flight, atomic or legacy, only delays a new event: the 60 seconds start over, and an open event can still resolve. An event that is resolved by hand is raised again only while its shard is at least 2 times the median, and a migration in flight delays that in the same way. The same holds when the monitor cannot ask every primary whether a slot is migrating. A failed or suspect primary that owns no slots is not asked and does not count. On Valkey 9.0+ that includes a monitoring user that may not run `CLUSTER GETSLOTMIGRATIONS`: no new event is raised until it is allowed (see [Minimum ACL](minimum-acl.md)). On Redis 8.4+ a monitoring user that may not run `CLUSTER MIGRATION` is treated differently: events are raised as usual, but its migrations are not seen, so an event can be raised and a rebalance plan suggested while one runs (see [`slot_migration`](#slot_migration)). A Redis import that has kept failing for 10 minutes no longer delays an event once its [`slot_migration_stuck`](#slot_migration_stuck) warning is open. When no complete shard load sample arrives for 5 minutes, or `INFO` or `CLUSTER NODES` cannot be read for that long, open events are closed. That happens for example when one primary keeps failing. A connection that is disconnected is not polled at all, so its open events stay as they are until it is polled again.

**Hot keys**: when the hot primary runs an LFU `maxmemory-policy` (`allkeys-lfu` or `volatile-lfu`), the event also names the hottest keys of the shard. Right before a new event is raised, and at most every 5 minutes while it stays open, BetterDB asks the hot primary for the first 500 key names of each of the shard's top 3 slots (`CLUSTER GETKEYSINSLOT`) and reads the access frequency of each name (`OBJECT FREQ`). That is at most 3 commands plus 1,500 `OBJECT FREQ` calls in 7 round trips, with a 2 second limit for the whole read. It runs no `KEYS` and no `SCAN`, and reads no value. The 10 keys with the highest frequency are kept, and the first 3 go into the message:

```
Hot shard 3f2a9c1e at 10.0.0.1:6379: CPU 3.1x the cluster median (61% of the cluster's slot CPU) for 60s. Top slots by CPU: 1234 (62% of the shard), 88 (9%). Hot keys: "user:42" (freq 255), "cart:{9}" (freq 201).
```

`freq` is the server's LFU counter, not a request count. It runs from 0 to 255, grows logarithmically with access and decays over time, so several keys tied at 255 are normal. It ranks keys against each other; it does not measure their load.

What the read can miss, and when it is skipped:

- `CLUSTER GETKEYSINSLOT` returns the first 500 names of a slot, not the hottest. In a slot with more keys the hottest one can be missed. Compare `keysSampled` with the `keyCount` of the top slots to see how much was covered.
- Without an LFU policy the node keeps no access frequency. The read stops at the first refusal, normally after one `OBJECT FREQ`.
- The monitoring user may lack the two commands (see the [minimum ACL](minimum-acl.md#hot-shard-keys)), the read may time out, the node may answer with another error such as `CLUSTERDOWN` or `LOADING`, or the connection may reach the cluster through an agent, which does not dial the nodes.

In the last two cases the event is raised without key names, the detail has `keySource: "unavailable"` and a `keyNote` with the reason, and the reason is logged once per connection. A later read of an open event that fails, or gets no name, does not take away the names of an earlier one: the detail keeps them with `keySource: "lfu"` and the `keysSampledAt` of the read they come from, and `keyNote` says that the last read gave none and why. The next read is 5 minutes later either way. A name that is not valid UTF-8 is still read, and is shown with replacement characters.

**Key names leave the database with the message.** The message is stored with the event, written to the API log and sent to every webhook subscribed to `anomaly.detected`. It carries at most 3 names, each cut to 64 characters, with control and invisible characters written as `\xNN` or `\u{NNNN}` and quotes escaped. It is written once, when the event is raised; later reads only update the detail. The full list of up to 10 names is returned by [`GET /api/anomaly/hot-shards`](#get-hot-shards) only.

**A capture can show the keys when the read cannot.** When the event has no key names and the monitor connects to the cluster nodes directly, the message ends with one more sentence, for example `Key names are not available (no LFU policy); a capture on this primary can show them.`, and the detail has `captureAvailable: true`. Nothing is started for you: a person starts a [MONITOR capture](monitor.md) on the hot primary.

- In the UI, the Anomalies page shows a notice for each open hot shard without key names, with a **Capture on hot primary** action. The notice does not depend on the selected date range. The action opens the usual start dialog at a duration of 10 seconds instead of 30, which can be changed. The capture stays on the hot primary: the dialog offers no other node and no fan-out. The session page then lists the **Top keys in this capture**.
- By API, take `shardId` from [`GET /api/anomaly/hot-shards`](#get-hot-shards) and send it as `targetNodeId`:

  ```http
  POST /api/monitor/sessions
  Content-Type: application/json

  { "connectionId": "<connection-id>", "targetNodeId": "<shardId>", "durationMs": 10000 }
  ```

  Then read `topKeys` from `GET /api/monitor/sessions/<session-id>/cross-reference?baseline=24h`.

**Hash tags and crowded slots**: moving slots cannot split keys that share a [hash tag](https://valkey.io/topics/cluster-spec/#hash-tags), because a tag pins all of them to one slot. Every open hot shard carries advice on that. The same `CLUSTER GETKEYSINSLOT` read that finds the hot keys gives the names; no LFU policy is needed and no other command is sent. A top slot is named when one tag (the text between the first `{` and the first `}` after it) is shared by at least half of its sampled names and by at least 2 of them. The names are read again every 5 minutes, but a tag is shown only while its slot is still measured on the shard, so a slot moved off by a rebalance or an Isolate drops out at once. Separately, any slot of the shard that holds at least 20 times the median key count of the cluster's slots, and at least 1000 keys, is named, up to 10. The first 3 of each go into the message:

```
... 92% of the sampled keys in slot 1234 share the hash tag {cart}. Splitting that tag in the application spreads them across slots. Slot 88 holds 41000 keys, 40x the median slot.
```

The advice is in the `advice.hashTags` field of [`GET /api/anomaly/hot-shards`](#get-hot-shards), in the `get_hot_shards` MCP tool and on the rebalance card. When the names cannot be read, for example because the monitoring user may not run `CLUSTER GETKEYSINSLOT`, `note` says why, and no tag is named. A tag is shown with the same escaping and 64 character cut as a key name. When a later read of the names fails, the tags of the last good read are kept, with the time of that read.

**Rebalance suggestion**: every open hot shard carries a suggestion, shown in a panel at the top of the Anomalies page, in the `rebalance` field of [`GET /api/anomaly/hot-shards`](#get-hot-shards) and in the `get_hot_shards` MCP tool. It is advice only. BetterDB moves no slot and sends nothing to the cluster for it beyond reads.

The suggestion is one of two things:

- A **plan**: slot ranges to move off the hot shard, the shard each range goes to, and the projected CPU of every shard before and after. It picks the ranges with the fewest keys that carry enough CPU, at most 8 ranges, and the coldest healthy shards as targets, an empty primary first and a shard in the hot shard's availability zone first on a tie. It uses as few targets as will do, at most 4. No target ends above 0.8 of a core or above 1.25 times the projected median: slots move whole, so the planner checks the load of the real ranges and takes slots back off a target that would end over the line. `effect` is `resolves` when the hot shard ends at or under 1.25 times the projected median, and `headroom` when the move only frees at least 25% of the shard's CPU.
- **No plan**, with a `reason`, when moving slots will not help or should wait:

  | `reason` | Meaning |
  | --- | --- |
  | `key_level` | One or a few slots carry the load: the slots that each take at least 20% of the shard's CPU add up to 0.8 of a core or more, or the rest of the slots carry under 25% of the shard's CPU. A slot cannot be split, so the fix is at the key: client-side caching, reads from replicas, or splitting the key. `pinnedSlots` lists them. |
  | `cluster_hot` | All the other shards together cannot take even 25% of the shard's CPU without going over 0.8 of a core or over 1.25 times the projected median. Add a shard. |
  | `too_many_targets` | The other shards have room, but not within 4 targets: the load would have to be spread over more shards than one suggestion covers. |
  | `no_target` | No other healthy primary can take slots. |
  | `unhealthy_node` | A primary that owns slots is failed or suspect. A failed or suspect primary with no slots, such as a node ID the cluster still lists until `CLUSTER FORGET`, does not block a plan and is never a target. |
  | `migration_running` | A slot migration or reshard is running, or the monitor could not ask every primary before it made a new suggestion. |
  | `settling` | Slots changed owner and the slot load is still being measured, or a shard in the last measurement is no longer a primary. |
  | `slots_scattered` | The shard's slots are in too many small ranges to move enough load in 8 ranges. |
  | `covered_by_other_plan` | The plan for another hot shard, once applied, leaves this shard at or under 1.25 times the median, so it gets no plan of its own. `coveredBy` lists those hot shards, each with `shardId` and `nodeAddr`: apply their plans first. |
  | `conflicts_with_other_plan` | No plan for this hot shard fits next to the plans made before it: with all of them applied, a target or a hot shard that an earlier plan resolves would end over 1.25 times the median. It is also the answer when the loads those plans leave give this shard no plan, but the measured loads would. `conflictsWith` lists the hot shards whose plans are in the way, each with `shardId` and `nodeAddr`: apply their plans first, and this shard is planned again from the loads they leave. |

  For `key_level` and `cluster_hot` the event message ends with the reason, for example `Rebalancing will not help: slot 9189 alone is 81% of this shard's CPU. Consider client-side caching, reads from replicas, or splitting key "session:global".` For `no_target`, `too_many_targets` and `slots_scattered` it ends with a short `No rebalance is suggested ...` sentence. The message is written once, when the event is raised, so `unhealthy_node`, `migration_running` and `settling`, which can pass while the event stays open, are never written into it. Neither are `covered_by_other_plan` and `conflicts_with_other_plan`, which change whenever the plan of another shard is made again or withdrawn. Read those from the API or the MCP tool.

A slot that is at least 20% of the shard's CPU is never part of a plan: it would only move the problem. Neither is a slot that carries more CPU than any target has room for. `pinnedSlots` lists both kinds. The projection assumes that a slot's load moves with it one for one.

When several shards are hot, their plans are made one after another, in the order the hot shards are listed, and each plan starts from the loads and the slot counts the plans before it leave, so an empty primary that an earlier plan fills counts in the median of the later ones. The `before` numbers of a later plan already count the slots an earlier plan moves, so two plans never fill the same room on a target twice. Such a plan names the earlier hot shards in `plannedAfter`; the list is empty for a plan that starts from the measured loads. The panel says so under the table of such a plan. A hot shard that is over 1.25 times the measured median, but at or under it once the earlier plans are counted, gets `covered_by_other_plan` and not `settling`; the panel names the shard whose suggestion to apply first.

Each new plan is checked together with the plans before it: with all of them applied, no target and no hot shard that a plan resolves may end over 1.25 times the median of that final state. A later plan that fills another empty primary can fail that check, because the new slot owner pulls the median down under the earlier plans. That plan is then made again without the primaries that are still empty, and when that one fails the check too the shard gets `conflicts_with_other_plan`, and the panel names the shard whose suggestion to apply first. Only what the new plan takes over the line counts: a kept plan that the load has since moved over the line on its own is not held against the plans made after it. `conflictsWith` names the earlier plans that move slots to a shard the new plan would take over the line, or that resolve a hot shard it would take over the line. When there is no such plan it names the ones that share a target with the new plan, and when there is none of those either, all of them.

A later hot shard that gets no plan from the loads the earlier plans leave is planned once more from the measured loads alone. When that gives a plan, the answer is `conflicts_with_other_plan`. When it does not, the answer is the one from the measured loads, `key_level` for example, so a reason and its `pinnedSlots` never describe loads that exist only after plans that nobody has applied.

A plan lists `warnings`, none of which block it: `source_fork` (the hot shard forks for the snapshot while it is the busiest node), `fewer_replicas` (the target has fewer replicas than the hot shard), `target_memory` (the keys moved, at the hot shard's average key size, would take the target past 80% of its `maxmemory`; `memoryShare` is the estimate), `memory_unlimited` (the target has no `maxmemory` limit, so there is nothing to check the moved keys against) and `memory_unknown` (`INFO` could not be read on the target or on the hot shard, or the hot shard reports no keys). The estimate of a plan with `plannedAfter` also counts the keys those earlier plans bring to the same target, each at the average key size of its own hot shard, and is `memory_unknown` when one of those hot shards cannot be read. A target with no `maxmemory` limit is `memory_unlimited` whatever could be read on the hot shards.

A plan also says whether the cluster has one command that does the move, in `support`, and gives the command text in `commands`. BetterDB sends it only when an admin runs the plan (see [Running a plan](#running-a-plan)); otherwise it is there to copy.

| `support` | Meaning | `commands` |
| --- | --- | --- |
| `valkey_atomic` | The hot shard and every target run Valkey 9.0 or later. | One `CLUSTER MIGRATESLOTS` for the whole plan, to run on the hot shard. The server starts all of its moves or none. |
| `redis_atomic` | The hot shard and every target run Redis 8.4 or later. | One `CLUSTER MIGRATION IMPORT` per target, to run on that target. |
| `none` | A shard of the plan runs an older version, or they run different servers. There is no atomic command; BetterDB does not script the `SETSLOT` and `MIGRATE` steps. | Empty. |
| `provider_managed` | The host name of the connection is that of a managed service (ElastiCache, Memorystore, Redis Cloud, Upstash), or a shard of the plan reports a Redis Software or Redis Cloud build (`redis_build_id` in `INFO` contains `redislabs`), which covers such a cluster on its own host name. Nothing else decides it: not the `os` a shard reports, and not `MONITOR_PROVIDER_OVERRIDE`. Use the provider's own resharding. | Empty. |
| `unknown` | `INFO` could not be read on a shard of the plan, so the version is not known. | Empty. |

#### Running a plan

On Valkey 9.0 and later an admin can run a plan from the panel. Running is off unless the monitor is started with `BETTERDB_SLOT_MIGRATION=true`, and it is never started on its own. `rebalance.execution` on a plan says whether it can run: `{ "available": true }`, or `available: false` with the first `blockedBy` that applies, in this order:

| `blockedBy` | Meaning |
| --- | --- |
| `flag_off` | `BETTERDB_SLOT_MIGRATION` is not `true`. |
| `provider_managed` | The connection is a managed service; use the provider's resharding. |
| `unsupported_server` | `support` is not `valkey_atomic`. Redis 8.4+ plans stay copy-only. |
| `not_dialed` | The monitor does not connect to the cluster nodes itself (an agent or an OTLP-ingested connection). |
| `migration_running` | A slot migration is running, or a run from this monitor is starting or running on the connection. |
| `plan_outdated` | A start of this plan found that the slots or the nodes changed. It clears when the plan is made again. |
| `server_refused` | The server refused `CLUSTER MIGRATESLOTS` for this plan, did not answer it in time, or the connection closed after it was sent. It clears when the plan is made again. |
| `observe_mode` | The cluster runs in Observe (see [Placement modes](#placement-modes)). The plan itself is then left out of the hot shards, so this comes only as the `403` of a run (below). |

When the placement mode of the cluster cannot be read, for example while its connection is being removed, a plan that could run is still shown, with `available: false` and no `blockedBy`.

**Run this plan** asks for a confirmation that repeats the moves and the warnings, then sends `POST /anomaly/hot-shards/:shardId/rebalance` with the moves it showed (`{ "moves": [{ "targetShardId", "ranges" }] }`). Before it sends anything the monitor checks again: the plan it holds must have the same moves, a fresh `CLUSTER NODES` must show the hot shard owning every range and the hot shard and every target as healthy primaries, and no primary may list a slot migration. A poll can make the suggestion again during these reads: when its moves are still the same it runs that one, otherwise it answers as below. When the plan changed it answers `409` with `reason` (`plan_changed`, `no_plan`, `slots_moved`, `source_unhealthy`, `target_unhealthy`) and the suggestion it holds now, with its `execution`; when the slots moved, the plan is made again from the next measurement. Until the plan is made again it is offered with `plan_outdated`. A blocker answers `403` with `blockedBy`, and so does a cluster that runs in Observe, set or because its support allows nothing more, with `observe_mode` (see [Placement modes](#placement-modes)). It then sends one `CLUSTER MIGRATESLOTS` to the hot shard, at the address that fresh `CLUSTER NODES` shows, once, on a connection of its own that never resends a command, and does not retry. A server error, for example `NOPERM` or an unknown node, answers `502` with the server's text. No run is recorded, and the plan is offered with `server_refused` until it is made again, so a fixed ACL takes effect with the next plan. When the command does not answer within 2 seconds it also answers `502`, but the migration may still have started, so a run is recorded (see below). The same holds when the connection closes after the command was sent, before any reply from the server. When the connection to the hot shard fails or does not open within 2 seconds, the command was never sent: it answers `502` with why, no run is recorded, and the plan can be started again. When the suggestion changes while the confirmation is open, or the start answers `plan_changed`, the start waits until the new moves are reviewed in the confirmation.

`GET /anomaly/slot-rebalance` lists the latest run started from this monitor for each hot shard on the connection, newest first (a new run from the same shard replaces the one before it), with each move's job found in `CLUSTER GETSLOTMIGRATIONS` by source, target and slots: `starting` (not listed yet, for up to a minute), `running` with its `phase`, `succeeded` (the target owns its slots), `cancelled` (the job finished and the hot shard still owns them a minute later, or the cancel from this monitor was accepted), `failed` with the server's message, or `unknown`. A move that finishes before any read lists it, as a small one can within a second or two, counts as `succeeded` once the target owns its slots, and as `failed` when a job that was not listed before the run failed on the same source, target and slots. A run is `running` while any move is starting or running. The monitor follows a running run on its own poll, so its state and `endedAt` do not wait for anyone to read them. When a primary does not answer the slot migration read, each move is still followed as usual if the hot shard and its target answered; otherwise a move the hot shard lists is `running`, and the move ends `failed` when a failure is listed for it, `succeeded` once `CLUSTER NODES` shows its target owning the slots, `cancelled` after an accepted cancel once the hot shard owns them again, or `unknown` when none of these happened within a minute of reads that missed those nodes. It follows on every slot migration read of the poll, reusing that read and the poll's `CLUSTER NODES` (a run started after that read waits for the next one; after an accepted cancel it reads `CLUSTER NODES` itself, so a move that finished just before the cancel is not taken for a cancelled one), and reads the primaries itself only when 5 seconds passed without a follow; a read of the list in between gets the last state followed. Once every move succeeded and a load measurement taken at least a minute after the end is in, `outcome` gives the projected ratio of the hot shard to the median next to the measured one. When none is in 10 minutes after the end, `outcomeUnavailable` is set and the panel says the load after the move could not be measured. Runs live in memory, are kept while they run, are dropped an hour after they end, and are gone after a restart. When `CLUSTER MIGRATESLOTS` does not answer in time, the start answers `502` but the run is still listed and can be cancelled, because the migration may have started; with no job and no moved slots it ends `unknown` after a minute. The panel shows each run with who started it; members see no email address. The [`slot_migration`](#slot_migration) entries come from their own reads, every 5 or 30 seconds, so a move shorter than one read raises none; the run is the record of it.

**Cancel** (`POST /anomaly/slot-rebalance/cancel` with `{ "sourceShardId" }`) is offered while a run from this monitor is running. It sends `CLUSTER CANCELSLOTMIGRATIONS` to the hot shard, at the address `CLUSTER NODES` shows, which cancels every slot migration on that shard, not only the ones of the run. Slots already moved stay on their target. A move of a cancelled run whose slots the hot shard still owns ends `cancelled`, although the target lists its import as failed, and that failure raises no `slot_migration_stuck` event. A move the server lists as cancelled ends `cancelled`. A move that finished but is listed neither as cancelled nor as failed may have succeeded, so the monitor keeps following it for up to a minute until its target owns the slots: a `CLUSTER NODES` that has not caught up yet does not turn it into a cancelled one. A move that failed before the cancel stays `failed` and keeps its event. The first cancel of a run needs a slot migration read the hot shard answered, so that it knows which moves failed before it; without one it answers `502` and sends nothing. A failure seen while the cancel has not answered raises no event until the cancel is accepted or refused; when it is refused the failure is raised. A failure is matched to a cancelled move that never got a job name only until a minute after the run ends. The run is not advanced until the cancel answers, for at most 10 seconds. When the server refuses it, or the connection to the hot shard fails before the command is sent, it answers `502` and the run keeps running. When it does not answer in time, or the connection closes after it was sent, it also answers `502`, but the cancel may have taken effect, so the run is followed as after an accepted cancel. A run that has already ended answers `409`. Both requests need the admin role and are recorded in the activity log as `slot_rebalance.run` and `slot_rebalance.cancel` with the hot shard as the target. The monitoring user needs `+cluster|migrateslots` and `+cluster|cancelslotmigrations` (see [Minimum ACL](minimum-acl.md#commands-that-change-data-or-server-state)).

The suggestion is computed right before the event is raised and again every 5 minutes, or sooner when slots change owner, an empty primary joins or leaves, a shard that the plan moves slots to turns hot, or a primary that owns slots turns suspect, failed or healthy again. A shard that turns hot or stops being hot changes nothing else until the next 5 minutes are over, so one shard that goes over and under the line does not make every plan change with it. A `migration_running` or `settling` answer is not kept: it is computed again from every new measurement. A `covered_by_other_plan` or `conflicts_with_other_plan` answer is kept like a plan; it is computed again whenever a plan it names is, and it is withdrawn with that plan when a migration is found. A plan with `plannedAfter` is likewise computed again whenever a plan it names is, in the same call and in the order the hot shards are listed, so two kept plans never count each other as applied. A plan is withdrawn at once, without waiting for a new measurement, when a primary that owns slots turns failed or suspect or a measured shard stops being a primary. While a plan is kept, and whenever the suggestion is computed, a new measurement asks every primary whether a slot is migrating, unless a primary is failed or suspect (the answer is then `unhealthy_node` without asking). A kept plan is withdrawn as soon as a migration is found. When a primary does not answer and none of the others reports a migration, kept answers stay as they are, also past the 5 minutes, and are computed again once every primary has answered; a hot shard with no kept answer gets `migration_running` until then. A kept answer with no plan, `key_level` for example, stays as it is until it is computed again, and no primary is asked in between. For new plans it then reads the `memory`, `keyspace` and `server` sections of `INFO`, once on each hot shard and each target, after the hot key read has finished.

Before you start one:

- `MONITOR` makes the node send every command it runs to the capture connection. On a primary that is already hot this adds load, so keep the capture short. The usual limits of a capture apply: its duration, its byte and line caps, and one capture per connection at a time.
- The pre-flight health check is advice for a capture a person starts; it does not block it. The check and the throughput estimate are read from the node the connection points at, not from the hot primary. A hot primary runs more commands, so expect more lines and bytes than the estimate shows. The check looks at memory, recent OOM events, failover and replication, not at CPU.
- A capture counts the first argument of a command as its key. `MGET a b c` counts `a` only, an `EVAL` counts its script text, and a command without a key, such as `CLUSTER NODES`, counts its first word.
- The capture is not offered for a connection that reaches the cluster through an agent, because the monitor cannot open `MONITOR` on a node there.

#### Placement modes

Each cluster has a placement mode, shown with its support and the load of every shard in the **Slot placement** card on the Cluster page. The mode is stored on the cluster's seed connection, so every node connection of the cluster shares it.

| Mode | What it does |
| --- | --- |
| Observe | Shows the load and the imbalance, and why a hot shard cannot be fixed by moving slots. No plan is shown and none can be run: `GET /anomaly/hot-shards` and the MCP `get_hot_shards` leave the plans and their commands out too, and so the `covered_by_other_plan` and `conflicts_with_other_plan` answers, which point at a plan. |
| Recommend | Shows the plan with the projected load, as described above. An admin can run it (see [Running a plan](#running-a-plan)). |
| Approve | Not available yet. |
| Auto | Not available yet. |

New connections start in Observe. Clusters that existed before the upgrade start in Recommend, so their plans and run button stay. With in-memory storage no mode is kept across a restart: a cluster without a stored mode runs in Recommend, as it did before, until an admin picks another mode. A plan without a run button is still advice: in Observe the panel on the Anomalies page shows only the hot shards without a plan, with their explanation. Until the placement status has loaded, the Anomalies page shows no plan; when it cannot be read, plans are shown without the run button.

When one slot carries the load (`key_level`), the explanation also advises moving that slot to a shard of its own (Isolate). This is advice only: BetterDB does not run it.

**Support.** Whether a mode can be used on a cluster depends on what the monitor can see and do there. Every reason that applies is listed, in this order:

| Reason | Meaning | Blocks |
| --- | --- | --- |
| `not_connected` | The monitor has not connected to the cluster yet. Nothing else is checked, and the verdict is read again on the next request. | Recommend and up |
| `not_cluster` | The connection is not in cluster mode. Nothing else is checked. | Recommend and up |
| `provider_managed` | A managed service (by host name, a Redis Cloud build, or `MONITOR_PROVIDER_OVERRIDE`). Slot moves go through the provider's resharding. When `MONITOR_PROVIDER_OVERRIDE` is set it decides alone, for this reason and for the run button of a plan: `self-hosted` clears it whatever the host name or build says. | Approve and up |
| `per_node_connections` | The cluster's nodes are registered one by one, so no connection sees the whole cluster. | Recommend and up |
| `slot_stats_off` | Per-slot load is not collected: `METRICS_SLOT_STATS_TOP_N` is `0`, `CLUSTER SLOT-STATS` is unavailable, or its replies carry no CPU and network counters (`cluster-slot-stats-enabled` is off). | Recommend and up |
| `not_dialed` | The monitor reaches the cluster through an agent or OTLP and cannot open node connections. | Recommend and up |
| `server_version` | A primary runs a server older than Valkey 9.0, or its version could not be read. The detail names the nodes. | Approve and up |
| `copy_only` | Every primary runs Redis 8.4 or later: the plan is shown as commands to copy, and BetterDB does not run it. | Approve and up |
| `command_unavailable` | `CLUSTER MIGRATESLOTS` is renamed, disabled, or could not be checked on a primary. | Approve and up |
| `acl` | The server refused `CLUSTER MIGRATESLOTS` to the monitoring user (`NOPERM`). It is kept until the primaries of the cluster change, or the monitor restarts. | Approve and up |
| `flag_off` | `BETTERDB_SLOT_MIGRATION` is not `true`. | Approve and up |
| `memory_storage` | The monitor uses in-memory storage. Approve and Auto need sqlite, turso or postgres. | Approve and up |
| `no_sign_in` | The install runs without sign-in. | Auto |

Observe is never blocked. When the stored mode is blocked, the cluster runs in the highest mode below it that is not, and the card says why. The verdict is computed when it is read and kept for 30 seconds. Whether a plan is shown and can be run reads the stored mode first: Observe asks no node, and Recommend checks only the reasons that block it, so a slow primary does not hold up the hot shards or the run.

**API.** Both routes take the connection in `X-Connection-Id` and need the Anomaly Detection feature (Pro).

- `GET /api/anomaly/placement` answers `{ connectionId, mode, effectiveMode, selectableModes, support, balance }`. `connectionId` is the seed connection. `support` has `issues` (each with `reason`, `detail`, and `provider` for `provider_managed`) and `modes`, which gives `available` and `blockedBy` for every mode. `balance` lists each shard with its `address`, `slotCount`, `cpuUsecPerSecond`, `cpuShare`, `networkShare`, `ratio` to the median (`null` for a shard without slots) and `overTrigger`, with the `medianCpuUsecPerSecond`, the `triggerRatio` (2) and the `resolveRatio` (1.25); it is `null` until a load sample is in, and again once the latest sample is older than the metrics staleness bound, and `overTrigger` is never set while the load is `settling` or with fewer than 3 shards that own slots.
- `PUT /api/anomaly/placement/mode` with `{ "mode": "observe" }` or `{ "mode": "recommend" }` sets the mode and answers like the `GET`. It needs the admin role. A mode that is not available yet, or one the cluster does not support, answers `400` with the reason in `message`; for a mode the cluster does not support, `blockedBy` names the blocking reason. It is recorded in the activity log as `placement.mode`, with the seed connection as the target.

The `get_placement_status` MCP tool returns the same as the `GET`.

### slot_migration
**What it measures**: Slot migrations in flight on a cluster: atomic jobs (`CLUSTER MIGRATESLOTS`, Valkey 9.0+), atomic tasks (`CLUSTER MIGRATION IMPORT`, Redis 8.4+) and the `MIGRATING` / `IMPORTING` markers of the older `SETSLOT` and `MIGRATE` steps
**Why it matters**: It puts the migration on the timeline, so a latency or load event that happens while slots move can be read next to it
**Source**: `CLUSTER NODES` and `CLUSTER GETSLOTMIGRATIONS` on every primary; `CLUSTER MIGRATION STATUS ALL` on a primary that does not know `CLUSTER GETSLOTMIGRATIONS`
**Detection method**: State-based (not z-score based). An INFO event opens when a migration is first seen and resolves when it is no longer running, however it ended. There is one event per atomic job, and one per pair of source and target node for the older markers, whatever the number of slots.

```
INFO: Slot migration running: slots 0-1365 from 10.0.0.1:6379 to 10.0.0.3:6379. This entry closes when the migration ends.
```

The cluster is read every 30 seconds, and every 5 seconds while the latest read lists a migration, so a job that starts and ends between two reads gets no entry. An entry kept open while its nodes cannot be read does not keep the faster pace; a move with the older markers keeps it for the 30 seconds it is kept after its last listing (see below). A migration is watched whoever started it. A primary that has neither `CLUSTER GETSLOTMIGRATIONS` nor `CLUSTER MIGRATION` is asked again after 5 minutes, not on every read; the `hot_shard` check and the Cluster dashboard ask every primary every time. When the monitoring user may not run `CLUSTER GETSLOTMIGRATIONS` (`NOPERM`), the markers of the older moves are still watched and their events open and close as usual, but atomic jobs are not seen and an entry for one stays as it is. The refusal is logged once per connection. On a cluster registered through a seed, the seed connection watches and its member connections do not; nodes registered one by one as separate connections each raise their own events.

On Redis 8.4+ a task the source or the target lists in any state other than `completed` or `canceled` is a running migration: it gets its entry, holds back `hot_shard` and the rebalance suggestion, and its entry closes once a node lists it as `completed` or `canceled`. That includes an import in `failed`: its target retries it every second until it completes or is canceled, so the entry stays open across the retries. An import that keeps failing for 10 minutes raises [`slot_migration_stuck`](#slot_migration_stuck), and while that warning is open it no longer holds back `hot_shard` and the rebalance suggestion. A `failed` task on the source is left out, because the source keeps it until the target retries it or a new migration replaces it. Redis tasks are seen only when the monitoring user may run `CLUSTER MIGRATION`. Redis has no narrower grant: `+cluster|migration` also allows `CLUSTER MIGRATION IMPORT` and `CANCEL` (see [Minimum ACL](minimum-acl.md)). Without it the refusal is logged once per connection and the read counts as having found no tasks, so `hot_shard` still raises events and the rebalance suggestion can propose an import while one runs. A primary that refuses is asked again by the watch after 5 minutes.

A connection through the BetterDB agent is not watched: the monitor reaches only that one node through the agent and cannot ask the primaries. When the monitor can open its own sockets but no primary answers on the address the cluster reports for it, as behind NAT or an SSH tunnel, it reads the connection's own node instead, over a socket of its own that it keeps across those reads and closes once it has gone unused for 5 minutes. What it reads there is filed under the node that socket's own `CLUSTER NODES` names as `myself`: behind a VIP a new socket can land on another node than the one discovery reached. A read that reaches no primary, as during a short network blip or a failover, falls back to the own node for that read only; once no read has reached a primary for a minute, the monitor reads only the own node and tries the primaries again after 10 minutes. From one node it sees only the migrations that node is the source or the target of. A node that only follows a job, such as a replica, lists it without its source and target, in the state `occurring-on-primary`; the entry for it closes when that node lists the job as finished.

While the nodes of a migration cannot be read, its events stay as they are: a read that fails does not close them. A move with the older markers is kept for 30 seconds after the last read that listed it, so a read that lands between two slots of a reshard, when neither node carries a marker yet, does not close its events and open new ones. The same holds after the monitor restarts. An entry that was open stays open until the monitor sees the migration again, a node lists the job as finished, both nodes of a move with the older markers answer without them, or a read covers every primary. Where the monitor reads only the connection's own node, an entry for the older markers, or for a job between other nodes, therefore stays open when the migration ended while the monitor was down; resolve it by hand.

### slot_migration_stuck
**What it measures**: A slot migration that stopped making progress, or an atomic job that ended as `failed`
**Why it matters**: A migration that hangs keeps slots in a half-moved state and holds memory on both nodes; a failed one means the move you asked for did not happen
**Source**: The same reads as [`slot_migration`](#slot_migration)
**Detection method**: State-based (not z-score based). Four cases raise a WARNING:

| Case | Rule | Resolves |
| --- | --- | --- |
| Atomic job stuck | The job is still active, its state and `last_update_time` have not changed for 10 minutes, and in that time its `remaining_repl_size` has not dropped below the lowest value seen since the last change. `last_ack_time` is not used: the two nodes exchange a heartbeat every second while their link is up, and Valkey fails a job itself after `repl-timeout` (60 seconds by default) without one. The source and the target each report the job, and each is compared with what that node reported before, so a read that hears from only one of them is not taken as progress. A job is called stuck only on a read that hears from its source, once the source itself has been watched for those 10 minutes; a source read for the first time, as when the monitor reaches the primaries again after reading only its own node, starts that count. The target's state and `last_update_time` stay the same while the source drains its backlog, and only the source reports that backlog. A read that hears only from the target keeps an open warning but raises none. A job for which the server sends no `last_update_time` is never called stuck. Neither is a job whose source is taking the snapshot (`snapshotting`): the server reports no progress inside a snapshot, so a large one would look stuck. A node that only follows a job (`occurring-on-primary`: a replica, a primary that loaded it from its AOF or RDB file, or a target that lost its primary role) reports nothing that moves, so what it says neither raises nor closes a warning. What this catches is a job held back before its snapshot (`waiting-to-snapshot`, usually behind a save or an AOF rewrite) or one whose backlog does not drain before the pause (`waiting-to-pause`) | When the state or `last_update_time` changes on either node, the backlog drops to a new low, or the job ends |
| Redis import keeps failing | Redis 8.4+ only. A failure is a read of the target that lists the import as `failed`, or with `retries` above the last count the monitor saw, so a read that misses the target loses none. While the import is failing, only a read of the target can end it or age it: the source does not list its own failed task, so a read that reaches only the source neither closes the warning nor counts toward the 10 quiet minutes. Redis starts the next attempt within a second of a failed one, so the import is seldom seen as `failed`; one attempt can last `repl-timeout` (60 seconds by default) or the time a connect takes to give up. A failure counts once, however many reads see it: a read that sees the import `failed` and a later one that sees its `retries` gone up are the same failure, but each read that finds it still `failed` with the same count is one more, since that is a retry held back. The import is failing from its first failure until 10 minutes pass without a new one, and is called stuck once it has at least three failures seen across 10 minutes, from the first to the latest. Redis retries with no limit, and holds the retry back while `min-replicas-to-write` is not met (the import then stays `failed`), so such an import does not end by itself. The message quotes the task's `last_error` and names `CLUSTER MIGRATION CANCEL ID <id>`, run on the target. While the warning is open, the import no longer holds back `hot_shard` and the rebalance suggestion | When a read of the target shows 10 minutes without a new failure or no longer lists the import, or the task ends |
| Older markers stuck | The same slots carry `MIGRATING` / `IMPORTING` markers between the same two nodes for 30 minutes | When the set of slots changes, or the markers are gone |
| Atomic job failed | The job is listed with state `failed`. The message carries what the server said, cut to 200 characters | Not by itself: it reports something that happened. Resolve it once you have read it |

Other Redis 8.4+ tasks are never called stuck: `CLUSTER MIGRATION STATUS` sends no last-update time. No Redis task raises the failed case either, since a `failed` task is one Redis retries or replaces, not a migration that ended.

```
WARNING: Slot migration stuck: slots 0-1365 from 10.0.0.1:6379 to 10.0.0.3:6379 has not changed state or cut its replication backlog for 10 minutes (state: waiting-to-pause). Check for a save or AOF rewrite running on 10.0.0.1:6379, which holds back the snapshot, and for writes to these slots arriving faster than the target takes them, which keep the backlog from draining. To stop it, run CLUSTER CANCELSLOTMIGRATIONS on 10.0.0.1:6379. That cancels every migration that node is the source of, not only this one.
```

```
WARNING: Slot migration stuck: slots 0-1365 from 10.0.0.1:6379 to 10.0.0.3:6379 has kept failing for 10 minutes, and its target has retried it 11 times. The server said: "Main channel - Connection timeout (state: failed, rdb_channel_state: none)". Check that 10.0.0.3:6379 can reach 10.0.0.1:6379 and log in to it, and that 10.0.0.3:6379 has the memory and the good replicas the import needs. To stop it, run CLUSTER MIGRATION CANCEL ID 7f3a9c0e1b2d4f6a8c0e1b2d4f6a8c0e1b2d4f6a on 10.0.0.3:6379.
```

`CLUSTER CANCELSLOTMIGRATIONS` has no job name: it cancels every active migration the node it runs on is the source of. Check what else that node is moving before you run it.

The quiet time is counted on the monitor's clock from the moment it last saw a change, not by comparing the server's timestamps with it, so a clock difference between the two does not matter. It starts again when the monitor restarts. A warning that was open before the restart stays open until the monitor sees the job's state or update time change, its backlog drop, the slots change, or the migration end. That also holds when only the target of the job can be read.

A failed job is reported once. Jobs that were already in a node's list when the monitor first read that node are not reported, so a restart does not repeat old failures; a job that failed while the monitor was down is missed. A job that starts and fails between two reads is still reported while a node the monitor can read still lists it. A node keeps finished jobs in memory only, up to `cluster-slot-migration-log-max-len` of them (1000 by default), and loses the list when it restarts.

BetterDB never cancels or restarts a migration.

### topology_divergence
**What it measures**: Whether the nodes of a cluster describe the same cluster. Several nodes are asked for their own `CLUSTER NODES` and the answers are compared
**Why anomalies matter**: Every other cluster check reads one node's view. When a zone or a single node is cut off, the nodes on each side still answer, and each view looks consistent on its own. Only the comparison shows that they disagree
**Typical baseline**: Every sampled node reports the same failure flags, config epochs, slot owners and members
**Source**: `CLUSTER NODES` on a sample of nodes, each on that node's own connection
**Detection method**: State-based detector (not z-score based). It runs on gossip clusters only, not under Raft.

**Which nodes are asked.** One round runs every 5 seconds for each cluster, however many connections watch it. The node the connection points at always takes part. On top of that:

- When the nodes report availability zones (Valkey 9.1+ `availability-zone`, or zones configured on the connection), one node is asked per zone, so a zone that is cut off is always on one side of the comparison.
- Nodes without a zone share a quota of 3. When the zones give fewer than 3 nodes in total, more are added until there are 3.
- A node that is registered as its own connection is preferred. When that connection has polled since the round before, its view is taken from that poll at no extra cost; each such view is used in one round only. Primaries are preferred over replicas.
- The same nodes are asked again in the next round. A node that does not answer is replaced, unless it is part of a disagreement that is still being counted.
- A node that another node flags `fail?` or `fail` is asked for its own view as well, at most 2 such nodes per round. That is how a node that is cut off in one direction only shows up.
- No round asks more than 12 nodes. In a cluster with more zones than that, some zones are not sampled.

**What is compared.** For every node that two or more views describe:

- failure flags: one view marks it `fail?` or `fail`, another does not. A node's opinion of itself is not counted.
- config epoch
- slot owner: two views name different owners for the same slots. Slots that the same nodes disagree about in the same way are one disagreement. A slot that joins such a disagreement later is added to the event's slot list in the report once it has disagreed for 3 rounds itself; the message of the event keeps the slots it was raised with. When two nodes claim a slot at the same config epoch, every view is read as giving it to the node with the smaller id, so the order of `CLUSTER NODES` alone never makes a disagreement
- membership: one view knows the node, another does not or still has it in handshake

**When an event is raised.** A disagreement has to be seen in 3 rounds in a row, about 10 seconds. A disagreement about failure flags also has to last one `cluster-node-timeout` (read from the cluster, 15 seconds when it cannot be read), because nodes legitimately disagree for that long while a failure is being detected. A membership disagreement has to last 60 seconds, so a node that is joining or was just forgotten is not reported. A membership disagreement about a node that is alive and has only partly joined is not part of this event: it raises [`partial_membership`](#partial_membership), with the command that repairs it. So does a slot owner disagreement that exists only because that node's own view lacks the owner: no slot owner event is raised for it while `partial_membership` covers the node. A slot owner disagreement is also held back while one of the two owners is still migrating those slots (`MIGRATING`/`IMPORTING` markers, or an unfinished job in `CLUSTER GETSLOTMIGRATIONS` on Valkey 9.0+); when an owner cannot be asked, only the view it gave in that round is checked for those markers, and without such a view the disagreement is reported. A membership disagreement that moves between this event and `partial_membership`, in either direction, is counted afresh from that round, so the move never raises the other event at once.

All disagreements that put the same nodes against the rest are one event. The event names the smaller side first:

```
Cluster views diverge for 15s: 10.0.1.5:6379 (eu-west-1a) disagrees with 10.0.2.7:6379 (eu-west-1b), 10.0.3.2:6379 (eu-west-1c) about the failure state of 12 nodes and the owner of slots 0-5460.
```

The time is given in seconds up to two minutes, then in whole minutes, hours or days, rounded down. The same holds for [`partial_membership`](#partial_membership).

It is CRITICAL when slot owners are in dispute, because clients can then be sent to different nodes for the same key, and a WARNING otherwise. When the nodes of an open WARNING start to dispute slot owners as well, the WARNING is closed and a CRITICAL event is raised in its place. An open event is not lowered when the slot dispute ends. When exactly one node stands against the rest, the event carries that node's address as `nodeAddr`. The text is written when the event is raised; [`GET /api/anomaly/topology-divergence`](#get-topology-divergence) returns the current state. [`GET /api/anomaly/topology-disagreements`](#get-topology-disagreements) returns the same state as one line per disagreement with the number of views on each side, and one line per shard, which stays readable on a cluster of hundreds of nodes.

In the web app the same summary is on the **Disagreements** tab of the Cluster page (`/cluster?tab=disagreements`). Each disagreement is one card with the number of views on each side and links to the nodes on it; a line that an open event covers has an **Open event** link to the incident of that event, or to the Anomaly Detection page when the event is older than 30 days. The link opens under the connection that holds the event. A disagreement the last round could not check again shows the time it was last seen, the words "not checked again this round" and no counts. While an event is open for it, it stays in the list and in the count on the tab; without an event it is listed apart under **Not confirmed this round** and is not counted. On a merged line a side names every node that holds it, and `+N more` counts the nodes that are not listed; the table of epochs per node ends with the same count. Below the cards every shard is one row: `Disputed`, `No disagreement` or `Not compared`, with a link to its disagreements and to the unconfirmed ones, and **Only disputed** hides the rest. The tab shows how many nodes were asked and how many answered, and says so when the counts are over a sample of the cluster. **Ask every node** runs a [full check](#start-a-full-topology-check): every node is asked once and the counts are then over the whole cluster. On a self-hosted install with user control on, only an admin can start one; a read-only member sees a line that says so in place of the button, and can still look at a check an admin ran. While it runs the tab shows how many nodes were asked; when it finishes the tab switches to the result, and **Sampled (live)** switches back. The result of a full check does not update, and the tab says so once it is more than a minute old. When a check fails the tab says when and why, and the result of the check before it stays on offer under its own time. Switching to another connection goes back to the sampled result. The tab needs the anomaly detection licence.

**When it closes.** The event closes after the views agree for 3 rounds in a row. A round in which the disagreement shows again starts that count over. A round in which the nodes of one side do not answer, or fewer than two views could be read, is neither agreement nor disagreement: the count is kept as it is and the event stays open. When that lasts 5 minutes the event is closed. A membership disagreement is held in the same way while a node that lacked the member gives no view, also when another node that lacked it has learned it meanwhile: what the silent node would say is not known, so such a gap can keep the event open for those 5 minutes. That hold is not applied for a silent node that every answering view that lists it flags `fail` or `fail?`. Such a node is taken for dead, and the disagreement is judged by the views that answered. An event that is resolved by hand is raised again while the views still differ. The event of a connection that is removed is closed. After a restart the open event is picked up instead of raised a second time.

**What it costs.** Each round sends one `CLUSTER NODES` to at most 11 other nodes, in parallel, with 2 seconds each. The reply has one line per node of the cluster, so it grows with the cluster. A node that does not answer is asked less often, down to once every 8 rounds. A node that is registered as its own connection is not asked in a round for which that connection has read `CLUSTER NODES` itself since the round before; when it has not, in a large cluster because it waits for [its turn](#topology-reads-in-a-cluster-with-many-connections), the node is asked like any other. The round runs inside the poll of the connection that samples the cluster, the reader of the cluster when it can dial the other nodes, so a node that hangs can hold that poll for about 4 seconds (2 to connect, 2 to answer) until it is backed off. A round that counts a failure flag disagreement also reads `cluster-node-timeout` at most once in 5 minutes, and one that confirms a slot owner dispute asks up to 3 owners for their migrations. A connection that reaches the cluster through an agent never runs the rounds, because the monitor cannot dial the other nodes there. When another connection that can dial them watches the same cluster, that one samples it, and the view of the agent connection is used like that of any registered connection. When only agent connections watch a cluster it is not sampled, and the report says `insufficient_views`.

**What it cannot see.**

- A disagreement among nodes that were not sampled. With the default of one node per zone, a single cut-off node is only caught when it is the sampled one or when a sampled node flags it. Raise `ANOMALY_TOPOLOGY_DIVERGENCE_NODES_PER_ZONE` to widen the sample, or run a [full check](#start-a-full-topology-check) to ask every node once.
- A partition that heals in less than 3 rounds, and a node that flaps in and out of `fail?` faster than that. The count starts over each time the views agree.
- A partition the monitor is on one side of. The nodes it cannot reach give no view, so there is nothing to compare them with, and no event is raised. They are listed as `unanswered` in the report, whose `status` stays `ok` as long as two views could be compared; when no other node answers at all it says `insufficient_views`. The views it does get then agree that the other nodes are failing. `cluster_state` and the fan-out coverage report that case.
- The two sides are in the `message` as text only. The webhook payload has no separate field for them; the full lists are in the report.

### partial_membership
**What it measures**: Whether a node has joined the cluster on every node or only on some. It looks for a node that some sampled views list and others do not have, or still hold in `handshake` or without an address (`noaddr`)
**Why anomalies matter**: A `CLUSTER MEET` that reached only part of the cluster, or a cluster bus port that is blocked between two nodes, leaves a node that some peers talk to and others never learn. Each node's own view looks fine, and the cluster does not repair it while the handshake keeps failing
**Typical baseline**: Every sampled view lists the same nodes
**Source**: The views of the [`topology_divergence`](#topology_divergence) round. No extra command is sent
**Detection method**: State-based detector (not z-score based). It runs on gossip clusters only, and not at all when `ANOMALY_TOPOLOGY_DIVERGENCE_ENABLED` is off.

**What counts.** A broken link is a peer that answered and lacks a node another view lists: the node is missing from its view, or is there in `handshake` or `noaddr`. A peer that gave no view is never counted as lacking a node. A stuck join usually shows in both directions: two peers lack the new node, and the new node's own view lacks those two peers.

**Which node is named.** Each broken link is filed under its newer end. A node that owns slots is never the newer end against one that owns none. Between a replica (flagged `slave` or `replica`) and an empty primary, a node that holds no slots and is no replica, the empty primary is the newer end only when a slot owner lacks it: a slot owner cannot itself be the node that is joining, so its gap shows that the empty primary is. Without that the two count as alike. An empty primary the cluster knows that has not yet learned a new replica is then the peer to run the command on, and the replica is named; a new replica or a second new node that has not learned the empty primary is no sign that it is new. Two empty primaries always count as alike, and so do two replicas. What a node is, is read from its own view when it gave one. When it gave none, it is taken from the views of its peers: it owns slots when any of them shows slots for it, and is a replica when any of them flags it so, so the order in which the views were read does not matter. When both ends are alike, it is the node that is not known. When neither knows the other, it is the one that already has an open event, then the one more peers lack, then the one with the smaller id. A node whose event was resolved by hand still counts as having an open event for this, until the event is raised again or the finding is gone. An empty primary and a new replica that lack only each other are each lacked by one peer, so between them it is the one with an open event, and the smaller id when neither or both have one. The peers that lack a node are counted from the links that are kept, so the name does not change in a round in which some of them gave no view. A slot owner that has not yet learned two new nodes is therefore never the named node: each new node gets its own event, and the slot owner is the peer to run the command on. All links filed under a node are one finding. Each link is counted on its own, from the round its peer first lacked the other node: a peer that stops listing a node starts at zero, however long another peer has lacked that node. The count is kept through rounds in which that peer gave no view, until it has given none for 5 minutes; after that it starts over. A round in which the monitor could read no other node is such a round for every peer. The count also ends as soon as a view of that peer lists the node again, so a later gap starts at zero.

The lists name only peers that gave a view in that round. A disagreement that is held because one side gave no view keeps the finding, but the unread peer is left out of the lists and of the command. The link of a peer that gave no view is kept in the same way while other peers still show the same disagreement, and also when another peer that lacked the node has learned it meanwhile, for as long as its count is kept: a node that lacks a peer and gives no view for a few rounds keeps its finding, and when it answers again its count goes on where it was. The peers that did answer are judged by the view they gave in that round: `Known by` names the peers that list the node in that round, so one that has learned the node since is named there and is left out of `Not known by` and of the command, and one that no longer lists it is left out of `Known by`. A link that is gone in this way no longer sets how long the node has been partly joined, as long as another link is left.

A peer that gave no view is taken for dead, not silent, when every peer that lists it flags it `fail` or `fail?`. Its link is dropped in that round and not kept for the 5 minutes: when it was the node's last link, the finding ends and the event closes after 3 rounds as usual. No `CLUSTER MEET` can be run on a dead peer. When that peer was the only one that lacked the node, the gap it last showed is still listed in the report under `divergences` as being counted, until its count is given up after at most 5 minutes; no `topology_divergence` event is raised for it (see [the report](#get-topology-divergence)). When another peer that lacked the node has learned it meanwhile, the gap of the dead peer is dropped in that round. A peer that only gives no view, and that at least one peer lists without those flags, keeps its link.

A node whose own view could not be read is only counted when a peer lists it without `fail` or `fail?`. When every peer that lists it flags it as failing, it is half removed, not half joined, and `CLUSTER MEET` is the wrong advice: that case stays a membership disagreement of `topology_divergence`. When a node moves from one case to the other, its disagreement is counted afresh from that round: the other event is raised only after the node has stayed in the new case for that event's full time, 60 seconds for `topology_divergence` and 90 seconds here, and the event of the old case closes as usual (see below). A flag that comes and goes before that event has closed leaves it as it is and raises no second one.

**When an event is raised.** The finding has to be seen in 3 rounds in a row and to last 90 seconds. The 3 is the default of `ANOMALY_TOPOLOGY_DIVERGENCE_MIN_POLLS`: wherever this section counts 3 rounds, to raise or to close, it is that setting. `CLUSTER FORGET` bans a node for 60 seconds and a forgotten node that is still alive comes back through gossip right after, so a shorter wait would report it. A node that joins normally is known everywhere well inside that time and raises nothing. There is one WARNING per node, with the node's address as `nodeAddr`. Its `value` is the number of peers the node has a broken link with in the round the event is raised. A peer is counted once, also when the link is broken in both directions, and a peer whose link is kept through a round in which it gave no view is still counted. A peer that has learned the node since is not counted. The event is raised only in a round that shows the finding, so the value is at least 1, and an open event keeps the value it was raised with:

```
Node 10.0.0.7:6379 has only partly joined the cluster for 95s. Known by 10.0.0.1:6379. Not known by 10.0.0.2:6379 (missing), 10.0.0.3:6379 (stuck in handshake). Its own view is missing 10.0.0.2:6379, 10.0.0.3:6379. Run `CLUSTER MEET 10.0.0.7 6379` on 10.0.0.2:6379 and 10.0.0.3:6379. If it still does not join, check that cluster bus port 16379 is reachable between them. BetterDB does not run this command.
```

The time is written as in [`topology_divergence`](#topology_divergence): seconds up to two minutes, then whole minutes, hours or days, rounded down. The text is written when the event is raised; [`GET /api/anomaly/topology-divergence`](#get-topology-divergence) returns the lists of the latest round in `partialMembership`, and no command once the node is no longer found (`seen` is `false`).

**The command.** `CLUSTER MEET` run on one node for another repairs that pair in both directions, so the event gives one command, naming the half-joined node, and the peers to run it on: every peer that lacks the node and every peer the node's own view is missing. Running it on a third node that knows both fixes neither. The address is the one most peers that list the node without `fail` or `fail?` reach it at, with the bus port they give; an IPv4 address and its IPv6 mapped form count as the same. A peer that flags the node as failing may still hold the address it had before a restart, so its address is left out, however many such peers there are. The address the node gives for itself breaks a tie and is used when no other peer gives one. Only when there is neither is the address taken from the peers that flag the node as failing. The bus port is added as a third argument when it is not the port plus 10000. When no view has an address for the node, the message says so and gives no command. The same holds when the address has a host name where the IP should be, because `CLUSTER MEET` takes an IP address, and when none of the peers that showed the gap gave a view in that round, because there is then no node to run it on. In all three cases the report has `command: null`. BetterDB never sends the command. If the cause is a blocked bus port the `MEET` does not hold, which is why the message names the port to check.

**When it closes.** The event closes after 3 compared rounds in a row without the finding: every view that answers lists the node and the node lists them, or no view lists it any more. A round in which the peers on one side of its links gave no view, or fewer than two views could be read, is neither: the event stays open, for at most 5 minutes. That also holds when another peer still shows the same disagreement in that round. An event that is resolved by hand is raised again while the node is still half known. The event is closed when the connection that holds it is removed; a connection that still watches the cluster raises it again once the finding is confirmed. After a restart the open event is picked up instead of raised a second time. When the node a finding is filed under changes, the old event is handed over to the finding under the new node once that finding is confirmed: the old event is closed in that round and the new one is raised in it. Until then, while the new finding is still being counted because its own link has not lasted 90 seconds, the old event stays open, so one event is open the whole time. The report lists the old event with `seen` `false` and the new finding as being counted, with the disagreement under the new finding only. When the new finding ends before it is confirmed, the old event closes after the usual 3 rounds. The old event stays open in this way for as long as the new finding is kept: until its link has lasted 90 seconds, and through rounds in which a peer of that link gives no view for at most 5 minutes. One case is left to the 3 rounds, so the old and the new event can be open together for that long: a round in which the old node or a peer that lacked it gave no view, because a missed read is not a change of name. An event picked up after a restart is handed over in the same way, by the finding last seen for it since the restart, also when that finding was not confirmed again. When no round since the restart has shown its finding, there is nothing to hand over: the old event closes after the 3 rounds and the new one is raised once its own finding is confirmed, so no event is open in between.

**How it relates to `topology_divergence`.** A membership disagreement that belongs to a finding here does not count toward a `topology_divergence` event. When the named node's own view lacks a slot owner, that view names no owner for the owner's slots either. The missing link explains this slot owner disagreement, so it is held back from the first round the finding is seen, before the WARNING is raised: no CRITICAL slot owner event is raised for it, and the report lists it under the finding. It is held only when the named node owns no slots, its view names no owner at all for the slots, and every view that names none is that of a named node that lacks the owner. It stays with `topology_divergence`, and is raised as CRITICAL after 3 rounds as before, when the named node's view gives the slots to another owner, when a node that knows the owner names none either, or when the named node owns slots itself. The rounds in which a disagreement is held are not counted. Right after the repair a node knows the owner before it has learned the owner's slots, so its view can name no owner for a few more seconds: the finding no longer covers the disagreement then, and it is counted from that round like a new one. The CRITICAL event is raised when it is still there after 3 rounds, and nothing is raised when the node shows the owner before that. An open `topology_divergence` event is never handed over to a finding. When a finding takes over all its disagreements, the event closes after the usual 3 rounds and the WARNING here is raised once the finding has lasted its 90 seconds. That also holds for an open CRITICAL slot owner event: when the node lacks the owner again, the disagreement is held back from that round, the CRITICAL closes after 3 rounds, and the WARNING replaces it 90 seconds after the link broke. In between no event is open, and the report lists the disagreements under the finding as being counted. Everything else is left as it is.

**What it cannot see.**

- Nodes that were not sampled. Both lists name sampled peers only, and a node all sampled views agree on is not reported. No round asks more than 12 nodes.
- A cluster watched only through agent connections, which is not sampled (see [`topology_divergence`](#topology_divergence)).
- Why the join is stuck. The event shows which pairs do not know each other, not whether a firewall, a wrong address or a missed `MEET` caused it.

## Configuration

### Environment Variables

Set these before starting BetterDB:

```bash
# Enable/disable anomaly detection (default: true)
ANOMALY_DETECTION_ENABLED=true

# Polling interval in milliseconds (default: 1000)
ANOMALY_POLL_INTERVAL_MS=1000

# Cache TTL for in-memory anomaly data (default: 3600000 = 1 hour)
ANOMALY_CACHE_TTL_MS=3600000

# Prometheus metrics update interval (default: 30000 = 30 seconds)
ANOMALY_PROMETHEUS_INTERVAL_MS=30000

# Cluster view divergence (topology_divergence, partial_membership), gossip clusters only
# Compare the cluster views of several nodes (default: true)
ANOMALY_TOPOLOGY_DIVERGENCE_ENABLED=true
# Nodes asked per availability zone (default: 1)
ANOMALY_TOPOLOGY_DIVERGENCE_NODES_PER_ZONE=1
# Nodes asked among those without a zone, and the smallest sample (default: 3)
ANOMALY_TOPOLOGY_DIVERGENCE_RANDOM_NODES=3
# Rounds in a row a disagreement must hold before it is raised, and
# rounds of agreement before it is closed (default: 3)
ANOMALY_TOPOLOGY_DIVERGENCE_MIN_POLLS=3
# Time between rounds in milliseconds, never shorter than the poll interval (default: 5000)
ANOMALY_TOPOLOGY_DIVERGENCE_INTERVAL_MS=5000

# Persistence-child stall detection thresholds (seconds)
# Frozen key progress for this long fires CRITICAL (default: 60)
MONITOR_PERSISTENCE_STALL_SEC=60
# Elapsed time before a long-running child fires WARNING (default: 120)
MONITOR_PERSISTENCE_WARN_SEC=120
# Elapsed time ceiling before a child fires CRITICAL (default: 600)
MONITOR_PERSISTENCE_CRIT_SEC=600

# Primary without replicas thresholds (milliseconds); 0 turns a level off
# No synced replica for this long fires WARNING (default: 5000)
ANOMALY_PRIMARY_NO_REPLICA_WARN_MS=5000
# No synced replica for this long fires CRITICAL (default: 30000)
ANOMALY_PRIMARY_NO_REPLICA_CRIT_MS=30000
# How long a replica count stays expected after it was last seen (default: 86400000 = 24 hours)
ANOMALY_PRIMARY_REPLICAS_EXPECTATION_TTL_MS=86400000
```

### Runtime Settings

You can adjust these settings without restarting via the `/settings` API:

> **Note**: API calls need a signed-in session when user control is enabled — see [Authenticating API Requests](configuration.md#authenticating-api-requests).

```bash
curl -b cookies.txt -c cookies.txt -X PUT http://localhost:3001/api/settings \
  -H "Content-Type: application/json" \
  -d '{
    "anomalyPollIntervalMs": 500,
    "anomalyCacheTtlMs": 7200000,
    "anomalyPrometheusIntervalMs": 15000
  }'
```

**Note**: Changing `anomalyPollIntervalMs` affects detection sensitivity. Faster polling = quicker detection but higher overhead.

### Per-metric detector thresholds

#### From the UI

**Settings → Anomaly Detection → Detector thresholds** lists every metric with its effective values. A filled dot marks a metric with a stored override, and customized values are shown in bold. Expand a metric to edit it: each field shows the built-in default as a placeholder, and an empty field means "use the default". Use the switch next to an absolute threshold to turn it on or off. **Save** sends only the fields you changed. **Reset to defaults** on a metric clears its override, and **Reset all to defaults** clears every override. These thresholds save on their own, separately from the page's **Save Changes** button. The panel applies the same validation as the API (ranges, warning below critical) and shows server errors inline. Anomaly events link to the matching metric's panel. Requires a license with anomaly detection.

#### From the API

Tune Z-score, absolute, consecutive-sample, and cooldown thresholds per metric at runtime (no restart). Partial PATCH bodies only override the fields you send.

```bash
# View defaults, stored overrides, and fully resolved config
curl -b cookies.txt -c cookies.txt http://localhost:3001/api/settings/anomaly/detectors

# Partial update — only changes warningZScore and consecutiveRequired for connections
curl -b cookies.txt -c cookies.txt -X PATCH http://localhost:3001/api/settings/anomaly/detectors \
  -H "Content-Type: application/json" \
  -d '{"connections": {"warningZScore": 2.5, "consecutiveRequired": 5}}'
```

In `overrides`, a disabled absolute threshold is shown as `0` (the same value PATCH accepts to disable it). In `defaults` and `resolved`, a threshold that is not configured is omitted. Responses never contain `null`.

**Configurable fields** (all optional per metric):

| Field | Description |
|-------|-------------|
| `warningZScore` | Z-score threshold for WARNING (0.5–10) |
| `criticalZScore` | Z-score threshold for CRITICAL (1–15, must be > warning when both set) |
| `warningAbsolute` | Absolute value threshold for WARNING, must be > 0. `0` is reserved: it disables the check. |
| `criticalAbsolute` | Absolute value threshold for CRITICAL, must be > 0. `0` is reserved: it disables the check. |
| `consecutiveRequired` | Consecutive samples above threshold before alerting (1–20) |
| `cooldownMs` | Minimum ms between alerts for the same metric (1000–3600000) |

To disable an absolute threshold, send `0`. `null` is rejected with 400 for every field; omit a field to leave it unchanged.

**Metrics**: `connections`, `ops_per_sec`, `memory_used`, `input_kbps`, `output_kbps`, `slowlog_last_id`, `acl_denied`, `evicted_keys`, `blocked_clients`, `keyspace_misses`, `fragmentation_ratio`.

`replication_role` is detected via state-diff (not z-score) and is not tunable through this API.

Clear the override for one metric (others are kept). An unknown metric returns 400:

```bash
curl -b cookies.txt -c cookies.txt -X DELETE http://localhost:3001/api/settings/anomaly/detectors/connections
```

Reset all overrides:

```bash
curl -b cookies.txt -c cookies.txt -X POST http://localhost:3001/api/settings/anomaly/detectors/reset
```

Detector thresholds can only be changed through these endpoints; `PUT /api/settings` rejects `anomalyDetectorConfig` with a 400. Resetting general settings (`POST /api/settings/reset`) keeps detector overrides.

These endpoints require a license that includes anomaly detection. Without it they return the license guard's error.

Changes apply to the running anomaly detectors immediately (no restart). In a multi-replica deployment the replica that served the request applies the change immediately; other replicas apply it to their running detectors on their next settings refresh (every 30 s), with no restart.

Overrides persist in postgres/sqlite settings storage and survive restarts. The memory storage backend resets overrides on restart (same as other settings).

### Disabling Detection

To completely disable anomaly detection:

```bash
# In .env or environment
ANOMALY_DETECTION_ENABLED=false
```

Or set at container runtime:

```bash
docker run -e ANOMALY_DETECTION_ENABLED=false betterdb/monitor
```

## API Endpoints

### Get / update detector thresholds

```http
GET /api/settings/anomaly/detectors
PATCH /api/settings/anomaly/detectors
DELETE /api/settings/anomaly/detectors/:metric
POST /api/settings/anomaly/detectors/reset
```

See [Per-metric detector thresholds](#per-metric-detector-thresholds) above for request examples and field reference.

### Get Recent Anomaly Events

```http
GET /api/anomaly/events?limit=100&severity=critical&metricType=connections
```

**Query Parameters**:
- `startTime` (optional): Unix timestamp in milliseconds
- `endTime` (optional): Unix timestamp in milliseconds
- `severity` (optional): `info`, `warning`, or `critical`
- `metricType` (optional): Filter by specific metric
- `limit` (optional): Max events to return (default: 100)

**Response**:
```json
{
  "events": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "timestamp": 1704067200000,
      "metricType": "connections",
      "anomalyType": "spike",
      "severity": "warning",
      "value": 450,
      "baseline": 250,
      "stdDev": 25,
      "zScore": 8.0,
      "threshold": 2.0,
      "message": "WARNING: connections spike detected. Value: 450, Baseline: 250 (80.0% above normal, Z-score: 8.00)",
      "correlationId": "760e9500-f30c-52e5-b827-557766551111",
      "relatedMetrics": ["ops_per_sec"],
      "resolved": false,
      "node": {
        "nodeId": "e7d1eecce10fd6bb5eb35b9f99a514335d9ba9ca",
        "address": "10.0.1.12:6379",
        "role": "primary",
        "shardId": "8f3c1d5e0a9b4c7d2e6f1a0b3c4d5e6f7a8b9c0d",
        "availabilityZone": "eu-west-1a",
        "collected": true,
        "connectionId": "conn-7"
      }
    }
  ]
}
```

`node` is present on events of a cluster connection that are about one node. It can be absent, for example on an event stored before this field existed, so read it as optional. See [Failing node on cluster events](#failing-node-on-cluster-events).

### Get Correlated Anomaly Groups

```http
GET /api/anomaly/groups?limit=50&pattern=memory_pressure
```

**Query Parameters**:
- `startTime` (optional): Unix timestamp in milliseconds
- `endTime` (optional): Unix timestamp in milliseconds
- `pattern` (optional): Filter by pattern name
- `limit` (optional): Max groups to return (default: 50)

**Response**:
```json
{
  "groups": [
    {
      "correlationId": "760e9500-f30c-52e5-b827-557766551111",
      "timestamp": 1704067200000,
      "pattern": "memory_pressure",
      "severity": "critical",
      "diagnosis": "Memory pressure detected with potential evictions",
      "recommendations": [
        "Check memory usage trends and plan for scaling",
        "Review eviction policy settings",
        "Identify large keys or data structures",
        "Consider increasing maxmemory or adding shards"
      ],
      "anomalies": [
        { "metricType": "memory_used", "severity": "critical", "zScore": 3.2 },
        { "metricType": "evicted_keys", "severity": "warning", "zScore": 2.5 }
      ]
    }
  ]
}
```

### Computed values

Three detectors work out a target for the setting their recommendation names. The correlated group and the incident sequence match that hold the event carry it as `values`, next to the recommendation text, and so does the event's entry in the incident timeline:

```json
"values": [{ "setting": "repl-backlog-size", "current": 1, "target": 3, "unit": "MB" }]
```

| Event | Setting | Target |
| --- | --- | --- |
| `backlog_coverage_risk` | `repl-backlog-size` | The size that covers 75s of writes (the 60s warning plus 25%) at the write rate the coverage was measured with |
| `repl_buffer_pressure` | `client-output-buffer-limit replica hard`, and `soft` when the soft limit is enabled and this buffer is already past 60% of it (a sustained soft-limit breach carries `soft` only) | Twice the replica's observed output buffer, so the same burst sits at 50% of each of those limits |
| `fork_memory_risk` | `total_system_memory` | The RAM at which the projected fork peak sits at 70%, ten points under the 80% warning |

At 10 MB and above, the target is rounded up to a whole MB and the current value to the nearest MB. Below 10 MB both are shown to one decimal, so a fraction of a megabyte does not display as the same whole number as its target. When an input is unknown (no backlog size, or no per-replica buffer because `CLIENT LIST` was denied or the finding is a resync loop), `values` is left out and the text stays as it is. A group keeps the larger target for each setting on each node, and sets `nodeAddr` when the event names one, so a later smaller replica does not replace a larger one and two nodes do not share a single target. A sequence match keeps only the values whose setting its own recommendations name. The timeline entry still shows the event's own values, including a fork RAM target whose setting the match text does not name.

Values are kept in memory only. A group read back from storage still includes them while that group is in memory, and an incident rebuilt from storage keeps them while the event is still in the live incident buffer, including after it has left the 1,000-event recent list. Once those copies age out, the text remains and `values` is absent. The events endpoint returns the stored copy of a saved event, so it does not include them, and neither do webhook payloads.

For retry amplification, the group's "Throttle or inspect the clients whose command rate grew the most" recommendation names the top clients and their growth (`Top clients: name checkout (cmds 4.2×, 12 reconnects)`), and keeps the fixed text when attribution is unavailable or no client stood out.

### Get Anomaly Summary

```http
GET /api/anomaly/summary?startTime=1704067200000
```

**Response**:
```json
{
  "totalEvents": 42,
  "totalGroups": 8,
  "activeEvents": 3,
  "resolvedEvents": 39,
  "bySeverity": {
    "info": 0,
    "warning": 35,
    "critical": 7
  },
  "byMetric": {
    "connections": 12,
    "memory_used": 8,
    "ops_per_sec": 15,
    "acl_denied": 7
  },
  "byPattern": {
    "traffic_burst": 3,
    "memory_pressure": 2,
    "auth_attack": 1,
    "unknown": 2
  }
}
```

### Get Buffer Statistics

```http
GET /api/anomaly/buffers
```

**Response**:
```json
{
  "buffers": [
    {
      "metricType": "connections",
      "sampleCount": 300,
      "mean": 250.5,
      "stdDev": 25.3,
      "min": 180,
      "max": 320,
      "latest": 255,
      "isReady": true
    }
  ]
}
```

### Get Fan-out Coverage

```http
GET /api/anomaly/coverage
X-Connection-ID: <connection-id>
```

One entry per polled connection (all connections without the header), with the outcome of its latest per-node fan-out. `reason` is set when the fan-out dials nothing; the values are listed under [REPLICATION_DIVERGENCE](#replication_divergence). `topology` is `cluster`, `sentinel`, or `null` before the mode is known. `tunnelled` is true for a connection behind an SSH tunnel. `targetLimit` is the most primaries one connection reads per poll, `sweepMs` how long the read schedule takes to go through every readable primary once (worked out, not measured; one poll while none can be read), `sweepPolls` how many polls that is (above 1 while the primaries are read in rotation), and `timeoutMs` the per-primary connect and `INFO` timeout. `ageMs` is the age of the entry by the server clock. Entries no poll has refreshed for 3 poll intervals (at least 30 seconds) are kept with `stale: true`, so a stopped fan-out does not read as covered.

**Response**:
```json
[
  {
    "connectionId": "550e8400-e29b-41d4-a716-446655440000",
    "topology": "cluster",
    "checked": 3,
    "unreachable": 2,
    "authFailed": 1,
    "skipped": 0,
    "notDialed": 0,
    "reason": null,
    "tunnelled": false,
    "targetLimit": 64,
    "sweepMs": 10000,
    "sweepPolls": 1,
    "timeoutMs": 2000,
    "timestamp": 1704067200000,
    "ageMs": 4200,
    "stale": false
  }
]
```

### Get Hot Shards

```http
GET /api/anomaly/hot-shards
X-Connection-ID: <connection-id>
```

The open [`hot_shard`](#hot_shard) events of one cluster connection, with the numbers behind them. The connection header is required. The list is empty when no shard is hot. It is kept in memory and rebuilt from the next shard load sample after a restart.

`cpu` gives the shard's CPU rate per second, its share of the cluster, the cluster median and the ratio the rule used. `network` gives the same for bytes in plus bytes out, without a ratio: it is detail only, and it includes replication, counted once per replica. `topSlots` (up to 5) are ranked by CPU. `topKeys` (up to 10, full names) are ranked by `freq`, the LFU counter of the key (0 to 255). `keySource` is `lfu` when the keys were read and `unavailable` when they were not, with the reason in `keyNote`. `keysSampledAt` is the time of the read the names come from and `keysSampled` the number of keys whose frequency it got. When a later read gave no names, the names of the earlier read stay and `keyNote` says so. `eventId` is the id of the open event. `captureAvailable` is `true` when the key names are missing and a [capture on the hot primary](#hot_shard) can show them. `node` names the hot primary, with whether it is collected (see [Failing node on cluster events](#failing-node-on-cluster-events)); it is left out when the primary is not in the cluster view.

`advice.hashTags` is the [hash tag advice](#hot_shard): `tags` (each with `slot`, `tag`, `share`, `keysSampled` and `keysWithTag`), `slotsSampled`, `keyCountOutliers` (each with `slot`, `keyCount` and its `ratio` to `medianKeyCount`, null when the median slot holds no keys), `keyCountOutlierFactor` (the factor over the median a crowded slot must reach), `medianKeyCount` (null until the key counts are measured), `sampledAt` (the time of the read the tags come from) and `note` when the names could not be read.

`rebalance` is the [rebalance suggestion](#hot_shard): `kind` is `plan` or `no_plan`. A plan has `moves` (each with `targetShardId`, `targetAddr`, inclusive slot `ranges`, and the slots, keys and CPU it moves), `projection` (every shard's CPU, share and ratio to the median `before` and `after`, with its `role`), `medianBefore`, `medianAfter`, `pinnedSlots`, `warnings`, `plannedAfter` (the IDs of the hot shards whose plans its numbers count as applied; empty when it starts from the measured loads), `support` and `commands` (each with the `nodeAddr` to run it on and the command `text`). A `no_plan` has a `reason` and `pinnedSlots`, and `coveredBy` when the reason is `covered_by_other_plan` and `conflictsWith` when it is `conflicts_with_other_plan`. The field is missing for a moment after a restart, until the suggestion is computed again.

**Response**:
```json
[
  {
    "eventId": "0b9d2c1e-6f3a-4c57-9a41-2d8e7b5f1c30",
    "captureAvailable": false,
    "shardId": "3f2a9c1e77aa5d0c9b1e4f6a8c2d0e1f3a5b7c9d",
    "nodeAddr": "10.0.0.1:6379",
    "node": {
      "nodeId": "3f2a9c1e77aa5d0c9b1e4f6a8c2d0e1f3a5b7c9d",
      "address": "10.0.0.1:6379",
      "role": "primary",
      "collected": false
    },
    "slotCount": 5461,
    "since": 1704067140000,
    "sampledAt": 1704067200000,
    "cpu": { "perSecond": 930000, "share": 0.61, "median": 300000, "ratio": 3.1 },
    "network": { "perSecond": 2097152, "share": 0.35, "median": 1887436 },
    "topSlots": [
      {
        "slot": 1234,
        "cpuUsecPerSecond": 576600,
        "networkBytesPerSecond": 912000,
        "keyCount": 1820,
        "shareOfShard": 0.62
      }
    ],
    "topKeys": [
      { "key": "user:42", "slot": 1234, "freq": 255 },
      { "key": "cart:{9}", "slot": 88, "freq": 201 }
    ],
    "keySource": "lfu",
    "keysSampled": 1012,
    "keysSampledAt": 1704067200000,
    "advice": {
      "hashTags": {
        "tags": [{ "slot": 1234, "tag": "cart", "share": 0.92, "keysSampled": 500, "keysWithTag": 460 }],
        "slotsSampled": 3,
        "keyCountOutliers": [],
        "keyCountOutlierFactor": 20,
        "medianKeyCount": 120,
        "sampledAt": 1704067200000
      }
    },
    "rebalance": {
      "kind": "plan",
      "action": "spread",
      "effect": "resolves",
      "sourceShardId": "3f2a9c1e77aa5d0c9b1e4f6a8c2d0e1f3a5b7c9d",
      "moves": [
        {
          "targetShardId": "9c4e1b7a2d5f8036a1c3e5f7092b4d6f8a0c2e4b",
          "targetAddr": "10.0.0.3:6379",
          "ranges": [[2000, 2410]],
          "slotCount": 411,
          "keyCount": 48210,
          "cpuUsecPerSecond": 262000,
          "shareOfShard": 0.28
        }
      ],
      "pinnedSlots": [{ "slot": 1234, "shareOfShard": 0.62 }],
      "projection": [
        {
          "shardId": "3f2a9c1e77aa5d0c9b1e4f6a8c2d0e1f3a5b7c9d",
          "nodeAddr": "10.0.0.1:6379",
          "role": "source",
          "before": { "cpuUsecPerSecond": 930000, "share": 0.61, "ratio": 3.1 },
          "after": { "cpuUsecPerSecond": 668000, "share": 0.44, "ratio": 1.19 }
        }
      ],
      "medianBefore": 300000,
      "medianAfter": 562000,
      "warnings": [
        { "code": "source_fork", "shardId": "3f2a9c1e77aa5d0c9b1e4f6a8c2d0e1f3a5b7c9d" }
      ],
      "plannedAfter": [],
      "support": "valkey_atomic",
      "commands": [
        {
          "nodeAddr": "10.0.0.1:6379",
          "text": "CLUSTER MIGRATESLOTS SLOTSRANGE 2000 2410 NODE 9c4e1b7a2d5f8036a1c3e5f7092b4d6f8a0c2e4b"
        }
      ]
    }
  }
]
```

### Get Topology Divergence

```http
GET /api/anomaly/topology-divergence
X-Connection-ID: <connection-id>
```

What the last [`topology_divergence`](#topology_divergence) round of the connection's cluster saw, with the [`partial_membership`](#partial_membership) findings of the same round. The connection header is required. Any connection that watches the cluster returns the same report. It is kept in memory and rebuilt by the first round after a restart.

`status` is `ok` when at least two views were compared. It means the views that answered were compared, not that the whole cluster agrees: a node listed in `unanswered` gave no view, and a node that was not asked is not in the report at all. `status` is `insufficient_views` when only the connection's own view could be read, and `not_sampled` when no round has run: the connection is not a gossip cluster, the check is off, or the first round is still to come. `observers` are the nodes asked in the round and `unanswered` those that gave no view. Each entry of `divergences` is one group of nodes against the rest: `sides[0]` is the smaller side. `confirmed` is `false` while the disagreement is still being counted and no event is open; `eventId` is then `null`. A group with an open event is listed with the disagreements of the latest round, also those that joined it later and are still being counted, so the event keeps its `eventId` and `confirmed` `true` while it is open. That also holds once a [`partial_membership`](#partial_membership) finding has taken over disagreements of the group: those are listed under the finding only, so the group is listed with the disagreements that are left, or with none, until the event closes. Slots that have joined a confirmed slot owner disagreement are listed once they are confirmed themselves. When none of the slots the event was confirmed with are disputed any more and the same owners dispute other slots, those slots are listed under the open event from the first round, before they are confirmed, so the event is not listed without the dispute it stands for; after 3 rounds they are the confirmed slots of the event. A group whose event was resolved by hand is listed as still being counted, with `eventId` `null`, until the event is raised again, also after the resolved event has been cleared with `DELETE /api/anomaly/resolved`. When the latest round no longer shows the group, it is listed as it was last confirmed until the event closes. A membership disagreement whose only lacking node gave no view is listed too while its count is kept, with `eventId` `null`, `confirmed` `false` and that node on the `missing` side. This is how the last gap of a dead peer is shown once [`partial_membership`](#partial_membership) has let go of it. An open event that was picked up after a restart is listed with its `eventId` and `confirmed` `true` from the first round that shows its disagreement, before the count has reached 3 rounds again. When a later round no longer shows the group, or a finding has taken over its disagreements, it is listed as it was last seen until the event closes. `positions` lists, for each disagreement, what was claimed and which nodes claimed it. For `failure_flags` the value is `ok` or `failing` (the view flags the node `fail?` or `fail`), for `config_epoch` the epoch, for `slot_owner` the node id of the owner or `unassigned`, and for `membership` one of `known`, `handshake`, `noaddr` or `missing`. `rounds` is the number of rounds in a row the disagreement was seen and `since` when it was first seen. Each disagreement also carries the `eventId` and `eventType` (`topology_divergence` or `partial_membership`) of the open event that holds it; both are `null` while it is still being counted.

Each entry of `partialMembership` is one node only part of the cluster knows: `node`, the peers that list it (`knownBy`), the peers that do not (`notKnownBy`, each with `status` `missing`, `handshake` or `noaddr`), the peers its own view lacks (`ownViewMissing`, same `status`), the `command` to run and the peers to run it on (`runOn`). `command` is `null` when no view has an address for the node, when the address is a host name, since `CLUSTER MEET` needs an IP address (`node.address` is still set then), and when none of the peers that showed the gap gave a view in that round. `eventId`, `confirmed` and `since` read as in `divergences`. `seen` is `true` when the round still holds the finding. Its `disagreements` are the membership disagreements behind it and the slot owner disagreements it holds back; a disagreement listed here is not repeated under `divergences`. A disagreement that two findings hold, as when two half-joined nodes lack each other or the same slot owner, is listed under one of them only, with the `eventId` of that finding: first the finding that has an open event, then, when neither or both have one, the finding of the node the disagreement is about, then the finding with the smaller node id. The other finding is listed without it; its other fields are not changed by that. The entries are the findings of the round as the events were judged; a round with `insufficient_views` keeps those of the last compared round. An open event whose node has no finding in the round any more, for example because it has joined, stays open for the closing rounds (3 by default). Until then it is listed with `seen` `false`: `knownBy`, `notKnownBy`, `ownViewMissing`, `runOn` and `disagreements` are empty and `command` is `null`, so the report no longer asks for a `CLUSTER MEET`. An event that was picked up after a restart is listed in the same way when its node joins before the finding was confirmed again. An open `topology_divergence` event stays in `divergences` until it closes, also once a finding holds all its disagreements: it is then listed with its `eventId`, `confirmed` `true` and no `disagreements`, and the disagreements are listed under the finding, counted afresh and with `eventId` `null` until the finding has an event of its own. A finding whose event was resolved by hand is listed as still counted, with `eventId` `null`, until the event is raised again, also after the resolved event has been cleared with `DELETE /api/anomaly/resolved`. A slot owner disagreement that is held back is counted afresh in every round: its `rounds` is 1 and its `since` the time of that round, and it is listed only in a round in which the node's view was read.

**Response**:
```json
{
  "status": "ok",
  "sampledAt": 1704067200000,
  "observers": [
    { "nodeId": "3f2a9c1e77aa5d0c9b1e4f6a8c2d0e1f3a5b7c9d", "address": "10.0.1.5:6379", "role": "primary", "availabilityZone": "eu-west-1a" },
    { "nodeId": "7c1d0e2f55bb6a1d8c2f5a7b9d3e1f2a4b6c8d0e", "address": "10.0.2.7:6379", "role": "primary", "availabilityZone": "eu-west-1b" },
    { "nodeId": "9e3f1a2b44cc7b2e9d3a6b8c0e4f2a3b5c7d9e1f", "address": "10.0.3.2:6379", "role": "primary", "availabilityZone": "eu-west-1c" }
  ],
  "unanswered": [],
  "divergences": [
    {
      "eventId": "0b9d2c1e-6f3a-4c57-9a41-2d8e7b5f1c30",
      "confirmed": true,
      "since": 1704067185000,
      "sides": [
        { "nodes": [{ "nodeId": "3f2a9c1e77aa5d0c9b1e4f6a8c2d0e1f3a5b7c9d", "address": "10.0.1.5:6379", "role": "primary", "availabilityZone": "eu-west-1a" }] },
        { "nodes": [
          { "nodeId": "7c1d0e2f55bb6a1d8c2f5a7b9d3e1f2a4b6c8d0e", "address": "10.0.2.7:6379", "role": "primary", "availabilityZone": "eu-west-1b" },
          { "nodeId": "9e3f1a2b44cc7b2e9d3a6b8c0e4f2a3b5c7d9e1f", "address": "10.0.3.2:6379", "role": "primary", "availabilityZone": "eu-west-1c" }
        ] }
      ],
      "disagreements": [
        {
          "kind": "failure_flags",
          "subject": [{ "nodeId": "7c1d0e2f55bb6a1d8c2f5a7b9d3e1f2a4b6c8d0e", "address": "10.0.2.7:6379", "role": "primary", "availabilityZone": "eu-west-1b" }],
          "positions": [
            { "value": "failing", "observers": [{ "nodeId": "3f2a9c1e77aa5d0c9b1e4f6a8c2d0e1f3a5b7c9d", "address": "10.0.1.5:6379", "role": "primary", "availabilityZone": "eu-west-1a" }] },
            { "value": "ok", "observers": [{ "nodeId": "9e3f1a2b44cc7b2e9d3a6b8c0e4f2a3b5c7d9e1f", "address": "10.0.3.2:6379", "role": "primary", "availabilityZone": "eu-west-1c" }] }
          ],
          "rounds": 4,
          "since": 1704067185000,
          "eventId": "0b9d2c1e-6f3a-4c57-9a41-2d8e7b5f1c30",
          "eventType": "topology_divergence"
        }
      ]
    }
  ],
  "partialMembership": [
    {
      "eventId": "5a7c1f0e-2b6d-4e8a-b3c9-7d1e4f6a8b20",
      "confirmed": true,
      "seen": true,
      "since": 1704067095000,
      "node": { "nodeId": "b1e4f6a8c2d0e1f3a5b7c9d3f2a9c1e77aa5d0c9", "address": "10.0.4.9:6379", "role": "primary" },
      "knownBy": [{ "nodeId": "3f2a9c1e77aa5d0c9b1e4f6a8c2d0e1f3a5b7c9d", "address": "10.0.1.5:6379", "role": "primary", "availabilityZone": "eu-west-1a" }],
      "notKnownBy": [{ "nodeId": "7c1d0e2f55bb6a1d8c2f5a7b9d3e1f2a4b6c8d0e", "address": "10.0.2.7:6379", "role": "primary", "availabilityZone": "eu-west-1b", "status": "handshake" }],
      "ownViewMissing": [],
      "command": "CLUSTER MEET 10.0.4.9 6379",
      "runOn": [{ "nodeId": "7c1d0e2f55bb6a1d8c2f5a7b9d3e1f2a4b6c8d0e", "address": "10.0.2.7:6379", "role": "primary", "availabilityZone": "eu-west-1b" }],
      "disagreements": [
        {
          "kind": "membership",
          "subject": [{ "nodeId": "b1e4f6a8c2d0e1f3a5b7c9d3f2a9c1e77aa5d0c9", "address": "10.0.4.9:6379", "role": "primary" }],
          "positions": [
            { "value": "handshake", "observers": [{ "nodeId": "7c1d0e2f55bb6a1d8c2f5a7b9d3e1f2a4b6c8d0e", "address": "10.0.2.7:6379", "role": "primary", "availabilityZone": "eu-west-1b" }] },
            { "value": "known", "observers": [{ "nodeId": "3f2a9c1e77aa5d0c9b1e4f6a8c2d0e1f3a5b7c9d", "address": "10.0.1.5:6379", "role": "primary", "availabilityZone": "eu-west-1a" }] }
          ],
          "rounds": 22,
          "since": 1704067095000,
          "eventId": "5a7c1f0e-2b6d-4e8a-b3c9-7d1e4f6a8b20",
          "eventType": "partial_membership"
        }
      ]
    }
  ]
}
```

### Get Topology Disagreements

```http
GET /api/anomaly/topology-disagreements
X-Connection-ID: <connection-id>
```

The state of the last [`topology_divergence`](#topology_divergence) round, summarised for large clusters: one line per disagreement with the number of views on each side, and one line per shard. The connection header is required. Any connection that watches the cluster returns the same summary. It is built from the round kept in memory, so it is empty until the first round after a restart. `fullCheck` carries the last [full check](#start-a-full-topology-check) of the cluster next to it. The MCP tool `get_topology_disagreements` returns the same data.

**The counts are over the views that answered, not over every node.** A round asks at most 12 nodes by default, so on a 500-node cluster a line reads "9 views against 3", not "497 against 3". `coverage` says how far the round reached: `nodes` is the number of members of the cluster, `asked` the nodes asked in the round, `answered` those that gave a view, and `complete` is `true` only when every member gave one. `unanswered` lists the nodes that were asked and gave no view, and the nodes a line is waiting for that gave none in this round. The second kind is not counted in `asked`, so `unansweredCount` can be above `asked` minus `answered`. A node that one view lists without an address counts as a member when another view lists it as one, so `complete` is not `true` until it has given a view too. An empty `disagreements` list means only that the views that answered agree with each other. A node that was asked and did not answer gave no view, so it is not known to agree, and with `status: insufficient_views` fewer than two views answered and nothing was compared at all. Read `status` and `coverage` before taking an empty list as agreement; it covers the whole cluster only when `complete` is `true`. `status` has the same meaning as in [Get Topology Divergence](#get-topology-divergence).

Each entry of `disagreements` is one thing the views disagree about:

| Field | Meaning |
|-------|---------|
| `kind` | `slot_owner`, `config_epoch`, `failure_flags` or `membership` |
| `severity` | `critical` for `slot_owner`, `warning` for the others |
| `open` | `true` for a line of the last round, and for a stale line whose event is still open. The lines that are not open are the stale ones without an open event. A shard is `disputed` only through open lines |
| `confirmed`, `eventId`, `eventType`, `eventAt`, `eventConnectionId` | `confirmed` is `true` when an open event covers the line; `eventId` and `eventType` then point at that event, `eventAt` is the time it was raised, and `eventConnectionId` is the connection to open it under: the one that asked when it can open the event, otherwise the one that holds it. All four are `null` while the disagreement is still being counted, and after the event was resolved by hand. An event covers a line only while the line still shows what the event was raised for: the same node and kind (for `slot_owner` the same owners and at least one slot in common), with the nodes the event names as disagreeing still apart from the others. A new dispute between the same owners on other slots does not take the event of an ended one. When more than one event covers a line, an open one comes before one that was resolved by hand, then the one that shares the most slots, then the one whose disagreement was confirmed last. A line that a [`partial_membership`](#partial_membership) finding holds takes the event of that finding and no other, chosen as in the divergence report: a finding with an open event first, then the finding of the node the line is about. Such a line has no event while the finding is still being counted, also when a `topology_divergence` event is open for the same nodes |
| `resolvedByHand` | `true` when the event of the line was resolved by hand and the disagreement has not been raised again. The line then has no `eventId` and `confirmed` is `false`, although it was confirmed before. A disagreement that is still confirmed is raised again in the next round, so this is mostly seen for one round, or on a stale line |
| `since`, `rounds` | When it was first seen, and for how many rounds in a row |
| `stale`, `lastSeenAt` | `stale` is `true` when the line was not seen in the last round; `lastSeenAt` is the round it was last seen in. See below |
| `subjects`, `subjectCount` | The nodes the line is about. For `slot_owner` these are the nodes claimed as owner |
| `slots`, `slotCount` | The disputed slot ranges, for `slot_owner` only |
| `shardIds` | The shards the line touches: those of the subjects, and for `slot_owner` those that own the disputed slots |
| `positions` | One entry per side, largest first: `value`, `count` (the number of views on that side), `observers` (the nodes that hold it) and `observerCount` (how many nodes hold it, which is the same as `count` unless the line is merged). For `slot_owner` the value is the node id of the owner, repeated as `owner` with its address, or `unassigned`. Empty on a stale line |
| `epochs` | On a merged `config_epoch` line only: the epoch each side has for each node, in the order of `positions`. The `value` of the positions is then `null` |
| `text` | The line in words |

For `failure_flags` the value is `ok`, `fail?` (the view suspects the node) or `fail` (the view has it as failed), so a node that part of the cluster only suspects is told apart from one that part of it has failed. What a node says of itself is not counted, so the views on such a line can add up to one less than `answered`. For `membership` the value is `known`, `handshake`, `noaddr` or `missing`.

Lines of the same kind that have the same nodes on the same sides, with the same counts, and differ only in the node they are about are merged into one: `4 nodes: ok in 9 views, fail? in 3 views.` `subjectCount` is then above 1 and the `id` ends in `+N`. The `id` of a merged line changes when the set of merged lines changes, so it is stable only within one response: do not keep it across polls. Slot owner lines are never merged. On a merged line `count` is the number of views on that side for each node of the line, `observers` lists every node that holds the side for at least one node of the line, and `observerCount` is how many those are. When a zone is cut off, each of its nodes is vouched for by the others, so a side reads `ok in 3 views` with 4 observers. A line is not merged into another when a node would then stand on both sides of the merged line. When two halves of a cluster each flag the other as failing, there is one line for each half, so the sides still say who flags whom. Open lines come first, with the lines of the last round before the stale ones; within those the order is critical first, then confirmed before counting, then oldest first.

**A line that could not be checked again is kept, without counts.** When the nodes that hold one side of a disagreement do not answer, or the round could not compare views at all, the disagreement could not be checked in that round. It is kept for up to 5 minutes with `stale: true`: `positions` is empty, `text` says what the views differed on without numbers (`Slots 0-99: views differed on the owner (10.0.0.1:6379, 10.0.0.3:6379).`), and `lastSeenAt` says when it was last seen. A stale line keeps its event. While that event is open the line has `confirmed: true`, the `eventId` and `open: true`, and its shards stay `disputed`: the event was raised and nothing has cleared it. A stale line without an open event has `open: false`: it was neither confirmed nor cleared, comes after the open lines and does not make a shard `disputed`. Stale lines are only merged with lines last seen in the same round.

Each entry of `shards` is one shard: its `primary`, the number of `replicas`, its `zones`, its `slots`, and `ownViews`, the number of its own nodes that gave a view. `state` is `disputed` when an open line touches the shard (the lines are in `disagreementIds`), also in a round that could not compare views; `undisputed` when no line does; and `not_compared` when the round could not compare views or only lines that are not open touch the shard. The lines that are not open and touch a shard are in `staleDisagreementIds`, whatever its state. Undisputed means no view that answered disagrees about the shard. Disputed shards come first, the rest follow in slot order. `shardTotals` counts the shards by state (`total`, `disputed`, `undisputed`, `notCompared`).

The MCP route and tool return only the disputed shards by default, with `shardsListed: "disputed"` and the same `shardTotals`; `shards=all` (tool argument `shards: "all"`) returns one line per shard.

Node lists (`subjects`, `observers`, `unanswered`, `epochs`) hold at most 25 entries; the counts next to them are exact. The number of lines is not capped: every distinct disagreement adds one. A summary of a 500-node cluster with a few disagreements is under 150 KB, and one with many distinct disagreements is larger.

**Response**:
```json
{
  "status": "ok",
  "sampledAt": 1704067200000,
  "coverage": {
    "nodes": 500,
    "asked": 12,
    "answered": 12,
    "complete": false,
    "unanswered": [],
    "unansweredCount": 0
  },
  "disagreements": [
    {
      "id": "slot_owner:3f2a9c1e|9c4e1b7a",
      "kind": "slot_owner",
      "severity": "critical",
      "open": true,
      "confirmed": true,
      "resolvedByHand": false,
      "eventId": "0c1f6f0e-6d0f-4d3e-9a55-0f2f8f3f6a11",
      "eventType": "topology_divergence",
      "eventAt": 1704067180000,
      "eventConnectionId": "5b0c7d2e-1f7a-4a53-8f0d-2f6f1c9e4b10",
      "since": 1704067170000,
      "rounds": 6,
      "stale": false,
      "lastSeenAt": 1704067200000,
      "subjects": [
        { "nodeId": "3f2a9c1e", "address": "10.0.0.1:6379", "role": "primary", "availabilityZone": "eu-west-1a" },
        { "nodeId": "9c4e1b7a", "address": "10.0.0.3:6379", "role": "primary", "availabilityZone": "eu-west-1b" }
      ],
      "subjectCount": 2,
      "slots": [[0, 5460]],
      "slotCount": 5461,
      "shardIds": ["3f2a9c1e", "9c4e1b7a"],
      "positions": [
        {
          "value": "3f2a9c1e",
          "owner": { "nodeId": "3f2a9c1e", "address": "10.0.0.1:6379", "role": "primary", "availabilityZone": "eu-west-1a" },
          "count": 9,
          "observerCount": 9,
          "observers": [{ "nodeId": "3f2a9c1e", "address": "10.0.0.1:6379", "role": "primary" }]
        },
        {
          "value": "9c4e1b7a",
          "owner": { "nodeId": "9c4e1b7a", "address": "10.0.0.3:6379", "role": "primary", "availabilityZone": "eu-west-1b" },
          "count": 3,
          "observerCount": 3,
          "observers": [{ "nodeId": "9c4e1b7a", "address": "10.0.0.3:6379", "role": "primary" }]
        }
      ],
      "text": "Slots 0-5460: owned by 10.0.0.1:6379 in 9 views, by 10.0.0.3:6379 in 3 views."
    }
  ],
  "shards": [
    {
      "shardId": "3f2a9c1e",
      "primary": { "nodeId": "3f2a9c1e", "address": "10.0.0.1:6379", "role": "primary", "availabilityZone": "eu-west-1a" },
      "replicas": 1,
      "zones": ["eu-west-1a", "eu-west-1b"],
      "slots": [[0, 5460]],
      "slotCount": 5461,
      "nodes": 2,
      "ownViews": 1,
      "state": "disputed",
      "disagreementIds": ["slot_owner:3f2a9c1e|9c4e1b7a"],
      "staleDisagreementIds": []
    }
  ],
  "shardTotals": { "total": 250, "disputed": 2, "undisputed": 248, "notCompared": 0 },
  "shardsListed": "all"
}
```

In the example only the first shard is shown, node ids are shortened and the `observers` lists are cut to one entry each. `fullCheck` is left out; it is described below.

### Start a Full Topology Check

```http
POST /api/anomaly/topology-disagreements/full-check
X-Connection-ID: <connection-id>
```

Asks every node of the cluster for its view once, so that the counts are over the whole cluster and not over the sample of a round: "497 views against 3" where the round says "9 against 3". The call reads the node list of the cluster, starts the check and returns `202` with the state of the check; it does not wait for the nodes to answer. Progress and the result are read from `fullCheck` of [`GET /api/anomaly/topology-disagreements`](#get-topology-disagreements). A request made while a check runs returns the running check and does not start a second one. It needs the anomaly detection licence. On a self-hosted install with user control on, only an admin can call it and a read-only member gets `403`: the check opens a connection to every node of the monitored cluster.

| Field of `fullCheck` | Meaning |
|-------|---------|
| `state` | `none` when no check is kept, `running`, or `done` |
| `unavailable` | `null`, or why a check cannot be run on this connection: `reason` and the same in words as `text` |
| `startedAt`, `finishedAt` | When the check started and finished |
| `asked`, `total` | How many nodes were asked so far, and how many there are. While the check runs, `total` is the number of members the node list had when the check started. When it is done, `total` also counts members that only the replies listed, and is the same as `summary.coverage.nodes` |
| `retryAt` | When the next check can be started: 30 seconds after the last one finished or broke. `null` when no check is kept |
| `now` | The clock of the server when it answered. `retryAt`, `finishedAt` and `lastFailure.at` are times of that clock: measure them against `now`, not against the clock of the reader, which may run ahead or behind |
| `lastFailure` | `null`, or `at` and `reason` of the last check when it broke before it finished. A result from the check before it is still in `summary`, with its own `finishedAt`. Cleared when the next check starts, and after 10 minutes |
| `summary` | On `done` only: the result, in the shape of the summary above. It is built once, when the check finishes. Only `eventConnectionId` is worked out for the connection that asks, as in the summary above, so a link opens the event under that connection whoever started the check |

In `summary` the counts are over every node that answered, and `coverage.complete` is `true` when all of them did. A node that gave no answer is in `unanswered` and is not counted as agreeing. The lines of a full check are not tracked: `tracked` is `false` and they have no `since` and no `rounds`, because the check is a single reading. They are never `stale`, and `lastSeenAt` is the time of the check. `confirmed`, `eventId` and `eventType` are set when an open event covered the same disagreement at the moment the check finished: the event is matched by what the line is about (the same owners and overlapping slots, or the same dissenting side, or the [`partial_membership`](#partial_membership) finding that holds the line), and the result does not change afterwards, also when the event is closed later. **A full check raises no event and closes none**, and what it found is not kept between rounds: a disagreement that only it sees becomes an event when the rounds see it too.

**What it costs.** One `CLUSTER NODES` to every node, 16 nodes at a time. Each node is read over a connection of its own that is opened for the read and closed after it, with 2 seconds to connect and 2 seconds to answer, so the check does not use the connections the monitor keeps to the nodes and never has more than 16 open. A connection is closed as soon as its read is given up, and whatever is still open when the 60 seconds are over is closed then. Nodes that are in `handshake` or have no address are not asked. The whole check stops after 60 seconds. A node it did not get to by then was not asked: `coverage.asked` is then lower than `coverage.nodes`, `coverage.complete` is `false`, and `unanswered` lists only the nodes that were asked and gave no answer. How long the reads take depends on the nodes: 500 nodes are 32 batches of 16, and a batch takes as long as its slowest node. Nodes that hold the same view are compared once, so comparing the views of 500 nodes took 0.1 seconds when they agreed and 0.4 seconds when every view was different, measured with the reads left out. The comparison works in slices of about 20 milliseconds and lets other requests run between them. A slice ends with the step that takes it past 20 milliseconds; one step took about 5 milliseconds at 500 nodes and about 23 at 1000 when every view was different, so on a cluster that large a slice runs longer.

**Limits.** One check runs per cluster at a time, and the next can be started 30 seconds after the last one finished or broke. The result is kept for 10 minutes, in the memory of the API process: it is gone after a restart, and with more than one API process each keeps its own. The MCP tool `get_topology_disagreements` returns `fullCheck` and cannot start a check; by default it lists only the disputed shards of `fullCheck.summary` too, with the totals in `shardTotals`.

A check cannot be run, and `unavailable` says so, when:

- `no_direct_access`: the monitor reaches the cluster through one node only (an agent connection), so it cannot dial the others
- `ssh_tunnel`: the connection goes through an SSH tunnel, and the addresses the nodes report are the ones inside the tunnel, which the monitor cannot dial
- `raft_cluster`: the nodes of a Raft cluster share one agreed view, so there is nothing to compare
- `no_cluster_view`: no cluster view has been read on the connection yet

**Errors**:

| Status | When |
|--------|------|
| `402` | No anomaly detection licence |
| `403` | On a self-hosted install with user control on: the caller is a read-only member. Only an admin can start a check |
| `404` | The connection in the header is not registered |
| `409` | A check cannot be run on this connection. The body has `reason` and the same in words as `message` |
| `429` | The last check finished or broke less than 30 seconds ago. The body has `retryAt` |
| `503` | The node list of the cluster could not be read, or it lists none of the nodes the connection was bound to |

**Response** (`202`):
```json
{
  "state": "running",
  "unavailable": null,
  "startedAt": 1704067200000,
  "finishedAt": null,
  "asked": 0,
  "total": 500,
  "retryAt": null,
  "now": 1704067200040,
  "lastFailure": null
}
```

### Resolve Anomaly or Group

```http
POST /api/anomaly/resolve
Content-Type: application/json

{
  "anomalyId": "550e8400-e29b-41d4-a716-446655440000"
}
```

Or resolve entire group:

```http
POST /api/anomaly/resolve-group
Content-Type: application/json

{
  "correlationId": "760e9500-f30c-52e5-b827-557766551111"
}
```

### Clear Resolved Anomalies

```http
DELETE /api/anomaly/resolved
```

**Response**:
```json
{
  "cleared": 39
}
```

## Tuning Guide

### Reducing False Positives

**Problem**: Too many warning alerts for normal variance

**Solutions**:
1. **Increase Z-score thresholds** (requires code change, or wait for configurable detectors)
2. **Increase consecutive required samples** (edit detector config in `anomaly.service.ts`)
3. **Lengthen cooldown periods** (prevents repeat alerts)
4. **Increase poll interval** - Less frequent sampling reduces noise

**Example**: Edit `anomaly.service.ts` configs:
```typescript
[MetricType.CONNECTIONS]: {
  warningZScore: 2.5,  // Increase from 2.0
  consecutiveRequired: 5,  // Increase from 3
  cooldownMs: 120000,  // Increase from 60000
}
```

### Increasing Sensitivity

**Problem**: Missing real issues because thresholds are too high

**Solutions**:
1. **Decrease Z-score thresholds** (e.g., 1.5 for warning instead of 2.0)
2. **Reduce consecutive required samples** (alert faster)
3. **Shorten cooldown periods** (allow more frequent alerts)
4. **Add absolute thresholds** for critical metrics

**Example**: Add absolute threshold for connections:
```typescript
[MetricType.CONNECTIONS]: {
  warningZScore: 1.8,
  criticalThreshold: 1000,  // Alert if > 1000 regardless of Z-score
}
```

### Baseline Warmup Issues

**Problem**: Detection not working immediately after startup

**Solution**: Wait for warmup period
- **Minimum**: 30 samples = 30 seconds (at 1s poll interval)
- **Optimal**: 300 samples = 5 minutes (full buffer)

Check buffer readiness:
```bash
curl -b cookies.txt -c cookies.txt http://localhost:3001/api/anomaly/buffers | jq '.buffers[] | select(.isReady == false)'
```

Or via Prometheus:
```promql
betterdb_anomaly_buffer_ready == 0
```

### Pattern Detection Not Working

**Problem**: Anomalies detected but not correlated into patterns

**Debugging**:
1. Check correlation window (default: 5 seconds) - Anomalies must occur within this window
2. Verify pattern requirements - Some patterns need specific metric combinations
3. Review custom pattern `check` functions - They may have additional logic

**Example**: `BATCH_JOB` requires connections AND ops_per_sec AND memory_used to ALL spike within 5 seconds.

### High Memory Usage

**Problem**: Anomaly detection using too much memory

**Solutions**:
1. **Reduce buffer size** (default: 300 samples per metric × 11 metrics = 3300 samples)
2. **Reduce cache TTL** (`ANOMALY_CACHE_TTL_MS`) - Older events purged sooner
3. **Reduce max recent events** (default: 1000 events, 100 groups)

**Example**: Edit `metric-buffer.ts`:
```typescript
constructor(
  private readonly metricType: MetricType,
  maxSamples: number = 150,  // Reduce from 300 (2.5 min instead of 5 min)
  minSamples: number = 20,   // Reduce from 30
)
```

## Integration with Alerting

### Prometheus + Alertmanager

**Step 1**: Configure Prometheus to scrape BetterDB

```yaml
scrape_configs:
  - job_name: 'betterdb'
    static_configs:
      - targets: ['betterdb:3001']
    metrics_path: '/api/prometheus/metrics'
    scrape_interval: 15s
```

**Step 2**: Add alert rules (see `docs/alertmanager-rules.yml`)

```yaml
groups:
  - name: betterdb-anomaly-alerts
    rules:
      - alert: BetterDBCriticalAnomaly
        expr: increase(betterdb_anomaly_events_total{severity="critical"}[5m]) > 0
        for: 0m
        labels:
          severity: critical
        annotations:
          summary: "Critical anomaly detected"
```

**Step 3**: Configure Alertmanager routing

```yaml
route:
  receiver: 'default'
  routes:
    - match:
        alertname: BetterDBCriticalAnomaly
      receiver: 'pagerduty-critical'
      continue: false
    - match:
        severity: warning
      receiver: 'slack-warnings'
```

### PagerDuty Integration

```yaml
receivers:
  - name: 'pagerduty-critical'
    pagerduty_configs:
      - service_key: '<your-service-key>'
        description: '{{ .CommonAnnotations.summary }}'
        details:
          pattern: '{{ .GroupLabels.pattern }}'
          metric_type: '{{ .GroupLabels.metric_type }}'
          instance: '{{ .GroupLabels.instance }}'
```

### Slack Integration

```yaml
receivers:
  - name: 'slack-warnings'
    slack_configs:
      - api_url: '<your-webhook-url>'
        channel: '#redis-alerts'
        title: 'BetterDB Anomaly: {{ .CommonAnnotations.summary }}'
        text: >-
          {{ range .Alerts }}
            *Pattern*: {{ .Labels.pattern }}
            *Metric*: {{ .Labels.metric_type }}
            *Severity*: {{ .Labels.severity }}
          {{ end }}
```

### Custom Webhooks

Use Alertmanager's webhook receiver:

```yaml
receivers:
  - name: 'custom-webhook'
    webhook_configs:
      - url: 'https://your-system.com/webhooks/betterdb'
        send_resolved: true
```

**Webhook payload** includes:
- Alert name and labels (severity, pattern, metric_type)
- Annotations (summary, description)
- Alert state (firing/resolved)
- Timestamps

### Grafana Alerts (Alternative)

Create alerts directly in Grafana:

1. Navigate to Alerting → Alert Rules → New Alert Rule
2. Set query: `increase(betterdb_anomaly_events_total{severity="critical"}[5m]) > 0`
3. Configure notification channel (Slack, PagerDuty, Email)
4. Set evaluation interval: 1m

## Troubleshooting

### No Anomalies Being Detected

**Check**:
1. Buffer readiness: `GET /api/anomaly/buffers` - All buffers should show `isReady: true`
2. Polling active: Check Prometheus `betterdb_polls_total` is incrementing
3. Database connectivity: `GET /api/health` should show database healthy
4. Actual variance: Your workload may be very stable (low stddev)

**Solution**: Artificially create load to test:
```bash
# Spike connections
redis-benchmark -h localhost -p 6379 -c 500 -n 100000
```

### Anomalies Detected But Not Correlated

**Check**:
1. Correlation interval: Events must occur within 5 seconds
2. Pattern requirements: Some patterns need specific metric combinations
3. Check `/api/anomaly/events` vs `/api/anomaly/groups`

**Solution**: Look for events with `correlationId: null` - these haven't been grouped yet.

### Too Many False Positives

**Check**:
1. Baseline stability: Very spiky workloads create high stddev
2. Consecutive requirements: May be too low (default: 3)
3. Cooldown periods: May be too short

**Solution**: See [Tuning Guide](#tuning-guide) above.

### Prometheus Metrics Not Updating

**Check**:
1. Prometheus summary interval: Default 30s, configurable via `ANOMALY_PROMETHEUS_INTERVAL_MS`
2. Check `/api/prometheus/metrics` endpoint directly
3. Verify Prometheus scrape config and target health

**Solution**:
```bash
# Check metrics directly
curl http://localhost:3001/api/prometheus/metrics | grep anomaly

# Check Prometheus targets
http://prometheus:9090/targets
```

### High CPU Usage from Detection

**Check**:
1. Poll interval: Default 1s may be too aggressive for slow networks
2. Number of metrics: 11 metrics × polling + correlation overhead

**Solution**: Increase poll interval:
```bash
ANOMALY_POLL_INTERVAL_MS=2000  # Poll every 2 seconds instead of 1
```

### Old Anomalies Not Being Cleared

**Check**:
1. Cache TTL: Default 1 hour (`ANOMALY_CACHE_TTL_MS`)
2. Storage backend: PostgreSQL/SQLite retains indefinitely

**Solution**: Manually clear resolved anomalies:
```bash
curl -b cookies.txt -c cookies.txt -X DELETE http://localhost:3001/api/anomaly/resolved
```

Or query historical data with time filters:
```bash
curl -b cookies.txt -c cookies.txt "http://localhost:3001/api/anomaly/events?startTime=$(date -d '1 hour ago' +%s)000"
```
