#!/usr/bin/env bash
# Standalone repro (kubectl + valkey-cli only, no harness, no load, no monitoring):
# after an operator image roll, part of the cluster keeps listing a demoted primary as a
# slotless `master` while that node reports itself as a replica.
#
#   CONTEXT=kind-bz-sim NS=valkey CLUSTER=bz IMAGES="valkey/valkey:9.1.3 valkey/valkey:9.1.2" \
#   ROUNDS=2 OBSERVE_SEC=300 ./scripts/repro-ghost-master.sh | tee ghost.log
#
# Each round patches spec.image to the next image in IMAGES, waits for the ValkeyCluster to
# report Ready, then samples every pod's CLUSTER NODES every INTERVAL_SEC for OBSERVE_SEC.
set -euo pipefail
CONTEXT=${CONTEXT:-kind-bz-sim} NS=${NS:-valkey} CLUSTER=${CLUSTER:-bz}
IMAGES=(${IMAGES:-valkey/valkey:9.1.3 valkey/valkey:9.1.2})
ROUNDS=${ROUNDS:-2} OBSERVE_SEC=${OBSERVE_SEC:-300} INTERVAL_SEC=${INTERVAL_SEC:-10} READY_TIMEOUT=${READY_TIMEOUT:-1800}
k() { kubectl --context "$CONTEXT" -n "$NS" "$@"; }
cli() { k exec "$1" -c server -- env -u VALKEYCLI_AUTH valkey-cli "${@:2}" 2>/dev/null; }
ts() { date -u +%FT%TZ; }

wait_ready() {
  local deadline=$((SECONDS + READY_TIMEOUT))
  sleep 15  # let the operator observe the patch before trusting Ready
  until [ "$(k get valkeycluster "$CLUSTER" -o jsonpath='{.status.state}')" = Ready ]; do
    [ $SECONDS -lt $deadline ] || { echo "$(ts) ERROR: not Ready after ${READY_TIMEOUT}s"; exit 1; }
    sleep 5
  done
}

observe() {
  local end=$((SECONDS + OBSERVE_SEC)) ghosts=0
  while [ $SECONDS -lt $end ]; do
    declare -A seen=() self=()
    pods=$(k get pods -l "valkey.io/cluster=$CLUSTER" -o jsonpath='{range .items[*]}{.metadata.name}={.status.podIP}{" "}{end}')
    for pp in $pods; do
      p=${pp%%=*}
      # master entries with no slot ranges (field 9 empty), not flagged fail
      while read -r id addr flags _; do
        [ -n "$id" ] && seen["$id ${addr%%:*}"]+="$p "
      done < <(cli "$p" cluster nodes | awk '$3 ~ /master/ && $3 !~ /fail/ && $9 == "" {print $1, $2, $3}')
    done
    for key in "${!seen[@]}"; do
      ip=${key#* }; owner=""
      for pp in $pods; do [ "${pp#*=}" = "$ip" ] && owner=${pp%%=*}; done
      own_role=$([ -n "$owner" ] && cli "$owner" role | head -1 || echo "no-pod-at-ip")
      viewers=$(echo ${seen[$key]} | wc -w)
      echo "$(ts) slotless-master id=${key% *} ip=$ip pod=${owner:-none} self-role=$own_role listed-by=$viewers/$(echo $pods | wc -w)"
      ghosts=$((ghosts + 1))
    done
    unset seen self
    sleep "$INTERVAL_SEC"
  done
  echo "$(ts) round summary: $ghosts slotless-master observations"
}

echo "$(ts) start: context=$CONTEXT cluster=$NS/$CLUSTER operator=$(kubectl --context "$CONTEXT" get deploy -A -l app.kubernetes.io/name=valkey-operator -o jsonpath='{.items[0].spec.template.spec.containers[0].image}' 2>/dev/null)"
wait_ready
echo "$(ts) baseline check (no roll yet)"; OBSERVE_SEC=$INTERVAL_SEC observe
for ((r = 0; r < ROUNDS; r++)); do
  img=${IMAGES[$((r % ${#IMAGES[@]}))]}
  echo "$(ts) round $((r + 1)): patch spec.image=$img"
  k patch valkeycluster "$CLUSTER" --type merge -p "{\"spec\":{\"image\":\"$img\"}}" >/dev/null
  wait_ready
  echo "$(ts) round $((r + 1)): Ready; observing ${OBSERVE_SEC}s"
  observe
done
