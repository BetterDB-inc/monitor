#!/bin/zsh

# Simulates a gradually increasing throughput load on Valkey for testing
# the Throughput Forecasting feature.
#
# Usage:
#   ./scripts/demo/throughput-ramp.sh [options]
#
# Options:
#   -h, --host       Valkey host (default: localhost)
#   -p, --port       Valkey port (default: 6380)
#   -a, --auth       Password (default: devpassword)
#   -d, --duration   Total duration in minutes (default: 60)
#   -s, --start-rps  Starting requests per second (default: 100)
#   -e, --end-rps    Ending requests per second (default: 5000)
#   --pattern        Load pattern: ramp|spike|wave (default: ramp)
#   --grow-keys      Write unique keys each tick so memory grows over time
#   --value-size     Value size in bytes for --grow-keys (default: 1024)
#   --cleanup        Remove generated keys on exit
#
# Patterns:
#   ramp  - Linear increase from start-rps to end-rps over duration
#   spike - Steady at start-rps, then sudden jump to end-rps at 75% of duration
#   wave  - Oscillates between start-rps and end-rps with 10-minute period

set -eo pipefail

HOST="localhost"
PORT="6380"
AUTH=""
DURATION_MIN=60
START_RPS=100
END_RPS=5000
PATTERN="ramp"
GROW_KEYS=false
VALUE_SIZE=1024
CLEANUP=false
KEY_PREFIX="throughput_test"

while [[ $# -gt 0 ]]; do
  case $1 in
    -h|--host) HOST="$2"; shift 2;;
    -p|--port) PORT="$2"; shift 2;;
    -a|--auth) AUTH="$2"; shift 2;;
    -d|--duration) DURATION_MIN="$2"; shift 2;;
    -s|--start-rps) START_RPS="$2"; shift 2;;
    -e|--end-rps) END_RPS="$2"; shift 2;;
    --pattern) PATTERN="$2"; shift 2;;
    --grow-keys) GROW_KEYS=true; shift;;
    --value-size) VALUE_SIZE="$2"; shift 2;;
    --cleanup) CLEANUP=true; shift;;
    *) echo "Unknown option: $1"; exit 1;;
  esac
done

USE_DOCKER=false
CLI=""
AUTH_ARGS=()
[[ -n "$AUTH" ]] && AUTH_ARGS=(-a "$AUTH")

if command -v valkey-cli &> /dev/null; then
  CLI="valkey-cli"
elif command -v redis-cli &> /dev/null; then
  CLI="redis-cli"
elif docker exec betterdb-monitor-valkey valkey-cli "${AUTH_ARGS[@]}" PING > /dev/null 2>&1; then
  USE_DOCKER=true
  echo "  Using docker exec (no local CLI found)"
else
  echo "Error: No valkey-cli, redis-cli, or running Docker container found"
  exit 1
fi

# Build CLI command as an array to preserve argument boundaries
if $USE_DOCKER; then
  CLI_CMD=(docker exec -i betterdb-monitor-valkey valkey-cli "${AUTH_ARGS[@]}")
  CLI_PIPE=(docker exec -i betterdb-monitor-valkey valkey-cli "${AUTH_ARGS[@]}" --pipe)
else
  CLI_CMD=("$CLI" -h "$HOST" -p "$PORT" "${AUTH_ARGS[@]}")
  CLI_PIPE=("$CLI" -h "$HOST" -p "$PORT" "${AUTH_ARGS[@]}" --pipe)
fi

# Verify connection
if ! "${CLI_CMD[@]}" PING > /dev/null 2>&1; then
  echo "Error: Cannot connect to Valkey"
  exit 1
fi

DURATION_SEC=$((DURATION_MIN * 60))
TICK_SEC=1  # Adjust load every 1 second for smoother throughput
TOTAL_TICKS=$((DURATION_SEC / TICK_SEC))
KEY_COUNTER=0

cleanup() {
  echo ""
  echo "Stopping load generation..."

  if $CLEANUP; then
    echo "Cleaning up keys..."
    cursor=0
    while true; do
      result=$("${CLI_CMD[@]}" SCAN "$cursor" MATCH "${KEY_PREFIX}_*" COUNT 1000 2>/dev/null)
      cursor=$(echo "$result" | head -1)
      keys=$(echo "$result" | tail -n +2)
      if [[ -n "$keys" ]]; then
        echo "$keys" | xargs "${CLI_CMD[@]}" DEL > /dev/null 2>&1
      fi
      [[ "$cursor" == "0" ]] && break
    done
    echo "Cleanup complete."
  fi
}

trap cleanup EXIT INT TERM

get_target_rps() {
  local tick=$1

  case $PATTERN in
    ramp)
      # Linear interpolation from START_RPS to END_RPS
      local progress
      progress=$(echo "scale=4; $tick / $TOTAL_TICKS" | bc)
      echo "scale=0; $START_RPS + ($END_RPS - $START_RPS) * $progress / 1" | bc
      ;;
    spike)
      # Steady at START_RPS, jump to END_RPS at 75% duration
      local threshold=$((TOTAL_TICKS * 3 / 4))
      if [[ $tick -lt $threshold ]]; then
        echo "$START_RPS"
      else
        echo "$END_RPS"
      fi
      ;;
    wave)
      # Sinusoidal oscillation with 10-minute period
      local mid=$(( (START_RPS + END_RPS) / 2 ))
      local amp=$(( (END_RPS - START_RPS) / 2 ))
      local period_ticks=$((600 / TICK_SEC))  # 10 min period
      local angle
      angle=$(echo "scale=6; 3.14159 * 2 * $tick / $period_ticks" | bc)
      local sin_val
      sin_val=$(echo "scale=6; s($angle)" | bc -l)
      echo "scale=0; $mid + $amp * $sin_val / 1" | bc
      ;;
    *)
      echo "$START_RPS"
      ;;
  esac
}

# Pre-generate the value payload for --grow-keys mode
if $GROW_KEYS; then
  VALUE_PAYLOAD=$(head -c "$VALUE_SIZE" < /dev/zero | tr '\0' 'x')
fi

# Generate load at target RPS for one tick (TICK_SEC seconds)
# Spreads commands evenly across the tick in small batches (every 100ms)
# so Valkey's instantaneous_ops_per_sec rolling average stays accurate.
run_tick() {
  local target_rps=$1
  local total_ops=$((target_rps * TICK_SEC))
  if ((total_ops < 1)); then total_ops=1; fi

  # Split into 10 batches per second (every 100ms) so the load is steady
  local batches_per_sec=10
  local batch_count=$((TICK_SEC * batches_per_sec))
  local ops_per_batch=$(( (total_ops + batch_count - 1) / batch_count ))
  local delay=$(printf "%.3f" $(echo "scale=3; 1.0 / $batches_per_sec" | bc))

  local sent=0
  for ((b = 0; b < batch_count && sent < total_ops; b++)); do
    local this_batch=$ops_per_batch
    ((sent + this_batch > total_ops)) && this_batch=$((total_ops - sent))

    local batch=""
    if $GROW_KEYS; then
      local val_len=${#VALUE_PAYLOAD}
      for ((i = 0; i < this_batch; i++)); do
        local key="${KEY_PREFIX}_${KEY_COUNTER}"
        KEY_COUNTER=$((KEY_COUNTER + 1))
        batch+="*3\r\n\$3\r\nSET\r\n\$${#key}\r\n${key}\r\n\$${val_len}\r\n${VALUE_PAYLOAD}\r\n"
      done
    else
      for ((i = 0; i < this_batch; i++)); do
        batch+="*1\r\n\$4\r\nPING\r\n"
      done
    fi
    printf "$batch" | "${CLI_PIPE[@]}" > /dev/null 2>&1
    sent=$((sent + this_batch))

    sleep "$delay"
  done
}

echo "============================================"
echo "  Throughput Ramp - Load Generator"
echo "============================================"
echo ""
echo "  Target:    $HOST:$PORT"
echo "  Pattern:   $PATTERN"
echo "  Duration:  ${DURATION_MIN}m"
echo "  Start RPS: $START_RPS"
echo "  End RPS:   $END_RPS"
echo "  Grow keys: $GROW_KEYS"
if $GROW_KEYS; then
echo "  Value size: ${VALUE_SIZE}B"
fi
echo "  Cleanup:   $CLEANUP"
echo ""
echo "  Press Ctrl+C to stop"
echo ""

START_TIME=$(date +%s)

for ((tick = 0; tick < TOTAL_TICKS; tick++)); do
  target_rps=$(get_target_rps $tick)
  elapsed_min=$(( (tick * TICK_SEC) / 60 ))
  remaining_min=$(( (DURATION_SEC - tick * TICK_SEC) / 60 ))

  # Progress bar
  local pct=$((tick * 100 / TOTAL_TICKS))
  local bar_len=20
  local filled=$((pct * bar_len / 100))
  local empty=$((bar_len - filled))
  local bar=$(printf '%0.s█' $(seq 1 $filled 2>/dev/null))$(printf '%0.s░' $(seq 1 $empty 2>/dev/null))

  printf "\r  %s %3d%% | %3dm/%dm | %5d ops/sec | %s | %dm left " \
    "$bar" "$pct" "$elapsed_min" "$DURATION_MIN" "$target_rps" "$PATTERN" "$remaining_min"

  run_tick "$target_rps"
done

echo ""
echo ""
echo "Load generation complete."
echo "Total runtime: $(( $(date +%s) - START_TIME ))s"
