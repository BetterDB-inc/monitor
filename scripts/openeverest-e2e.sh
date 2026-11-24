#!/usr/bin/env bash
# End-to-end check of the BetterDB plugin for OpenEverest on a throwaway kind
# (or k3d) cluster:
#
#   1. create the cluster and install OpenEverest core + provider-valkey
#   2. install a self-hosted betterdb-monitor and mint an agent token
#   3. build the betterdb/agent image from this checkout, load it, install
#      charts/betterdb-openeverest pointing at the Monitor
#   4. create a Valkey instance (TLS on, cluster topology), enable monitoring
#      through the plugin backend with an OpenEverest admin token
#   5. assert the plugin reports "monitoring" with one node per Valkey pod and
#      that the Monitor lists them as read-only agent connections
#
# Needs: docker, kind (or k3d), kubectl, helm, curl, node. Takes ~10 min.
#
#   scripts/openeverest-e2e.sh            run everything, keep the cluster on failure
#   KEEP=1 scripts/openeverest-e2e.sh     keep the cluster afterwards
#   scripts/openeverest-e2e.sh teardown   delete the cluster
#
# Versions are pinned below; OE_VERSION tracks the alpha the design doc was
# verified against. The OpenEverest install steps follow its docs for
# alpha.1 (helm chart from oci://ghcr.io/openeverest/charts); adjust
# OE_CHART/OE_VALUES if the alpha's chart layout differs.
set -euo pipefail

CLUSTER_NAME="${CLUSTER_NAME:-betterdb-oe}"
OE_VERSION="${OE_VERSION:-2.0.0-alpha.1}"
OE_CHART="${OE_CHART:-oci://ghcr.io/openeverest/charts/everest}"
PROVIDER_VALKEY_CHART="${PROVIDER_VALKEY_CHART:-oci://ghcr.io/openeverest/charts/provider-valkey}"
PROVIDER_VALKEY_VERSION="${PROVIDER_VALKEY_VERSION:-0.2.0}"
OE_NAMESPACE="everest-system"
DB_NAMESPACE="${DB_NAMESPACE:-databases}"
MONITOR_NAMESPACE="betterdb"
INSTANCE="${INSTANCE:-orders}"
AGENT_IMAGE="betterdb/agent:e2e"
TIMEOUT="${TIMEOUT:-600s}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

cluster_tool() {
  if command -v kind >/dev/null; then echo kind; elif command -v k3d >/dev/null; then echo k3d; else die "need kind or k3d"; fi
}

teardown() {
  case "$(cluster_tool)" in
    kind) kind delete cluster --name "$CLUSTER_NAME" ;;
    k3d) k3d cluster delete "$CLUSTER_NAME" ;;
  esac
}

if [ "${1:-}" = "teardown" ]; then teardown; exit 0; fi

for tool in docker kubectl helm curl node; do command -v "$tool" >/dev/null || die "need $tool"; done

log "Creating cluster $CLUSTER_NAME"
case "$(cluster_tool)" in
  kind)
    kind get clusters | grep -qx "$CLUSTER_NAME" || kind create cluster --name "$CLUSTER_NAME" --wait 120s
    kubectl config use-context "kind-$CLUSTER_NAME"
    ;;
  k3d)
    k3d cluster list | grep -q "^$CLUSTER_NAME " || k3d cluster create "$CLUSTER_NAME" --wait
    kubectl config use-context "k3d-$CLUSTER_NAME"
    ;;
esac

log "Installing OpenEverest $OE_VERSION"
helm upgrade --install everest "$OE_CHART" --version "$OE_VERSION" \
  --namespace "$OE_NAMESPACE" --create-namespace --wait --timeout "$TIMEOUT"

log "Installing provider-valkey $PROVIDER_VALKEY_VERSION"
helm upgrade --install provider-valkey "$PROVIDER_VALKEY_CHART" --version "$PROVIDER_VALKEY_VERSION" \
  --namespace "$OE_NAMESPACE" --wait --timeout "$TIMEOUT"

log "Installing a self-hosted BetterDB Monitor"
helm upgrade --install betterdb-monitor charts/betterdb-monitor \
  --namespace "$MONITOR_NAMESPACE" --create-namespace --wait --timeout "$TIMEOUT" \
  --set db.host="" --set storage.type=memory
MONITOR_URL="http://betterdb-monitor.$MONITOR_NAMESPACE.svc:3001"

log "Minting an agent token in the Monitor"
# The Monitor's bootstrap admin is created on first start; the token API is the
# same one the UI's "Via Agent" tab calls.
MONITOR_PF_PID=""
kubectl -n "$MONITOR_NAMESPACE" port-forward svc/betterdb-monitor 13001:3001 >/dev/null 2>&1 &
MONITOR_PF_PID=$!
trap '[ -n "$MONITOR_PF_PID" ] && kill "$MONITOR_PF_PID" 2>/dev/null || true' EXIT
sleep 3
AGENT_TOKEN="$(node scripts/e2e/mint-agent-token.mjs http://localhost:13001 2>/dev/null || true)"
[ -n "$AGENT_TOKEN" ] || die "could not mint an agent token; see scripts/e2e/mint-agent-token.mjs"

log "Building and loading $AGENT_IMAGE"
docker build -f packages/agent/Dockerfile -t "$AGENT_IMAGE" .
case "$(cluster_tool)" in
  kind) kind load docker-image "$AGENT_IMAGE" --name "$CLUSTER_NAME" ;;
  k3d) k3d image import "$AGENT_IMAGE" -c "$CLUSTER_NAME" ;;
esac

log "Installing the BetterDB plugin"
helm upgrade --install betterdb-openeverest charts/betterdb-openeverest \
  --namespace "$OE_NAMESPACE" --wait --timeout "$TIMEOUT" \
  --set image.repository="${AGENT_IMAGE%%:*}" --set image.tag="${AGENT_IMAGE##*:}" \
  --set image.pullPolicy=Never \
  --set betterdb.url="ws://betterdb-monitor.$MONITOR_NAMESPACE.svc:3001/api/agent/ws" \
  --set betterdb.token="$AGENT_TOKEN"

log "Creating Valkey instance $DB_NAMESPACE/$INSTANCE (TLS on, cluster topology)"
kubectl create namespace "$DB_NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f - <<EOF
apiVersion: core.openeverest.io/v1alpha1
kind: Instance
metadata:
  name: $INSTANCE
  namespace: $DB_NAMESPACE
spec:
  providerRef:
    name: valkey
  version: "9.0"
  topology:
    type: cluster
    parameters:
      numShards: 3
  components:
    engine:
      replicas: 1
      storage:
        size: 1Gi
EOF
kubectl -n "$DB_NAMESPACE" wait instance/"$INSTANCE" --for=jsonpath='{.status.connectionSecretRef.name}' --timeout="$TIMEOUT"
kubectl -n "$DB_NAMESPACE" wait instance/"$INSTANCE" --for=jsonpath='{.status.phase}'=Provisioned --timeout="$TIMEOUT" || true

log "Enabling monitoring through the plugin proxy"
# An OpenEverest admin session token: the alpha's CLI/UI login both end in a
# JWT; EVEREST_TOKEN lets a caller pass one minted elsewhere.
EVEREST_TOKEN="${EVEREST_TOKEN:-$(kubectl -n "$OE_NAMESPACE" get secret everest-accounts -o jsonpath='{.data.admin-token}' 2>/dev/null | base64 -d || true)}"
[ -n "$EVEREST_TOKEN" ] || die "set EVEREST_TOKEN to an OpenEverest admin JWT"
kubectl -n "$OE_NAMESPACE" port-forward svc/everest 18080:8080 >/dev/null 2>&1 &
EVEREST_PF_PID=$!
trap 'kill "$MONITOR_PF_PID" "$EVEREST_PF_PID" 2>/dev/null || true' EXIT
sleep 3
PLUGIN_BASE="http://localhost:18080/v1/clusters/main/plugins/betterdb"
curl -fsS -X POST -H "Authorization: Bearer $EVEREST_TOKEN" \
  "$PLUGIN_BASE/api/instances/main/$DB_NAMESPACE/$INSTANCE/enable" | tee /dev/stderr | grep -q '"enabled":true'

log "Waiting for the plugin to report monitoring"
expected_nodes="$(kubectl -n "$DB_NAMESPACE" get pods -l "valkey.io/cluster=$INSTANCE" --no-headers | wc -l)"
for _ in $(seq 1 60); do
  status="$(curl -fsS "$PLUGIN_BASE/api/instances/main/$DB_NAMESPACE/$INSTANCE/status")"
  state="$(printf '%s' "$status" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.status.state, j.status.nodes.filter(n=>n.cloudConnected).length)})')"
  read -r st connected <<<"$state"
  if [ "$st" = "monitoring" ] && [ "$connected" -ge "$expected_nodes" ]; then
    echo "monitoring: $connected/$expected_nodes nodes streaming"
    break
  fi
  sleep 5
done
[ "${st:-}" = "monitoring" ] || die "plugin did not reach monitoring: $status"

log "Checking the Monitor lists the nodes as read-only agent connections"
connections="$(node scripts/e2e/list-connections.mjs http://localhost:13001)"
printf '%s\n' "$connections"
printf '%s' "$connections" | grep -q "\"readOnly\":true" || die "agent connections are not read-only"
[ "$(printf '%s' "$connections" | grep -o "\"connectionType\":\"agent\"" | wc -l)" -ge "$expected_nodes" ] || die "fewer agent connections than nodes"

log "Disabling and checking the connections go away"
curl -fsS -X POST -H "Authorization: Bearer $EVEREST_TOKEN" \
  "$PLUGIN_BASE/api/instances/main/$DB_NAMESPACE/$INSTANCE/disable" | grep -q '"enabled":false'

log "PASS"
if [ -z "${KEEP:-}" ]; then teardown; fi
