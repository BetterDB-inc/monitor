#!/bin/bash
set -euo pipefail

BETTERDB_CONTAINER="${BETTERDB_CONTAINER:-benchmark-betterdb}"
BETTERDB_URL="${BETTERDB_URL:-http://localhost:3002}"
VALKEY_PORT="${VALKEY_PORT:-6382}"

echo "Preflight check..."
echo

ERRORS=0

check() {
    local name="$1"
    local cmd="$2"
    printf "%-40s" "$name"
    if eval "$cmd" >/dev/null 2>&1; then
        echo "ok"
        return 0
    else
        echo "FAIL"
        ((ERRORS++))
        return 1
    fi
}

check "interleaved_benchmark.py exists" "[[ -f interleaved_benchmark.py ]]"
check "python3" "command -v python3"
check "python stdlib imports" "python3 -c 'import subprocess, json, random, urllib.request'"
check "python-dotenv" "python3 -c 'import dotenv'"

# valkey-cli or redis-cli
printf "%-40s" "valkey-cli or redis-cli"
if command -v valkey-cli >/dev/null 2>&1; then
    echo "ok (valkey-cli)"
    CLI="valkey-cli"
elif command -v redis-cli >/dev/null 2>&1; then
    echo "ok (redis-cli)"
    CLI="redis-cli"
else
    echo "FAIL"
    ((ERRORS++))
    CLI=""
fi

# valkey-benchmark
printf "%-40s" "valkey-benchmark"
if command -v valkey-benchmark >/dev/null 2>&1; then
    echo "ok"
elif command -v redis-benchmark >/dev/null 2>&1; then
    echo "ok (redis-benchmark, consider symlinking)"
else
    echo "FAIL"
    ((ERRORS++))
fi

# valkey connectivity
if [ -n "$CLI" ]; then
    check "valkey ping (localhost:$VALKEY_PORT)" "$CLI -h localhost -p $VALKEY_PORT PING"
fi

check "docker" "command -v docker"
check "container $BETTERDB_CONTAINER exists" "docker ps -a --format '{{.Names}}' | grep -q '^${BETTERDB_CONTAINER}$'"

# health endpoint (warning only)
printf "%-40s" "betterdb health endpoint"
if curl -sf "${BETTERDB_URL}/api/health" | grep -q '"status"'; then
    echo "ok"
else
    echo "warn (not responding)"
fi

check "configs/betterdb-quick.json" "[[ -f configs/betterdb-quick.json ]]"

# poll counter metric
echo
echo "Poll counter verification..."
printf "%-40s" "betterdb_polls_total metric"
METRICS=$(curl -s "${BETTERDB_URL}/prometheus/metrics" 2>/dev/null || echo "")
if echo "$METRICS" | grep -q "betterdb_polls_total"; then
    POLL_COUNT=$(echo "$METRICS" | grep "^betterdb_polls_total" | awk '{print $2}')
    echo "ok ($POLL_COUNT)"

    printf "%-40s" "counter increments (15s wait)"
    sleep 15
    METRICS2=$(curl -s "${BETTERDB_URL}/prometheus/metrics" 2>/dev/null || echo "")
    POLL_COUNT2=$(echo "$METRICS2" | grep "^betterdb_polls_total" | awk '{print $2}')
    if awk -v a="$POLL_COUNT2" -v b="$POLL_COUNT" 'BEGIN{exit !(a > b)}'; then
        DELTA=$(awk -v a="$POLL_COUNT2" -v b="$POLL_COUNT" 'BEGIN{printf "%.0f", a - b}')
        echo "ok (+$DELTA)"
    else
        echo "warn (no change)"
    fi
else
    echo "FAIL (metric not found)"
    ((ERRORS++))
fi

echo
if [ $ERRORS -eq 0 ]; then
    echo "All checks passed."
    echo
    echo "Run:"
    echo "  python3 interleaved_benchmark.py --runs 5 --config configs/betterdb-quick.json"
    exit 0
else
    echo "Preflight failed ($ERRORS errors)"
    exit 1
fi
