#!/usr/bin/env bash
# Build the grafana-dashboards ConfigMap from the shipped dashboard pack.
#
# One demo-only override: the `job` template variable defaults to
# "betterdb-monitor" (the OTLP push path, ~2s fresh) so a visitor lands on a
# populated dashboard instead of the empty "betterdb-scrape" job they haven't
# selected yet. They can still flip the variable to compare pull vs push.
#
# The shipped JSON under deploy/observability/dashboards/ is NOT edited —
# external users import it with a generic default; the override is applied to
# throwaway copies here. Idempotent: safe for first install and pack updates.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/../../../../deploy/observability/dashboards" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for f in "$SRC"/*.json; do
  python3 - "$f" "$TMP/$(basename "$f")" <<'PY'
import json, sys
src, dst = sys.argv[1], sys.argv[2]
d = json.load(open(src))
dash = d["dashboard"] if isinstance(d, dict) and "dashboard" in d else d
for v in dash.get("templating", {}).get("list", []):
    if v.get("name") == "job":
        v["current"] = {"selected": True, "text": "betterdb-monitor", "value": "betterdb-monitor"}
json.dump(d, open(dst, "w"), indent=2)
PY
done

kubectl create configmap grafana-dashboards -n demo-observability \
  --from-file="$TMP" --dry-run=client -o yaml | kubectl apply -f -
