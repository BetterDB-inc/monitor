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
# The image tag never changes between runs, so on a kept cluster the pod
# template does not either: roll it so the freshly loaded image is the one tested.
kubectl -n "$MONITOR_NAMESPACE" rollout restart deploy/betterdb-monitor >/dev/null
kubectl -n "$MONITOR_NAMESPACE" rollout status deploy/betterdb-monitor --timeout="$TIMEOUT" >/dev/null

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
kubectl -n "$OE_NAMESPACE" rollout restart deploy/betterdb-openeverest >/dev/null
kubectl -n "$OE_NAMESPACE" rollout status deploy/betterdb-openeverest --timeout="$TIMEOUT" >/dev/null

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
# Every agent connection must be read-only, checked record by record.
node -e '
  const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean);
  const agents = lines.map((l) => JSON.parse(l)).filter((c) => c.connectionType === "agent");
  const expected = Number(process.argv[2]);
  if (agents.length < expected) { console.error(`expected ${expected} agent connections, found ${agents.length}`); process.exit(1); }
  const writable = agents.filter((c) => c.readOnly !== true);
  if (writable.length) { console.error("writable agent connections: " + writable.map((c) => c.id).join(", ")); process.exit(1); }
' "$connections_file" "$expected_nodes" || die "agent connections are missing or not all read-only"
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

log "Checking ACL LIST through the CLI redacts password hashes"
acl_list="$(node scripts/e2e/cli-command.mjs "http://localhost:$MONITOR_PORT" "$first_id" ACL LIST)"
printf '%s\n' "$acl_list" | cut -c1-300
printf '%s' "$acl_list" | grep -qE '#[0-9a-f]{64}' && die "ACL LIST leaked a password hash through the CLI"
printf '%s' "$acl_list" | grep -q '#<redacted>' || die "ACL LIST through the CLI shows no redacted hash: $acl_list"

log "Checking the settings cannot be changed through the plugin API"
code="$(plugin settings-put | head -n1)"
[ "$code" = "405" ] || die "PUT /api/settings answered $code, expected 405"

log "Seeding keys and checking a replica serves keyed reads (READONLY)"
# valkey-cli in a throwaway pod with the instance's own connection Secret; -c follows MOVED while writing.
kubectl -n "$DB_NAMESPACE" delete pod seed --ignore-not-found >/dev/null 2>&1 || true
kubectl -n "$DB_NAMESPACE" run seed --rm -i --restart=Never --image=valkey/valkey:9.0 --quiet \
  --overrides="{\"spec\":{\"containers\":[{\"name\":\"seed\",\"image\":\"valkey/valkey:9.0\",\"command\":[\"sh\",\"-c\",\"for i in \$(seq 1 120); do valkey-cli --tls --cacert /conn/ca.crt --cert /conn/tls.crt --key /conn/tls.key -h \$HOST -p 6379 -a \$PASSWORD --no-auth-warning -c SET e2e:key\$i value\$i >/dev/null || exit 1; done; echo seeded\"],\"env\":[{\"name\":\"HOST\",\"valueFrom\":{\"secretKeyRef\":{\"name\":\"$INSTANCE-conn\",\"key\":\"host\"}}},{\"name\":\"PASSWORD\",\"valueFrom\":{\"secretKeyRef\":{\"name\":\"$INSTANCE-conn\",\"key\":\"password\"}}}],\"volumeMounts\":[{\"name\":\"conn\",\"mountPath\":\"/conn\"}]}],\"volumes\":[{\"name\":\"conn\",\"secret\":{\"secretName\":\"$INSTANCE-conn\"}}]}}" \
  | grep -q seeded || die "seeding keys failed"
replica_pod="$(plugin status | tail -n +2 | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const n=JSON.parse(s).status.nodes.find(n=>n.role==="replica");process.stdout.write(n?n.name:"")})')"
[ -n "$replica_pod" ] || die "no replica node in the plugin status"
# Runs key analytics on a node's Monitor connection; dies unless the keyed
# reads (MEMORY USAGE) were served. The CLI parser keeps the content of a
# single-quoted token, so the JSON option survives.
check_keyed_reads() {
  local pod="$1" id
  list_connections
  id="$(grep "\"name\":\"$DB_NAMESPACE/$INSTANCE/$pod\"" "$connections_file" | head -n1 | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(s?JSON.parse(s).id:""))')"
  [ -n "$id" ] || die "no Monitor connection for $pod"
  node scripts/e2e/cli-command.mjs "http://localhost:$MONITOR_PORT" "$id" "COLLECT_KEY_ANALYTICS '{\"sampleSize\":200,\"scanBatchSize\":100}'" | node -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      const reply = JSON.parse(s);
      if (reply.type !== "result") { console.error("key analytics failed: " + JSON.stringify(reply)); process.exit(1); }
      const r = JSON.parse(reply.result);
      const measured = (r.keyDetails || []).filter(k => k.memoryBytes !== null).length;
      console.log(`${process.argv[1]}: scanned ${r.scanned} keys, ${measured} with MEMORY USAGE served`);
      if (r.scanned === 0 || measured === 0) { console.error("keyed reads were not served (MOVED?)"); process.exit(1); }
    })' "$pod" || die "keyed read check failed on $pod"
}
check_keyed_reads "$replica_pod"

node_role() {
  plugin status | tail -n +2 | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const n=JSON.parse(s).status.nodes.find(n=>n.name===process.argv[1]);process.stdout.write(n?n.role:"")})' "$1"
}

log "Failing over $replica_pod and checking the demoted primary serves keyed reads"
# Pods are valkey-<instance>-<shard>-<index>-0: the shard's other pod is its primary.
shard_prefix="${replica_pod%-*-*}"
old_primary="$(kubectl -n "$DB_NAMESPACE" get pods --no-headers -o custom-columns=:metadata.name | grep "^$shard_prefix-" | grep -vx "$replica_pod" | head -n1)"
[ -n "$old_primary" ] || die "no primary pod found next to $replica_pod"
replica_ip="$(kubectl -n "$DB_NAMESPACE" get pod "$replica_pod" -o jsonpath='{.status.podIP}')"
kubectl -n "$DB_NAMESPACE" delete pod failover --ignore-not-found >/dev/null 2>&1 || true
kubectl -n "$DB_NAMESPACE" run failover --rm -i --restart=Never --image=valkey/valkey:9.0 --quiet \
  --overrides="{\"spec\":{\"containers\":[{\"name\":\"failover\",\"image\":\"valkey/valkey:9.0\",\"command\":[\"sh\",\"-c\",\"valkey-cli --tls --insecure --cert /conn/tls.crt --key /conn/tls.key -h $replica_ip -p 6379 -a \$PASSWORD --no-auth-warning CLUSTER FAILOVER\"],\"env\":[{\"name\":\"PASSWORD\",\"valueFrom\":{\"secretKeyRef\":{\"name\":\"$INSTANCE-conn\",\"key\":\"password\"}}}],\"volumeMounts\":[{\"name\":\"conn\",\"mountPath\":\"/conn\"}]}],\"volumes\":[{\"name\":\"conn\",\"secret\":{\"secretName\":\"$INSTANCE-conn\"}}]}}" \
  | grep -q OK || die "CLUSTER FAILOVER on $replica_pod failed"
# Rediscovery picks the new roles up on its next interval.
for _ in $(seq 1 48); do
  [ "$(node_role "$replica_pod")" = "primary" ] && [ "$(node_role "$old_primary")" = "replica" ] && break
  sleep 5
done
[ "$(node_role "$old_primary")" = "replica" ] || die "the plugin never saw $old_primary demoted"
for _ in $(seq 1 24); do
  plugin status | tail -n +2 | grep -q '"state":"monitoring"' && break
  sleep 5
done
wait_for_agents "$expected_nodes"
check_keyed_reads "$old_primary"

log "Checking the NetworkPolicy's from-selector matches a running everest-server pod"
selector="$(kubectl -n "$OE_NAMESPACE" get networkpolicy betterdb-openeverest -o json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=JSON.parse(s).spec.ingress[0].from[0].podSelector.matchLabels;process.stdout.write(Object.entries(m).map(([k,v])=>k+"="+v).join(","))})')"
matched="$(kubectl -n "$OE_NAMESPACE" get pods -l "$selector" --field-selector=status.phase=Running --no-headers | wc -l)"
echo "selector $selector matches $matched running pod(s)"
[ "$matched" -ge 1 ] || die "the NetworkPolicy selector matches no everest-server pod"

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
targets_data="$(kubectl -n "$OE_NAMESPACE" get configmap betterdb-openeverest-targets -o jsonpath='{.data}')" || die "could not read the targets ConfigMap"
case "$targets_data" in *"$INSTANCE"*) die "the ConfigMap still lists $INSTANCE" ;; esac

log "PASS: $expected_nodes nodes of $DB_NAMESPACE/$INSTANCE streamed read-only and were removed on disable"
if [ -z "${KEEP:-}" ]; then teardown; fi
