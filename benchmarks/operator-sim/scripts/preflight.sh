#!/usr/bin/env bash
# Host preflight: tool presence + Docker-allocatable capacity → local kind or stop.
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="$PWD/.bin:$HOME/.nvm/versions/node/v22.12.0/bin:$PATH"
MIN_RAM_GB=${MIN_RAM_GB:-48}
MIN_CPUS=${MIN_CPUS:-12}
MIN_KIND=${MIN_KIND:-0.33.0}
fail=0
for t in docker kind kubectl helm node pnpm; do
  if command -v "$t" >/dev/null; then printf '  %-8s %s\n' "$t" "$(command -v "$t")"
  else printf '  %-8s MISSING\n' "$t"; fail=1; fi
done
command -v jq >/dev/null || echo "  jq       missing (optional; harness parses JSON in TS)"
node -v | grep -q '^v22\.' || { echo "  node must be v22 (got $(node -v))"; fail=1; }
kind_v=$(kind version | awk '{print $2}' | tr -d v)
printf '%s\n%s\n' "$MIN_KIND" "$kind_v" | sort -V -C || { echo "  kind $kind_v < $MIN_KIND"; fail=1; }
echo "  kind     $kind_v"
cpus=$(docker info --format '{{.NCPU}}')
ram_gb=$(( $(docker info --format '{{.MemTotal}}') / 1024 / 1024 / 1024 ))
avail_gb=$(awk '/MemAvailable/ {print int($2/1048576)}' /proc/meminfo)
echo "  docker-allocatable: ${cpus} CPU / ${ram_gb} GiB (host MemAvailable now: ${avail_gb} GiB)"
for k in fs.inotify.max_user_watches fs.inotify.max_user_instances; do echo "  $k=$(sysctl -n $k)"; done
[ "$(sysctl -n fs.inotify.max_user_instances)" -ge 512 ] || echo "  WARN: sudo sysctl fs.inotify.max_user_instances=512"
[ "$(sysctl -n fs.inotify.max_user_watches)" -ge 524288 ] || echo "  WARN: sudo sysctl fs.inotify.max_user_watches=524288"
[ "$avail_gb" -ge 16 ] || echo "  WARN: only ${avail_gb} GiB free right now; close heavy apps before 'make up'"
# Docker reports MemTotal slightly under physical RAM; allow 2 GiB slack on the 48 GiB rule.
if [ "$cpus" -ge "$MIN_CPUS" ] && [ "$ram_gb" -ge "$((MIN_RAM_GB - 2))" ]; then
  echo "HOST: local kind OK"
else
  echo "HOST: insufficient (${cpus} CPU/${ram_gb} GiB < ${MIN_CPUS}/${MIN_RAM_GB}) — run on a larger host. STOP."; fail=1
fi
exit $fail
