#!/usr/bin/env bash
# End-to-end check of the BetterDB plugin for OpenEverest on a throwaway kind
# cluster:
#
#   1. create the cluster (Kubernetes >= 1.32, three workers) and install
#      OpenEverest core 2.0.0-alpha.1 + provider-valkey 0.2.0 the way the
#      OpenEverest docs do
#   2. build the Monitor and agent images from this checkout, load them, and
#      install a self-hosted betterdb-monitor; mint an agent token
#   3. install charts/betterdb-openeverest pointing at the Monitor
#   4. create a Valkey instance (TLS on, cluster topology), enable monitoring
#      through the plugin proxy with an OpenEverest admin session
#   5. assert the plugin reports "monitoring" with every Valkey pod streaming,
#      that the Monitor lists them as read-only agent connections, that a
#      mutation is refused, and that disabling removes them
#
# Needs: docker, kind, kubectl, helm, curl, node. ~15 min on a laptop; the
# cluster takes about 8 GB.
#
#   scripts/openeverest-e2e.sh            run everything; the cluster is kept on failure
#   KEEP=1 scripts/openeverest-e2e.sh     keep the cluster afterwards
#   SKIP_BUILD=1 ...                      reuse betterdb/monitor:e2e and betterdb/agent:e2e
#   scripts/openeverest-e2e.sh teardown   delete the cluster
#
# Verified against the OpenEverest docs (quick-install.md) and the clones:
# core chart openeverest/openeverest (needs --version, kubeVersion >= 1.32),
# provider chart oci://ghcr.io/openeverest/charts/provider-valkey 0.2.0
# (Provider named "valkey"), login POST /v1/auth/token (grant_type=password,
# JWT in access_token; see scripts/e2e/plugin-action.mjs), API Service
# `everest`:8080, single cluster "main".
set -euo pipefail

CLUSTER_NAME="${CLUSTER_NAME:-betterdb-oe}"
KIND_NODE_IMAGE="${KIND_NODE_IMAGE:-kindest/node:v1.32.0}"
OE_VERSION="${OE_VERSION:-2.0.0-alpha.1}"
OE_REPO="${OE_REPO:-https://openeverest.github.io/helm-charts/}"
PROVIDER_VALKEY_CHART="${PROVIDER_VALKEY_CHART:-oci://ghcr.io/openeverest/charts/provider-valkey}"
PROVIDER_VALKEY_VERSION="${PROVIDER_VALKEY_VERSION:-0.2.0}"
OE_NAMESPACE="everest-system"
OE_ADMIN_PASSWORD="${OE_ADMIN_PASSWORD:-e2e-admin-password}"
DB_NAMESPACE="${DB_NAMESPACE:-databases}"
MONITOR_NAMESPACE="betterdb"
INSTANCE="${INSTANCE:-orders}"
NUM_SHARDS="${NUM_SHARDS:-3}"
REPLICAS_PER_SHARD="${REPLICAS_PER_SHARD:-1}"
MONITOR_IMAGE="betterdb/monitor:e2e"
AGENT_IMAGE="betterdb/agent:e2e"
TIMEOUT="${TIMEOUT:-900s}"
MONITOR_PORT="${MONITOR_PORT:-13001}"
EVEREST_PORT="${EVEREST_PORT:-18080}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

teardown() { kind delete cluster --name "$CLUSTER_NAME"; }

if [ "${1:-}" = "teardown" ]; then teardown; exit 0; fi

for tool in docker kind kubectl helm curl node; do command -v "$tool" >/dev/null || die "need $tool"; done

pids=()
cleanup() { for pid in "${pids[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done; }
trap cleanup EXIT

# kubectl port-forward in the background, waiting until the local port answers.
forward() {
  local ns="$1" svc="$2" local_port="$3" remote_port="$4"
  kubectl -n "$ns" port-forward "svc/$svc" "$local_port:$remote_port" >/dev/null 2>&1 &
  pids+=($!)
  for _ in $(seq 1 30); do
    if curl -s -o /dev/null "http://localhost:$local_port/"; then return 0; fi
    sleep 1
  done
  die "port-forward to $ns/$svc did not come up"
}

log "Creating kind cluster $CLUSTER_NAME ($KIND_NODE_IMAGE)"
if ! kind get clusters 2>/dev/null | grep -qx "$CLUSTER_NAME"; then
  kind create cluster --name "$CLUSTER_NAME" --image "$KIND_NODE_IMAGE" \
    --config scripts/e2e/kind-config.yaml --wait 180s
fi
kubectl config use-context "kind-$CLUSTER_NAME" >/dev/null

log "Installing OpenEverest $OE_VERSION"
helm repo add openeverest "$OE_REPO" >/dev/null 2>&1 || true
helm repo update openeverest >/dev/null
# Plain install, skipped on a rerun: the core chart's pre-upgrade hook runs
# preflight checks that fail on a same-version `helm upgrade`.
installed() { helm status "$1" --namespace "$OE_NAMESPACE" >/dev/null 2>&1; }
if installed everest-core; then
  echo "everest-core already installed"
else
  helm install everest-core openeverest/openeverest --version "$OE_VERSION" \
    --namespace "$OE_NAMESPACE" --create-namespace --wait --timeout "$TIMEOUT" \
    --set server.initialAdminPassword="$OE_ADMIN_PASSWORD" --set telemetry=false
fi

log "Installing provider-valkey $PROVIDER_VALKEY_VERSION"
if installed provider-valkey; then
  echo "provider-valkey already installed"
else
  helm install provider-valkey "$PROVIDER_VALKEY_CHART" --version "$PROVIDER_VALKEY_VERSION" \
    --namespace "$OE_NAMESPACE" --wait --timeout "$TIMEOUT"
fi
kubectl get providers.core.openeverest.io valkey >/dev/null

if [ -z "${SKIP_BUILD:-}" ]; then
  log "Building $MONITOR_IMAGE and $AGENT_IMAGE from this checkout"
  # The Monitor must carry this branch's gateway (identity-derived ids,
  # read-only), so the published image will not do.
  docker build --build-arg APP_VERSION="$(node -p 'require("./package.json").version')" \
    --target production-no-ai -t "$MONITOR_IMAGE" .
  docker build -f packages/agent/Dockerfile -t "$AGENT_IMAGE" .
fi
log "Loading images into kind"
kind load docker-image "$MONITOR_IMAGE" --name "$CLUSTER_NAME"
kind load docker-image "$AGENT_IMAGE" --name "$CLUSTER_NAME"

log "Installing a self-hosted BetterDB Monitor"
helm upgrade --install betterdb-monitor charts/betterdb-monitor \
  --namespace "$MONITOR_NAMESPACE" --create-namespace --wait --timeout "$TIMEOUT" \
  --set image.repository="${MONITOR_IMAGE%%:*}" --set image.tag="${MONITOR_IMAGE##*:}" \
  --set image.pullPolicy=Never --set storage.type=memory

log "Minting an agent token in the Monitor"
forward "$MONITOR_NAMESPACE" betterdb-monitor "$MONITOR_PORT" 3001
AGENT_TOKEN="$(node scripts/e2e/mint-agent-token.mjs "http://localhost:$MONITOR_PORT")"
[ -n "$AGENT_TOKEN" ] || die "could not mint an agent token"

log "Installing the BetterDB plugin"
helm upgrade --install betterdb-openeverest charts/betterdb-openeverest \
  --namespace "$OE_NAMESPACE" --wait --timeout "$TIMEOUT" \
  --set image.repository="${AGENT_IMAGE%%:*}" --set image.tag="${AGENT_IMAGE##*:}" \
  --set image.pullPolicy=Never \
  --set betterdb.url="ws://betterdb-monitor.$MONITOR_NAMESPACE.svc:3001/api/agent/ws" \
  --set betterdb.token="$AGENT_TOKEN"

log "Creating Valkey instance $DB_NAMESPACE/$INSTANCE (TLS on, cluster, $NUM_SHARDS shards x $((REPLICAS_PER_SHARD + 1)))"
kubectl create namespace "$DB_NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
# Shape from provider-valkey/examples/instance-cluster.yaml; TLS is on by default.
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
      numShards: $NUM_SHARDS
  components:
    engine:
      type: valkey
      replicas: $REPLICAS_PER_SHARD
      resources:
        requests: {cpu: 100m, memory: 128Mi}
        limits: {memory: 512Mi}
      storage:
        size: 1Gi
EOF
expected_nodes=$((NUM_SHARDS * (REPLICAS_PER_SHARD + 1)))
log "Waiting for $expected_nodes Valkey pods and the connection Secret"
kubectl -n "$DB_NAMESPACE" wait instance/"$INSTANCE" --for=jsonpath='{.status.connectionSecretRef.name}' --timeout="$TIMEOUT"
for _ in $(seq 1 120); do
  ready="$(kubectl -n "$DB_NAMESPACE" get pods -l "valkey.io/cluster=$INSTANCE" -o jsonpath='{range .items[*]}{.status.containerStatuses[0].ready}{"\n"}{end}' 2>/dev/null | grep -c true || true)"
  [ "$ready" -ge "$expected_nodes" ] && break
  sleep 5
done
[ "$ready" -ge "$expected_nodes" ] || die "only $ready/$expected_nodes Valkey pods are ready"
kubectl -n "$DB_NAMESPACE" get pods -l "valkey.io/cluster=$INSTANCE" -o wide

log "Reaching the plugin through OpenEverest's proxy"
forward "$OE_NAMESPACE" everest "$EVEREST_PORT" 8080
EVEREST="http://localhost:$EVEREST_PORT"
# The proxy path OpenEverest's UI uses; the cluster is always "main" in alpha.1.
PLUGIN_BASE="$EVEREST/v1/clusters/main/plugins/betterdb"
curl -fsS "$PLUGIN_BASE/healthz" >/dev/null || die "plugin backend not reachable through the proxy"
plugin() { node scripts/e2e/plugin-action.mjs "$EVEREST" "$OE_ADMIN_PASSWORD" "$DB_NAMESPACE" "$INSTANCE" "$@"; }

log "Enabling monitoring through the plugin proxy"
# A forged session must be turned away (by the proxy's JWT check) before anything is stored.
code="$(plugin on --forged | head -n1)"
[ "$code" = "401" ] || die "a forged token was not refused (HTTP $code)"
enabled="$(plugin on)"
printf '%s\n' "$enabled"
printf '%s' "$enabled" | grep -q '"enabled":true' || die "enable failed"

log "Waiting for the plugin to report monitoring with $expected_nodes nodes streaming"
status=""
for _ in $(seq 1 60); do
  status="$(plugin status | tail -n +2)"
  read -r st connected <<<"$(printf '%s' "$status" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.status.state, j.status.nodes.filter(n=>n.cloudConnected&&n.valkeyConnected).length)})')"
  if [ "$st" = "monitoring" ] && [ "$connected" -ge "$expected_nodes" ]; then break; fi
  sleep 5
done
printf '%s\n' "$status"
[ "${st:-}" = "monitoring" ] && [ "${connected:-0}" -ge "$expected_nodes" ] || die "plugin did not reach monitoring with all nodes"

log "Checking the Monitor lists $expected_nodes read-only agent connections"
connections_file="$(mktemp)"
# Dies when the listing itself fails, so an API error never reads as "no connections".
list_connections() {
  node scripts/e2e/list-connections.mjs "http://localhost:$MONITOR_PORT" > "$connections_file" || die "listing the Monitor's connections failed"
}
count_in() { grep -c -- "$1" "$connections_file" || true; }
list_connections
cat "$connections_file"
agent_count="$(count_in '"connectionType":"agent"')"
readonly_count="$(count_in '"readOnly":true')"
[ "$agent_count" -ge "$expected_nodes" ] || die "expected $expected_nodes agent connections, found $agent_count"
[ "$readonly_count" -ge "$expected_nodes" ] || die "expected every agent connection read-only, found $readonly_count"
grep -q '"host":"agent"' "$connections_file" || die "agent connections missing"

log "Checking a mutation is refused and a read works on an agent connection"
first_id="$(grep '"connectionType":"agent"' "$connections_file" | head -n1 | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).id))')"
node scripts/e2e/check-read-only.mjs "http://localhost:$MONITOR_PORT" "$first_id"

wait_for_agents() {
  local want="$1" remaining=""
  for _ in $(seq 1 36); do
    list_connections
    remaining="$(count_in '"connectionType":"agent"')"
    [ "$remaining" = "$want" ] && return 0
    sleep 5
  done
  die "expected $want agent connections, still $remaining"
}

log "Restarting the plugin pod and checking the opt-in survives, then disabling"
kubectl -n "$OE_NAMESPACE" rollout restart deploy/betterdb-openeverest >/dev/null
kubectl -n "$OE_NAMESPACE" rollout status deploy/betterdb-openeverest --timeout=180s >/dev/null
for _ in $(seq 1 30); do
  st="$(plugin status | tail -n +2 | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).enabled+" "+JSON.parse(s).status.state))' 2>/dev/null || echo "")"
  [ "$st" = "true monitoring" ] && break
  sleep 5
done
[ "${st:-}" = "true monitoring" ] || die "after a restart the plugin reports: ${st:-nothing}"
wait_for_agents "$expected_nodes"
plugin off | grep -q '"enabled":false' || die "disable after restart failed"
wait_for_agents 0

log "Enabling again, deleting the Instance and checking the opt-in goes with it"
plugin on | grep -q '"enabled":true' || die "re-enable failed"
wait_for_agents "$expected_nodes"
kubectl -n "$DB_NAMESPACE" delete instance "$INSTANCE" --wait=false >/dev/null
for _ in $(seq 1 36); do
  enabled="$(plugin status | tail -n +2 | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).enabled))' 2>/dev/null || echo "")"
  [ "$enabled" = "false" ] && break
  sleep 5
done
[ "${enabled:-}" = "false" ] || die "the opt-in outlived the Instance"
wait_for_agents 0
kubectl -n "$OE_NAMESPACE" get configmap betterdb-openeverest-targets -o jsonpath='{.data}' | grep -q "$INSTANCE" && die "the ConfigMap still lists $INSTANCE"

log "PASS: $expected_nodes nodes of $DB_NAMESPACE/$INSTANCE streamed read-only and were removed on disable"
if [ -z "${KEEP:-}" ]; then teardown; fi
