# BetterDB Benchmarks

This directory contains two types of benchmarks:

1. **Performance Benchmarks** - Measure BetterDB's monitoring overhead
2. **Analytics Validation** - Validate Client Analytics endpoints

---

## Performance Benchmarks

Measures BetterDB's monitoring overhead on Valkey using interleaved randomized pairs to eliminate warm-up bias.

### Setup

```bash
# Create venv and install dependencies
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Setup valkey-perf-benchmark (optional, for extended benchmarks)
cd valkey-perf-benchmark
pip install -r requirements.txt
cd ..

# Run preflight checks
./preflight-interleaved.sh
```

### Usage

```bash
# Activate venv first
source venv/bin/activate

# Quick (~5 min)
python3 interleaved_benchmark.py --runs 5 --config configs/betterdb-quick.json

# Full (~15 min)
python3 interleaved_benchmark.py --runs 10 --config configs/betterdb-full.json
```

### Configs

- `betterdb-quick.json` - SET/GET, 64-256 bytes, pipeline 1/16
- `betterdb-full.json` - SET/GET/HSET/LPUSH, 64-1024 bytes, pipeline 1/10/50

### Reading Results

- Overhead <1%: noise
- Overhead 1-5%: acceptable
- Overhead >5%: investigate
- CV >15%: increase runs or check system stability

### Optional: System Tuning

```bash
sudo ./system_prep.sh
```

Disables turbo boost, sets performance governor. Resets on reboot.

---

## Analytics Validation Tests

Validates that the Client Analytics endpoints correctly detect anomalies and track client behavior.

### Prerequisites

- `python3`, `valkey-benchmark`, `valkey-cli`, `curl`
- Valkey running on port 6380 (default)
- BetterDB API running on port 3001 (default)

### Usage

**1. Run preflight checks:**
```bash
./preflight-analytics.sh
```

**2. Run all validation tests:**
```bash
python3 analytics-validation.py
```

**3. Run specific tests:**
```bash
python3 analytics-validation.py --tests idle buffer timeline
```

**Available tests:**
- `spike` - Connection spike detection (~60s)
- `idle` - Idle connection detection (~90s)
- `distribution` - Command distribution (~30s)
- `buffer` - Buffer anomaly detection (~20s)
- `timeline` - Activity timeline (~120s)
- `perf` - Performance overhead (~30s)
- `all` - Run all tests (default)

**Custom configuration:**
```bash
python3 analytics-validation.py --port 6380 --password devpassword --url http://localhost:3001
```

### Important Limitations

**1. Client snapshot polling interval**

The default snapshot polling interval is **60 seconds** (configurable via `CLIENT_ANALYTICS_POLL_INTERVAL_MS`). This affects capture rates:
- Fast `valkey-benchmark` connections (< 60s duration) may not be captured
- Most benchmarks complete between snapshot intervals
- Tests use slower patterns or persistent connections (e.g., SUBSCRIBE, long-running workers)
- Seeing only "BetterDB-Monitor" in snapshots is normal and expected

**2. Buffer metrics are extremely transient**

Buffer metrics (qbuf, omem, etc.) exist only during command execution (microseconds to milliseconds):
- With default 60s polling, buffer metrics will almost always be 0
- To capture buffer metrics, either:
  - Set `CLIENT_ANALYTICS_POLL_INTERVAL_MS=1000` (1 second polling)
  - Check during sustained high-throughput periods in production
  - Use pipelined operations to create sustained buffer pressure
- Seeing buffer metrics at 0 is normal and expected for most workloads

For command distribution validation in production:
- Use application clients with connection pooling (persist >1s)
- Test manually with `valkey-cli` in separate terminals
- Review real production data where long-lived connections exist

### Test Results Legend

- **✓ PASS** - Test validated successfully
- **✗ FAIL** - Test found an issue
- **⚠ SKIP** - Test skipped (not a failure, scenario wasn't applicable)

A "skip" result typically means the test scenario wasn't compatible with the environment (e.g., benchmark too fast for snapshot interval), which is expected behavior.
