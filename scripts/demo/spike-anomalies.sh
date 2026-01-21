#!/bin/bash

# Script to generate anomalies in Valkey/Redis metrics

echo "Generating anomalies to spike the 'by metric type' graph..."
echo ""

spike_ops() {
  echo "Spiking OPS_PER_SEC..."
  for i in {1..10000}; do
    valkey-cli -a devpassword SET "spike_key_$i" "value_$i" > /dev/null 2>&1
  done &
  for i in {10001..20000}; do
    valkey-cli -a devpassword GET "spike_key_$((i-10000))" > /dev/null 2>&1
  done &
  echo "  Generated high operations load"
}

spike_memory() {
  echo "Spiking MEMORY_USED..."
  for i in {1..100}; do
    valkey-cli -a devpassword SET "large_key_$i" "$(head -c 1000000 < /dev/zero | tr '\0' 'x')" > /dev/null 2>&1
  done
  echo "  Generated large memory allocations"
}

spike_connections() {
  echo "Spiking CONNECTIONS..."
  for i in {1..50}; do
    (valkey-cli -a devpassword PING > /dev/null 2>&1; sleep 60) &
  done
  echo "  Created many connections (will stay open for 60s)"
}

spike_io() {
  echo "Spiking INPUT/OUTPUT_KBPS..."
  for i in {1..1000}; do
    valkey-cli -a devpassword SET "io_key_$i" "$(head -c 10000 < /dev/zero | tr '\0' 'y')" > /dev/null 2>&1
    valkey-cli -a devpassword GET "io_key_$i" > /dev/null 2>&1
  done &
  echo "  Generated I/O traffic"
}

spike_slowlog() {
  echo "Spiking SLOWLOG_COUNT..."
  for i in {1..20}; do
    valkey-cli -a devpassword KEYS "spike_key_*" > /dev/null 2>&1
    valkey-cli -a devpassword KEYS "large_key_*" > /dev/null 2>&1
    valkey-cli -a devpassword KEYS "io_key_*" > /dev/null 2>&1
  done
  echo "  Generated slow log entries"
}

spike_evictions() {
  echo "Spiking EVICTED_KEYS..."
  valkey-cli -a devpassword CONFIG SET maxmemory 50mb > /dev/null 2>&1
  for i in {1..200}; do
    valkey-cli -a devpassword SET "evict_key_$i" "$(head -c 500000 < /dev/zero | tr '\0' 'z')" > /dev/null 2>&1
  done
  valkey-cli -a devpassword CONFIG SET maxmemory 0 > /dev/null 2>&1
  echo "  Generated key evictions"
}

echo "Select anomaly type to generate:"
echo "  1) OPS_PER_SEC - Many operations"
echo "  2) MEMORY_USED - Large memory allocations"
echo "  3) CONNECTIONS - Many client connections"
echo "  4) INPUT/OUTPUT_KBPS - I/O traffic"
echo "  5) SLOWLOG_COUNT - Slow commands"
echo "  6) EVICTED_KEYS - Memory pressure evictions"
echo "  7) ALL - Generate all types (maximum spike)"
echo ""

read -p "Enter choice (1-7) [default: 7]: " choice
choice=${choice:-7}

case $choice in
  1) spike_ops ;;
  2) spike_memory ;;
  3) spike_connections ;;
  4) spike_io ;;
  5) spike_slowlog ;;
  6) spike_evictions ;;
  7)
    echo "FULL SPIKE MODE - Generating all anomaly types"
    echo ""
    spike_ops
    spike_io
    spike_memory
    spike_connections
    spike_slowlog
    spike_evictions
    ;;
  *) echo "Invalid choice"; exit 1 ;;
esac

echo ""
echo "Anomaly generation complete."
echo "Check your BetterDB Monitor dashboard to see the spikes."
echo "Anomalies should appear within 5-10 seconds."
echo ""
echo "Tip: Run this script multiple times to generate more varied anomalies"
