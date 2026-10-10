#!/usr/bin/env bash
# Build the grafana-dashboards ConfigMap from the shipped dashboard pack.
#
# Demo-only override: the `job` template variable is defaulted so a visitor
# lands on a populated dashboard. Most dashboards default to "betterdb-monitor"
# (the OTLP push path, ~2s fresh). The Monitor-Internals dashboard defaults to
# "betterdb-scrape" instead, because its GC/poll histograms exist only on the
# pull path (OTLP mirror mode skips histograms), so they would be empty under
# the push job.
#
# The shipped JSON under deploy/observability/dashboards/ is NOT edited — the
# override is applied to throwaway copies here. Idempotent; safe for first
# install and pack updates.
set -euo pipefail
shopt -s nullglob

SRC="$(cd "$(dirname "$0")/../../../../deploy/observability/dashboards" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

files=("$SRC"/*.json)
if [ ${#files[@]} -eq 0 ]; then
  echo "error: no dashboards found under $SRC" >&2
  exit 1
fi

# One python pass over every dashboard: set the job default, skip (warn on) any
# file that fails to parse instead of aborting the whole build.
python3 - "$TMP" "${files[@]}" <<'PY'
import json, os, sys
tmp, paths = sys.argv[1], sys.argv[2:]
for src in paths:
    name = os.path.basename(src)
    try:
        d = json.load(open(src))
    except Exception as e:
        print(f"  skip {name}: {e}", file=sys.stderr)
        continue
    job = "betterdb-scrape" if d.get("uid") == "betterdb-monitor-internals" else "betterdb-monitor"
    for v in d.get("templating", {}).get("list", []):
        if v.get("name") == "job":
            v["current"] = {"selected": True, "text": job, "value": job}
    json.dump(d, open(os.path.join(tmp, name), "w"), indent=2, ensure_ascii=False)
PY

built=("$TMP"/*.json)
if [ ${#built[@]} -eq 0 ]; then
  echo "error: no dashboards built (all failed to parse)" >&2
  exit 1
fi

kubectl create configmap grafana-dashboards -n demo-observability \
  --from-file="$TMP" --dry-run=client -o yaml | kubectl apply -f -
