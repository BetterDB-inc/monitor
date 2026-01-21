# BetterDB Scripts

Utility scripts for development, testing, and demos.

## Directory Structure

### cluster/migrations/
Demo scripts for visualizing slot migrations in the BetterDB Monitor.

| Script | Description |
|--------|-------------|
| `start-slow.sh` | Starts a migration and pauses for UI visualization |
| `complete.sh` | Completes a paused migration |
| `cancel.sh` | Cancels a paused migration |
| `demo-full.sh` | Runs a complete migration demo (slots 100-110) |

### benchmark/
Scripts for performance testing and validation.

| Script | Description |
|--------|-------------|
| `preflight-analytics.sh` | Verifies dependencies for analytics validation tests |
| `preflight-interleaved.sh` | Verifies dependencies for performance benchmarks |
| `system-prep.sh` | Tunes system for accurate benchmarking (run as root) |

### demo/
Demo scripts for testing BetterDB features.

| Script | Description |
|--------|-------------|
| `spike-anomalies.sh` | Generates various metric anomalies for testing anomaly detection |

## Usage Examples

### Run a slot migration demo
```bash
# Start migration (pauses for visualization)
./scripts/cluster/migrations/start-slow.sh

# View in BetterDB Monitor at http://localhost:5173

# Complete or cancel
./scripts/cluster/migrations/complete.sh
# OR
./scripts/cluster/migrations/cancel.sh
```

### Run benchmarks
```bash
# Check prerequisites
./scripts/benchmark/preflight-interleaved.sh

# Optional: tune system (requires root)
sudo ./scripts/benchmark/system-prep.sh

# Run benchmark
cd benchmark
python3 interleaved_benchmark.py --runs 5 --config configs/betterdb-quick.json
```

### Generate anomalies for testing
```bash
./scripts/demo/spike-anomalies.sh
```

## Notes

- All scripts assume they are run from the repository root
- Scripts are designed to work with the local Docker Compose setup
- For production use, review and adjust scripts as needed
