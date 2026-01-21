#!/bin/bash
# Prepare system for benchmarking (run as root)
set -e

if [ "$EUID" -ne 0 ]; then
    echo "Run as root: sudo $0"
    exit 1
fi

echo "Preparing system..."

# Disable turbo boost
if [ -f /sys/devices/system/cpu/intel_pstate/no_turbo ]; then
    echo 1 > /sys/devices/system/cpu/intel_pstate/no_turbo
    echo "Disabled Intel turbo boost"
elif [ -f /sys/devices/system/cpu/cpufreq/boost ]; then
    echo 0 > /sys/devices/system/cpu/cpufreq/boost
    echo "Disabled AMD boost"
fi

# Set performance governor
GOVERNORS_SET=0
for gov in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
    [ -f "$gov" ] && echo performance > "$gov" 2>/dev/null && ((GOVERNORS_SET++)) || true
done
[ $GOVERNORS_SET -gt 0 ] && echo "Set $GOVERNORS_SET CPUs to performance governor"

# Disable NUMA balancing
[ -f /proc/sys/kernel/numa_balancing ] && echo 0 > /proc/sys/kernel/numa_balancing

# Disable ASLR
[ -f /proc/sys/kernel/randomize_va_space ] && echo 0 > /proc/sys/kernel/randomize_va_space

# Drop caches
sync && echo 3 > /proc/sys/vm/drop_caches
echo "Dropped caches"

echo "Done. Settings reset on reboot."
