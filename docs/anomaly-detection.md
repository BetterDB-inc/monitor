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
| `acl_denied` | 10 events | 50 events | 2 | 30s |
| `slowlog_last_id` | - | - | 1 | 30s |
| `memory_used` | - | - | 3 | 60s |
| `evicted_keys` | - | - | 2 | 30s |
| `fragmentation_ratio` | 1.5 | 2.0 | 5 | 120s |

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
**What it measures**: Sum of rejected connections and ACL auth denials
**Why anomalies matter**: Security concern - possible brute force or misconfig
**Typical baseline**: 0-5 (should be very low normally)
**Source**: `INFO stats.rejected_connections + stats.acl_access_denied_auth`
**Config**: Custom thresholds (WARNING: 10, CRITICAL: 50, 2 consecutive, 30s cooldown)

### evicted_keys
**What it measures**: Total number of keys evicted due to maxmemory
**Why anomalies matter**: Indicates memory pressure and cache thrashing
**Typical baseline**: 0 (ideally), or consistent low rate
**Source**: `INFO stats.evicted_keys`
**Config**: Custom thresholds (2 consecutive, 30s cooldown)

### blocked_clients
**What it measures**: Clients blocked on BLPOP, BRPOP, etc.
**Why anomalies matter**: May indicate queue backup or deadlock
**Typical baseline**: 0-10 (depends on usage of blocking commands)
**Source**: `INFO clients.blocked_clients`

### keyspace_misses
**What it measures**: Total number of failed key lookups
**Why anomalies matter**: Poor cache hit rate impacts application performance
**Typical baseline**: Varies widely (track hit ratio instead)
**Source**: `INFO stats.keyspace_misses`

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
```

### Runtime Settings

You can adjust these settings without restarting via the `/settings` API:

```bash
curl -X PUT http://localhost:3001/settings \
  -H "Content-Type: application/json" \
  -d '{
    "anomalyPollIntervalMs": 500,
    "anomalyCacheTtlMs": 7200000,
    "anomalyPrometheusIntervalMs": 15000
  }'
```

**Note**: Changing `anomalyPollIntervalMs` affects detection sensitivity. Faster polling = quicker detection but higher overhead.

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
      "resolved": false
    }
  ]
}
```

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
curl http://localhost:3001/api/anomaly/buffers | jq '.buffers[] | select(.isReady == false)'
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
    metrics_path: '/prometheus/metrics'
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
3. Database connectivity: `GET /health` should show database healthy
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
2. Check `/prometheus/metrics` endpoint directly
3. Verify Prometheus scrape config and target health

**Solution**:
```bash
# Check metrics directly
curl http://localhost:3001/prometheus/metrics | grep anomaly

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
curl -X DELETE http://localhost:3001/api/anomaly/resolved
```

Or query historical data with time filters:
```bash
curl "http://localhost:3001/api/anomaly/events?startTime=$(date -d '1 hour ago' +%s)000"
```
