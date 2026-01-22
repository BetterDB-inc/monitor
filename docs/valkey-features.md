---
title: Valkey Features
nav_order: 5
---

# Valkey-Specific Features Guide

Complete guide to BetterDB's Valkey-first approach and exclusive features for Valkey deployments.

## Table of Contents

- [Overview](#overview)
- [COMMANDLOG Support (Valkey 8.1+)](#commandlog-support-valkey-81)
- [CLUSTER SLOT-STATS Support (Valkey 8.0+)](#cluster-slot-stats-support-valkey-80)
- [Auto-Detection (DB_TYPE=auto)](#auto-detection-db_typeauto)
- [Feature Compatibility Matrix](#feature-compatibility-matrix)
- [Graceful Degradation](#graceful-degradation)
- [Migration from Redis](#migration-from-redis)
- [Performance Considerations](#performance-considerations)
- [Future Valkey Features](#future-valkey-features)

## Overview

BetterDB Monitor is built with a **Valkey-first** philosophy while maintaining full compatibility with Redis. This approach ensures you get the best experience with Valkey's latest features while allowing seamless operation with existing Redis deployments.

### Why Valkey-First?

- **Cutting-edge features** - Access to COMMANDLOG, SLOT-STATS, and future Valkey innovations
- **Future-proof** - Designed for Valkey's roadmap, not legacy compatibility
- **Wire-compatible** - Uses `iovalkey` client library (Valkey's official Node.js client)
- **Automatic detection** - No manual configuration needed to identify Valkey vs Redis
- **Graceful fallback** - Redis deployments get full feature parity where possible

### Unified Architecture

BetterDB uses a **UnifiedDatabaseAdapter** that abstracts both Valkey and Redis:

```
┌──────────────────┐
│  BetterDB API    │
└────────┬─────────┘
         │
    ┌────▼────────────────┐
    │ UnifiedDatabase     │
    │    Adapter          │
    │ (Auto-detects type) │
    └────┬────────────────┘
         │
    ┌────▼─────┐
    │ iovalkey │ ← Wire-compatible with both Valkey & Redis
    └────┬─────┘
         │
    ┌────▼────┐
    │ Valkey  │  or  │ Redis │
    └─────────┘      └───────┘
```

**Key insight**: `iovalkey` (Valkey's official Node.js client) is wire-compatible with both Valkey and Redis, allowing a single codebase to support both seamlessly.

## COMMANDLOG Support (Valkey 8.1+)

### What is COMMANDLOG?

COMMANDLOG is Valkey's evolution of SLOWLOG, providing more granular tracking:
- **SLOWLOG**: Tracks commands that exceed execution time threshold
- **COMMANDLOG**: Tracks commands by multiple criteria:
  - `slow` - Traditional slowlog functionality
  - `large-request` - Commands with large request payloads
  - `large-reply` - Commands returning large reply payloads

### Why It Matters

Large requests/replies can impact performance even if execution time is fast:
- **Network bandwidth** consumed by large transfers
- **Memory pressure** from buffering large payloads
- **Client timeout risks** from slow network transfers
- **Hidden bottlenecks** not visible in traditional slowlog

### How BetterDB Uses COMMANDLOG

#### API Endpoints

Get commandlog entries:
```http
GET /api/metrics/commandlog?count=128&type=large-request
```

**Types**: `slow`, `large-request`, `large-reply`

Get commandlog length:
```http
GET /api/metrics/commandlog/length?type=large-reply
```

Reset commandlog:
```http
DELETE /api/metrics/commandlog?type=slow
```

Get pattern analysis:
```http
GET /api/metrics/commandlog/patterns?count=128&type=large-request
```

#### Prometheus Metrics

```promql
# Total large request entries
betterdb_commandlog_large_request

# Total large reply entries
betterdb_commandlog_large_reply

# Large requests by pattern
betterdb_commandlog_large_request_by_pattern{pattern="HGETALL *"}

# Large replies by pattern
betterdb_commandlog_large_reply_by_pattern{pattern="LRANGE *"}
```

### Example Use Cases

#### Identify Large Hash Retrievals

```bash
curl http://localhost:3001/api/metrics/commandlog/patterns?type=large-reply | jq '.patterns[] | select(.pattern | contains("HGETALL"))'
```

**Action**: Optimize by retrieving specific fields with HMGET instead of HGETALL.

#### Track Bulk Write Operations

```bash
curl http://localhost:3001/api/metrics/commandlog?type=large-request | jq '.[] | select(.command | contains("MSET"))'
```

**Action**: Rate-limit bulk operations or split into smaller batches.

#### Monitor Network Bandwidth Impact

```promql
# Correlate large replies with output bandwidth
betterdb_commandlog_large_reply * 1000 > betterdb_instantaneous_output_kbps
```

### Fallback on Redis/Older Valkey

When connected to Redis or Valkey < 8.1:
- **API returns**: HTTP 501 Not Implemented
- **Error message**: "COMMANDLOG not supported on this database version"
- **Prometheus metrics**: Not populated (no data)
- **Capability flag**: `getCapabilities().hasCommandLog === false`

## CLUSTER SLOT-STATS Support (Valkey 8.0+)

### What is SLOT-STATS?

`CLUSTER SLOT-STATS` provides per-slot statistics in cluster mode:
- **Key count** per slot
- **Expiring keys** per slot
- **Total reads** per slot
- **Total writes** per slot
- **CPU usage** per slot

### Why It Matters

Essential for cluster optimization:
- **Hotspot detection** - Identify slots with high read/write activity
- **Shard balancing** - Ensure even key distribution
- **Slot migration planning** - Data-driven resharding decisions
- **Performance troubleshooting** - Isolate slow slots

### How BetterDB Uses SLOT-STATS

#### API Endpoint

Get slot statistics:
```http
GET /api/metrics/cluster/slot-stats?orderBy=key-count&limit=100
```

**Parameters**:
- `orderBy`: `key-count` (default) or `cpu-usec`
- `limit`: Max slots to return (default: 100, prevents high cardinality)

**Response**:
```json
{
  "5461": {
    "key_count": 125000,
    "expires_count": 45000,
    "total_reads": 1234567,
    "total_writes": 456789,
    "cpu_usec": 567890
  }
}
```

#### Prometheus Metrics

```promql
# Keys in cluster slot
betterdb_cluster_slot_keys{slot="5461"}

# Expiring keys in cluster slot
betterdb_cluster_slot_expires{slot="5461"}

# Total reads for cluster slot
betterdb_cluster_slot_reads_total{slot="5461"}

# Total writes for cluster slot
betterdb_cluster_slot_writes_total{slot="5461"}
```

**Cardinality Note**: Automatically limited to top 100 slots by key count to prevent metric explosion (16,384 slots × 4 metrics = 65,536 series without limit).

### Example Use Cases

#### Find Hottest Slots by Reads

```promql
topk(10, betterdb_cluster_slot_reads_total)
```

**Action**: Consider slot migration if hotspot is on overloaded node.

#### Identify Unbalanced Key Distribution

```promql
# Standard deviation of keys per slot
stddev(betterdb_cluster_slot_keys)
```

**Action**: Rebalance cluster if stddev is high.

#### Plan Slot Migrations

```bash
# Find largest slots
curl "http://localhost:3001/api/metrics/cluster/slot-stats?orderBy=key-count&limit=10"
```

**Action**: Migrate largest slots first for balanced distribution.

#### Detect Memory-Heavy Slots

```promql
# Slots with many expiring keys (potential memory waste)
topk(5, betterdb_cluster_slot_expires)
```

**Action**: Review TTL policies for these slots.

### Fallback on Redis/Older Valkey

When connected to Redis or Valkey < 8.0:
- **API returns**: HTTP 501 Not Implemented
- **Error message**: "CLUSTER SLOT-STATS not supported on this database version"
- **Prometheus metrics**: Not populated (no data)
- **Capability flag**: `getCapabilities().hasClusterSlotStats === false`

**Note**: Even on Valkey 8.0+, SLOT-STATS requires cluster mode. Returns error if cluster is disabled.

## Auto-Detection (DB_TYPE=auto)

### How Auto-Detection Works

On connection, BetterDB inspects the `INFO server` response:

```typescript
// Detection logic (simplified)
const info = await getInfo(['server']);
const isValkey = info.server.valkey_version !== undefined;
const version = info.server.valkey_version || info.server.redis_version;

// Capability detection
capabilities = {
  dbType: isValkey ? 'valkey' : 'redis',
  version: version,
  hasCommandLog: isValkey && version >= '8.1',
  hasClusterSlotStats: isValkey && version >= '8.0',
  // ... other capabilities
};
```

**Checked fields**:
- `valkey_version` - Present on Valkey, absent on Redis
- `redis_version` - Present on both (Valkey maintains for compatibility)
- Version comparison - Determines feature availability

### Configuration Options

#### Auto-Detection (Recommended)

```bash
# .env
DB_TYPE=auto
```

BetterDB automatically detects Valkey vs Redis and enables appropriate features.

#### Explicit Override

Force Valkey mode (skips detection):
```bash
DB_TYPE=valkey
```

Force Redis mode:
```bash
DB_TYPE=redis
```

**When to override**:
- Testing feature degradation behavior
- Debugging detection issues
- Proxy/middleware that obscures database type

### Capability Flags

Check detected capabilities:

```http
GET /api/health
```

**Response**:
```json
{
  "database": {
    "status": "healthy",
    "type": "valkey",
    "version": "8.1.0",
    "capabilities": {
      "hasCommandLog": true,
      "hasSlotStats": true,
      "hasClusterSlotStats": true,
      "hasLatencyMonitor": true,
      "hasAclLog": true,
      "hasMemoryDoctor": true
    }
  }
}
```

### What Changes Based on Detection

**Valkey 8.1+**:
- COMMANDLOG endpoints enabled
- COMMANDLOG Prometheus metrics populated
- UI shows COMMANDLOG sections

**Valkey 8.0+**:
- CLUSTER SLOT-STATS endpoint enabled
- Cluster slot Prometheus metrics populated
- UI shows slot statistics dashboard

**Redis or older Valkey**:
- Valkey-specific endpoints return 501
- Valkey-specific metrics not populated
- UI gracefully hides unavailable features
- All shared features work identically

## Feature Compatibility Matrix

### Command Support

| Feature | Valkey 8.1+ | Valkey 8.0 | Valkey 7.x | Redis 7.x | Redis 6.x |
|---------|-------------|------------|------------|-----------|-----------|
| **INFO** | Yes | Yes | Yes | Yes | Yes |
| **PING** | Yes | Yes | Yes | Yes | Yes |
| **SLOWLOG** | Yes | Yes | Yes | Yes (2.2+) | Yes |
| **COMMANDLOG** | Yes | No | No | No | No |
| **CLIENT LIST** | Yes | Yes | Yes | Yes (2.4+) | Yes |
| **LATENCY** | Yes | Yes | Yes | Yes (2.8+) | Yes |
| **MEMORY STATS** | Yes | Yes | Yes | Yes (4.0+) | Yes |
| **ACL LOG** | Yes | Yes | Yes | Yes (6.0+) | Yes |
| **CLUSTER INFO** | Yes | Yes | Yes | Yes | Yes |
| **CLUSTER SLOT-STATS** | Yes | Yes | No | No | No |

### BetterDB Feature Support

| Feature Category | Valkey 8.1+ | Valkey 8.0 | Valkey 7.x | Redis 7.x | Redis 6.x |
|------------------|-------------|------------|------------|-----------|-----------|
| **Health Monitoring** | Yes | Yes | Yes | Yes | Yes |
| **Slowlog Analysis** | Yes | Yes | Yes | Yes | Yes |
| **Slowlog Patterns** | Yes | Yes | Yes | Yes | Yes |
| **Commandlog Analysis** | Yes | No | No | No | No |
| **Commandlog Patterns** | Yes | No | No | No | No |
| **Client Analytics** | Yes | Yes | Yes | Yes | Yes |
| **ACL Audit Trail** | Yes | Yes | Yes | Yes | Yes |
| **Anomaly Detection** | Yes | Yes | Yes | Yes | Yes |
| **Prometheus Metrics** | Yes | Yes | Yes | Yes | Yes |
| **Cluster Monitoring** | Yes | Yes | Yes | Yes | Yes |
| **Cluster Slot Stats** | Yes | Yes | No | No | No |
| **Latency Monitoring** | Yes | Yes | Yes | Yes | Yes |
| **Memory Analysis** | Yes | Yes | Yes | Yes (4.0+) | Yes (4.0+) |

### Version Detection Logic

```
Valkey 8.1+ → All features enabled
Valkey 8.0   → SLOT-STATS enabled, COMMANDLOG disabled
Valkey 7.x   → Valkey-specific features disabled
Redis 7.x    → Same as Valkey 7.x (full parity)
Redis 6.x    → ACL and newer features enabled
Redis <6.0   → Basic monitoring only
```

## Graceful Degradation

### How BetterDB Handles Missing Features

#### 1. API Endpoints

**Behavior**:
- Valkey-specific endpoints check `capabilities.hasCommandLog` or `capabilities.hasClusterSlotStats`
- If feature unavailable, return HTTP 501 Not Implemented
- Error message clearly states version requirement

**Example**:
```json
{
  "statusCode": 501,
  "message": "Failed to get commandlog: COMMANDLOG not supported on this database version"
}
```

#### 2. Prometheus Metrics

**Behavior**:
- Valkey-specific metrics simply not populated (no data)
- No errors or warnings in metrics output
- Queries return empty results

**Example**:
```promql
# On Redis: returns no data (not an error)
betterdb_commandlog_large_request

# Generic metrics work normally
betterdb_slowlog_length
```

#### 3. Frontend UI

**Behavior** (implementation-specific):
- UI checks `/health` endpoint capabilities
- Hides or grays out unavailable features
- Shows informational message: "COMMANDLOG requires Valkey 8.1+"

#### 4. No Breaking Changes

**Guarantee**: Connecting to Redis never breaks BetterDB
- All shared functionality works identically
- No configuration changes needed when switching databases
- Smooth transition path for Redis → Valkey migration

### Error Messages

Clear, actionable error messages:

```
"COMMANDLOG not supported on this database version"
   → Requires Valkey 8.1+

"CLUSTER SLOT-STATS not supported on this database version"
   → Requires Valkey 8.0+ in cluster mode

"Capabilities not yet detected. Call connect() first."
   → Internal error, report if seen by user
```

## Migration from Redis

### Step-by-Step Migration Guide

#### Phase 1: Pre-Migration Assessment

1. **Check current Redis version**:
```bash
redis-cli INFO server | grep redis_version
```

2. **Identify Redis-specific features in use**:
- Redis modules (RedisJSON, RedisGraph, RediSearch)
- Redis-specific commands
- Custom Lua scripts

3. **Review Valkey compatibility**:
- Valkey maintains wire-protocol compatibility
- Most features have direct equivalents
- See [Valkey documentation](https://valkey.io/docs/) for details

#### Phase 2: Test with BetterDB

1. **Connect BetterDB to existing Redis**:
```bash
docker run -d \
  --name betterdb-redis-test \
  -p 3001:3001 \
  -e DB_HOST=your-redis-host \
  -e DB_PORT=6379 \
  -e DB_PASSWORD=your-password \
  -e DB_TYPE=auto \
  betterdb/monitor
```

2. **Verify functionality**:
```bash
curl http://localhost:3001/health
```

Expected output:
```json
{
  "database": {
    "type": "redis",
    "version": "7.2.0",
    "capabilities": {
      "hasCommandLog": false,
      "hasClusterSlotStats": false
    }
  }
}
```

3. **Baseline metrics**:
- Export slowlog patterns
- Document current performance baseline
- Save client analytics data

#### Phase 3: Valkey Deployment

1. **Deploy Valkey instance**:
```bash
# Example: Docker
docker run -d \
  --name valkey \
  -p 6379:6379 \
  valkey/valkey:8.1
```

2. **Migrate data** (choose one method):

   **Option A: RDB Snapshot**
   ```bash
   # On Redis
   redis-cli SAVE
   # Copy dump.rdb to Valkey data directory
   # Restart Valkey
   ```

   **Option B: Live Replication**
   ```bash
   # Configure Valkey as Redis replica
   valkey-cli REPLICAOF redis-host 6379
   # Wait for sync
   # Promote Valkey to master
   valkey-cli REPLICAOF NO ONE
   ```

   **Option C: redis-dump/restore**
   ```bash
   # Export from Redis
   redis-dump -u redis://host:6379 > data.json
   # Import to Valkey
   redis-load -u valkey://host:6379 < data.json
   ```

3. **Point BetterDB to Valkey**:
```bash
# Update connection
DB_HOST=your-valkey-host
```

4. **Verify upgraded capabilities**:
```bash
curl http://localhost:3001/health
```

Expected output:
```json
{
  "database": {
    "type": "valkey",
    "version": "8.1.0",
    "capabilities": {
      "hasCommandLog": true,
      "hasClusterSlotStats": true
    }
  }
}
```

#### Phase 4: Leverage New Features

1. **Enable COMMANDLOG**:
```bash
valkey-cli CONFIG SET commandlog-max-len 128
```

2. **Explore new endpoints**:
```bash
# Check for large requests
curl http://localhost:3001/api/metrics/commandlog/patterns?type=large-request

# Analyze slot distribution (if cluster)
curl http://localhost:3001/api/metrics/cluster/slot-stats?limit=10
```

3. **Update Prometheus dashboards**:
- Add COMMANDLOG panels
- Add cluster slot stats visualizations

### Configuration Changes

**No changes required!** BetterDB auto-detects the switch:

```bash
# Before (Redis)
DB_TYPE=auto  # Detects Redis

# After (Valkey)
DB_TYPE=auto  # Detects Valkey, enables new features
```

### Performance Comparison

**Metrics to track during migration**:

```promql
# Operations per second
rate(betterdb_commands_processed_total[5m])

# Memory efficiency
betterdb_memory_used_bytes

# Network throughput
betterdb_instantaneous_input_kbps + betterdb_instantaneous_output_kbps

# Latency (if using latency monitor)
betterdb_nodejs_eventloop_lag_p99_seconds
```

### Rollback Plan

If issues arise:

1. **Immediate rollback**:
```bash
# Point BetterDB back to Redis
DB_HOST=original-redis-host
```

2. **Data rollback** (if using replication):
```bash
# Reverse replication direction
redis-cli REPLICAOF valkey-host 6379
```

3. **Verify**:
```bash
curl http://localhost:3001/health
# Should show type: "redis"
```

## Performance Considerations

### Valkey Performance Characteristics

**Generally comparable to Redis**:
- Same wire protocol = similar network overhead
- Optimized for modern hardware
- Some operations may be faster due to active development

### BetterDB Overhead

**Minimal impact**:
- Single connection with `connectionName: 'BetterDB-Monitor'`
- Polling interval: configurable (default 1s for anomaly detection)
- Read-only operations (no writes to monitored database)

**Estimated overhead**:
- CPU: < 1% on monitored instance
- Memory: ~10MB for connection
- Network: ~1-5 KB/s depending on INFO size

### COMMANDLOG Performance Impact

**On Valkey instance**:
- COMMANDLOG adds minimal overhead (< 0.1% CPU)
- Circular buffer with max length (configure via `commandlog-max-len`)
- No disk I/O (in-memory only)

**On BetterDB**:
- Fetching 128 entries: ~10-50ms (depends on network)
- Pattern analysis: ~5-20ms CPU time
- Prometheus metrics update: every 30s (configurable)

### SLOT-STATS Performance Impact

**On Valkey cluster**:
- Computation per slot: ~0.1ms
- Total for 100 slots: ~10ms
- No caching (computed on-demand)

**On BetterDB**:
- Fetching stats: ~50-200ms (depends on cluster size)
- Limited to 100 slots to prevent overhead
- Cached in Prometheus metrics (updated on scrape)

### Optimization Recommendations

1. **Reduce poll frequency** if overhead is concern:
```bash
ANOMALY_POLL_INTERVAL_MS=2000  # Poll every 2s instead of 1s
```

2. **Increase Prometheus scrape interval**:
```yaml
scrape_interval: 30s  # Instead of 15s
```

3. **Limit COMMANDLOG size** on Valkey:
```bash
valkey-cli CONFIG SET commandlog-max-len 64
```

4. **Use separate connection pool** for monitoring (already default):
```bash
# BetterDB uses dedicated connection, not application pool
connectionName: 'BetterDB-Monitor'
```

## Future Valkey Features

BetterDB is designed to incorporate upcoming Valkey features as they become available.

### Planned Integrations

**COMMANDLOG enhancements** (future Valkey versions):
- Additional log types beyond slow/large-request/large-reply
- Per-user COMMANDLOG tracking
- COMMANDLOG export/import for analysis

**Cluster improvements**:
- Enhanced SLOT-STATS with more granular metrics
- Slot migration progress tracking
- Cross-cluster analytics

**Observability**:
- Native OpenTelemetry support
- Structured logging integration
- Advanced tracing capabilities

### Contributing

Feature requests for Valkey integration:
1. Open issue at [BetterDB GitHub](https://github.com/betterdb-inc/monitor/issues)
2. Check [Valkey roadmap](https://github.com/valkey-io/valkey/issues)
3. Propose implementation in BetterDB

### Staying Updated

Monitor these sources for new features:
- **Valkey releases**: https://github.com/valkey-io/valkey/releases
- **BetterDB changelog**: Check repository for updates
- **iovalkey updates**: https://github.com/valkey-io/iovalkey

---

## Quick Reference

### Environment Variables

```bash
# Database connection
DB_HOST=localhost
DB_PORT=6379
DB_TYPE=auto          # auto, valkey, or redis

# Enable features (auto-detected, but can override)
# No configuration needed - features enable automatically based on version
```

### Capability Checking

```bash
# Check what's available
curl http://localhost:3001/health | jq '.database.capabilities'
```

### Testing Valkey-Specific Features

```bash
# COMMANDLOG
curl http://localhost:3001/api/metrics/commandlog?type=large-request

# SLOT-STATS (cluster only)
curl http://localhost:3001/api/metrics/cluster/slot-stats?limit=10
```

### Prometheus Queries

```promql
# Check database type
betterdb_instance_info{version=~"8.*"}

# COMMANDLOG availability
betterdb_commandlog_large_request > 0

# Cluster slot distribution
topk(10, betterdb_cluster_slot_keys)
```
