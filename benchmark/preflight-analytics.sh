#!/usr/bin/env bash
#
# Preflight checks for Client Analytics validation tests.
# Verifies all dependencies, connectivity, and endpoints are ready.
#

set -euo pipefail

# Configuration
VALKEY_PORT="${VALKEY_PORT:-6380}"
VALKEY_PASSWORD="${VALKEY_PASSWORD:-devpassword}"
BETTERDB_URL="${BETTERDB_URL:-http://localhost:3001}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

FAILURES=0

log_info() {
    echo -e "${GREEN}✓${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}⚠${NC} $1"
}

log_error() {
    echo -e "${RED}✗${NC} $1"
    FAILURES=$((FAILURES + 1))
}

check_command() {
    local cmd=$1
    local name=${2:-$cmd}

    if command -v "$cmd" &> /dev/null; then
        log_info "$name is installed"
        return 0
    else
        log_error "$name is not installed (required: $cmd)"
        return 1
    fi
}

check_valkey_connectivity() {
    if valkey-cli -p "$VALKEY_PORT" -a "$VALKEY_PASSWORD" --no-auth-warning PING &> /dev/null; then
        log_info "Valkey is accessible on port $VALKEY_PORT"
        return 0
    else
        log_error "Valkey is not accessible on port $VALKEY_PORT (check password with VALKEY_PASSWORD env var)"
        return 1
    fi
}

check_betterdb_health() {
    local response
    local status_code

    response=$(curl -s -w "\n%{http_code}" "$BETTERDB_URL/health" 2>/dev/null || echo -e "\n000")
    status_code=$(echo "$response" | tail -n 1)

    if [ "$status_code" = "200" ]; then
        log_info "BetterDB health endpoint is accessible"

        # Check if connected to Valkey
        local body=$(echo "$response" | head -n -1)
        local db_status=$(echo "$body" | python3 -c "import sys, json; print(json.load(sys.stdin).get('status', 'unknown'))" 2>/dev/null || echo "unknown")

        if [ "$db_status" = "connected" ]; then
            log_info "BetterDB is connected to database"
            return 0
        else
            log_error "BetterDB is not connected to database (status: $db_status)"
            return 1
        fi
    else
        log_error "BetterDB health endpoint returned status $status_code"
        return 1
    fi
}

check_analytics_endpoint() {
    local endpoint=$1
    local name=$2
    local url="$BETTERDB_URL/client-analytics/$endpoint"
    local status_code

    status_code=$(curl -s -o /dev/null -w "%{http_code}" "$url" 2>/dev/null || echo "000")

    if [ "$status_code" = "200" ]; then
        log_info "$name endpoint is accessible"
        return 0
    else
        log_error "$name endpoint returned status $status_code (URL: $url)"
        return 1
    fi
}

check_client_snapshots() {
    local response
    local connection_count

    # Get snapshots from the last 60 seconds
    local end_time=$(($(date +%s) * 1000))
    local start_time=$((end_time - 60000))

    response=$(curl -s "$BETTERDB_URL/client-analytics/activity-timeline?startTime=$start_time&endTime=$end_time" 2>/dev/null || echo "{}")
    connection_count=$(echo "$response" | python3 -c "import sys, json; data = json.load(sys.stdin); print(sum(b.get('totalConnections', 0) for b in data.get('buckets', [])))" 2>/dev/null || echo "0")

    if [ "$connection_count" -gt 0 ]; then
        log_info "Client snapshots are being collected ($connection_count connections in last 60s)"
        return 0
    else
        log_warn "No client snapshots found in last 60 seconds (this may be normal if no activity)"
        # Don't count this as a failure, just a warning
        return 0
    fi
}

echo "=================================================="
echo "Client Analytics Preflight Checks"
echo "=================================================="
echo "Valkey Port: $VALKEY_PORT"
echo "Valkey Password: ${VALKEY_PASSWORD:0:3}***"
echo "BetterDB URL: $BETTERDB_URL"
echo ""

echo "1. Checking dependencies..."
check_command python3 "Python 3"
check_command valkey-benchmark "valkey-benchmark"
check_command valkey-cli "valkey-cli"
check_command curl "curl"
echo ""

echo "2. Checking Valkey connectivity..."
check_valkey_connectivity
echo ""

echo "3. Checking BetterDB..."
check_betterdb_health
echo ""

echo "4. Checking analytics endpoints..."
check_analytics_endpoint "command-distribution" "Command Distribution"
check_analytics_endpoint "idle-connections" "Idle Connections"
check_analytics_endpoint "buffer-anomalies" "Buffer Anomalies"
check_analytics_endpoint "activity-timeline" "Activity Timeline"
check_analytics_endpoint "spike-detection" "Spike Detection"
echo ""

echo "5. Checking client snapshot collection..."
check_client_snapshots
echo ""

echo "=================================================="
if [ $FAILURES -eq 0 ]; then
    echo -e "${GREEN}All checks passed!${NC}"
    echo ""
    echo "Ready to run validation tests:"
    echo "  python3 benchmark/analytics-validation.py"
    exit 0
else
    echo -e "${RED}$FAILURES check(s) failed${NC}"
    echo ""
    echo "Please fix the issues above before running validation tests."
    exit 1
fi
