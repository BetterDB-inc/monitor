# BetterDB Monitor with valkey-operator

Plain manifests for monitoring a [valkey-operator](https://github.com/valkey-io/valkey-operator)
`ValkeyCluster` with [BetterDB Monitor](https://github.com/BetterDB-inc/monitor). Tested with
valkey-operator v0.8.0 (chart 0.8.0), Valkey 9.1.3, betterdb-monitor chart 0.51.1 with
image 0.56.0-no-ai, on kind (Kubernetes v1.37.0).

| file | what it is |
|---|---|
| `valkeycluster.yaml` | `ValkeyCluster` with a read-only `betterdb` ACL user (`spec.users`) |
| `secrets.example.yaml` | the Valkey password for that user, plus BetterDB's secrets (placeholders) |
| `postgres.yaml` | a throwaway Postgres for BetterDB history (`emptyDir`) |
| `betterdb-values.yaml` | Helm values: headless-Service seed, node auto-registration, Postgres storage |

## How it fits together

- **ACL user.** The operator creates `betterdb` on every node from `spec.users`, with the password
  from the `valkey-users` Secret and read-only monitoring permissions.
- **Seed.** BetterDB connects to the operator's headless Service, `valkey-<cluster name>`. It
  resolves to every pod, so BetterDB still reaches the cluster while pods are being replaced.
- **Auto-registration.** `CLUSTER_AUTO_REGISTER_NODES=true` registers every node as its own
  connection and re-syncs the list every 30 s. Pods replaced in a roll come back with new IPs and node
  ids; the sync adds them and retires the old ones (kept, greyed out as "left cluster", with
  their history).
- **Storage.** Postgres keeps history across BetterDB restarts. `ENCRYPTION_KEY` encrypts the node
  credentials it stores for the auto-registered connections.

## Install

Assumes valkey-operator is already installed, e.g.:

```sh
helm install valkey-operator valkey-operator --repo https://valkey.io/valkey-helm/ \
  --version 0.8.0 -n valkey-operator-system --create-namespace
```

```sh
kubectl create namespace valkey
kubectl create namespace betterdb
cp secrets.example.yaml secrets.yaml   # replace every CHANGE_ME
kubectl apply -f secrets.yaml

kubectl -n valkey apply -f valkeycluster.yaml
kubectl -n valkey wait valkeycluster/demo --for=condition=Ready --timeout=10m

kubectl -n betterdb apply -f postgres.yaml
kubectl -n betterdb rollout status statefulset/postgres

helm install betterdb betterdb-monitor --repo https://docs.betterdb.com/charts \
  --version 0.51.1 -n betterdb -f betterdb-values.yaml --wait

kubectl -n betterdb port-forward svc/betterdb-betterdb-monitor 3001:3001
```

Open http://localhost:3001 and register: the first account becomes the workspace owner. Within a
minute, **Connections** should list the seed plus one connection per node (6 for this 3 × 1 cluster).

If your `ValkeyCluster` has another name or namespace, change `db.host` in `betterdb-values.yaml`
to `valkey-<name>.<namespace>.svc.cluster.local`.

## Notes

- **Image tag.** Chart 0.51.1 defaults to the 0.51.1 image. Keep `image.tag` at 0.55.0 or later:
  earlier versions mishandle a seed that resolves to several nodes.
- **License.** Monitoring works without one. Anomaly detection is a Pro feature and needs
  `license-key`; without a key, leave it out of the Secret and drop the `license:` block from the
  values.
- **ACL.** The permission string is the read-only line from `docs/minimum-acl.md` in the BetterDB
  repo. `+commandlog|*` and `+cluster|getslotmigrations` need Valkey 9. With it, the log shows
  `NOPERM` warnings for optional features it leaves out (ACL drift checks, KV-cache footprint);
  the same doc lists the extra grants for each.
- **Slot stats.** `cluster-slot-stats-enabled` is optional; it adds per-slot CPU and traffic. It
  can't be changed at runtime, so changing it rolls the cluster.
- **Telemetry.** The chart sends anonymous usage telemetry by default; set `telemetry: false` to
  turn it off.

To see how we tested this against operator rolls, failovers and faults, see the harness in
[`benchmarks/operator-sim`](../../).
