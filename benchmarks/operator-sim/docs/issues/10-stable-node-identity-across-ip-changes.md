# Keep one identity per cluster node when its IP address changes

**Suggested labels:** `enhancement`, `cluster`, `kubernetes`, `auto-registration`, `web`  ·  **Area:** `apps/api/src/topology`, `apps/api/src/connections`, `apps/web/src/hooks`  ·  **Severity:** medium (no data is lost, but on Kubernetes every pod replacement splits a node's history across connection ids and breaks saved links to it)

> **Testing:** the harness used to find and reproduce this is on branch [`bench/operator-sim`](https://github.com/BetterDB-inc/monitor/tree/bench/operator-sim/benchmarks/operator-sim) (`benchmarks/operator-sim/`; start with its README). Raw run data (`runs/<id>/*.jsonl`) is not committed; re-run the commands in the test plan to regenerate it.

## Summary

With cluster auto-registration on (`CLUSTER_AUTO_REGISTER_NODES=true`), BetterDB creates one child connection per node it finds in `CLUSTER NODES`. It matches those children to nodes by announced `ip:port` only. On Kubernetes a pod gets a new IP each time it is replaced (rolling update, eviction, pod delete), so the old child is retired and a new child is registered under a new random UUID. All of the node's earlier anomaly events, slow-log entries and snapshots stay on the retired id, and the anomaly detectors for the new child start from an empty baseline. A link such as `/anomalies?connection=<retired id>` drops to the default connection without saying so. This issue proposes matching children by a stable key first (Valkey node id, then announced hostname, with the address as the fallback), recording a successor link when a node really is replaced, and making the web UI handle retired ids explicitly.

## How we found it

The `benchmarks/operator-sim` harness in this repo found this. It runs a Valkey cluster managed by the Kubernetes operator under synthetic load, injects faults, and compares what BetterDB reports with an independent per-node sampler.

- kind v0.33.0, Kubernetes v1.37.0, 1 control plane plus 6 workers.
- valkey-operator v0.8.0. `ValkeyCluster` `bz` has 12 shards, each with 1 primary and 2 replicas (36 pods). It uses `workloadType: StatefulSet` and **no persistence** (`/data` is an `emptyDir`, so `nodes.conf` does not survive a pod replacement). Valkey 9.1.2 is rolled to 9.1.3. The manifest is in `benchmarks/operator-sim/infra/valkey/valkeycluster.yaml.tmpl`.
- BetterDB Monitor v0.55.0 (from Helm chart 0.51.1 with the image tag overridden), `STORAGE_TYPE=postgres`, `CLUSTER_AUTO_REGISTER_NODES=true`, and `ENCRYPTION_KEY` set so that child connections are persisted. The seed connection is the operator's headless Service `valkey-bz.valkey.svc.cluster.local:6379`.
- Scenario phases that replace pods: `primaryKill` (graceful delete of one primary pod) and `rollingUpdate` (image roll of all 36 pods).
- Runs (under `benchmarks/operator-sim/runs/`, JSONL):
  - `2026-11-11T14-01-50-665-s42`: full run.
  - `2026-11-10T19-54-07-874-s42`: previous full run.
  - `2026-11-10T19-26-16-778-s42`: rollingUpdate-only control.
  - `betterdb.jsonl` holds every BetterDB anomaly event with the child `connectionId` and the pod the harness attributed it to. `groundtruth.jsonl` holds `CLUSTER SHARDS` every 5 s, with node ids and IPs.

## Observed behaviour

**Node identity in the test cluster (ground truth, `CLUSTER SHARDS`):**

| Run | Pods | Distinct Valkey node ids seen | Node ids with more than 1 IP | IPs reused by another node id |
|---|---|---|---|---|
| full, `2026-11-11T14-01-50-665-s42` | 36 | 73 | 0 | 0 |
| full, `2026-11-10T19-54-07-874-s42` | 36 | 73 | 0 | 0 |
| roll-only, `2026-11-10T19-26-16-778-s42` | 36 | 72 | 0 | 0 |

73 = 36 initial pods + 1 pod replaced by `primaryKill` + 36 replaced by `rollingUpdate`. **With no persistence, each pod replacement produced a new IP and a new Valkey node id.** The only identifiers that stayed stable were the pod name, which Valkey does not report here (no hostname is announced; `CLUSTER SHARDS` has no `hostname` field), and the shard id. All 12 shard ids from `CLUSTER SHARDS` lasted the whole run and kept the same slot ranges.

**BetterDB child connections that emitted at least one anomaly event (`betterdb.jsonl`):**

| Run | Pods | Distinct child connection ids | Pods split over 2 ids | Pods split over 3 ids |
|---|---|---|---|---|
| full, `2026-11-11T14-01-50-665-s42` | 36 | 69 | 31 | 1 |
| full, `2026-11-10T19-54-07-874-s42` | 36 | 69 | 31 | 1 |
| roll-only, `2026-11-10T19-26-16-778-s42` | 36 | 69 | 33 | 0 |

(The 4 pods with a single id in the full runs were in the last shards to roll and raised no events on their new id before the run ended. This table counts only ids that emitted events, so it is a lower bound on the number of registrations.)

Example from the final run, pod `valkey-bz-2-1-0` (times UTC):

| Child id | Events | First to last event | What happened |
|---|---|---|---|
| `7c99bcd2…` | 29 | 14:02:06 – 14:27:51 | original pod. Deleted by `primaryKill` at 14:28:21 |
| `1febcdb7…` | 4 | 14:31:16 – 14:32:16 | replacement pod. Rolled at 14:32:39 |
| `8b64262d…` | 19 | 14:33:36 – 14:39:16 | pod after the roll |

To BetterDB this pod is three unrelated connections. Two of them are retired (the connection list labels retired auto members "left cluster", `apps/web/src/utils/connectionType.ts:49-51`), and their names differ only by IP (`<seed name> · 10.244.x.y:6379`).

**Deep links:** opening `/anomalies?connection=<retired child id>` shows the default connection's (seed's) anomaly list. The `connection` query parameter is rewritten to the seed id and no message is shown. The harness had to stop reusing links captured earlier in a run and look up the live child id again after every roll (`benchmarks/operator-sim/FINDINGS.md`).

The same happens on v0.55.0 and on origin/master (7b29d758). None of the files cited below changed between the two.

## Expected behaviour

- A node that keeps its Valkey node id while its IP changes (for example `nodes.conf` on a PersistentVolume, or a VM or container that gets a new DHCP/bridge address) keeps the **same** child connection id. The address is updated in place, and its history and detector baselines carry on.
- A node that announces a stable hostname (`cluster-announce-hostname`, such as a StatefulSet pod DNS name) keeps the same child connection id across pod replacement, even when its node id changes.
- When a node really is replaced and neither key matches, the retired child records which child took its place in the same shard. The UI can then point from the old id to the new one.
- `?connection=<retired id>` never falls back silently. It shows a "this node left the cluster" state with a link to the successor (or to the seed), and it does not rewrite the URL to a different connection.

## Root cause

1. **Membership is diffed by address only.** `apps/api/src/topology/membership-diff.ts:138` keys current members by `host:port`, and the loop at `:148-176` looks up each desired node by address:

   ```ts
   const currentByAddress = new Map(current.map((member) => [addressKey(member.host, member.port), member]));
   ...
   const member = currentByAddress.get(key);
   if (member) { ... diff.refresh / diff.reactivate ... }
   ...
   const owner = lookup(node.host, node.port);
   if (!owner) {
     diff.add.push(node);
   ```

   Lines `:179-183` then retire every active member whose address is no longer present. `nodeId` and `hostname` are already captured (`desiredFromDiscovery`, `:126`) and stored on the membership, but they are only compared to decide whether a child at the *same* address needs a `refresh` (`:141-146`). They are never used to match.

2. **New children get a random id and an address-derived name.** `apps/api/src/connections/connection-registry.service.ts:1441-1499` (`addManagedChild`) creates `id: randomUUID()` and `name: \`${seed.name} · ${node.host}:${node.port}\``. `retireChild` (`:1537-1552`) sets `membership.retiredAt` and disconnects. Retired children are deleted after the retention period (`apps/api/src/topology/topology-auto-registration.service.ts:245-251`).

3. **Reactivation by address can join two different nodes.** If a retired child's address shows up again, `diffMembership` reactivates that child (`membership-diff.ts:152-159`) and `reactivateChild` (`connection-registry.service.ts:1554-1572`) overwrites `nodeId` with the new node's. On Kubernetes, a pod IP can be reused by a different pod. The new node then inherits the old node's history. This was not seen in these runs (0 IPs reused), but the code allows it.

4. **All history is keyed by the child's connection id.** For example `anomaly_events.connection_id` (`apps/api/src/storage/adapters/postgres.adapter.ts:1767`). The membership itself is a JSON text column on `connections` (`:2436`). Anomaly detector buffers are held in memory per connection id, so each new child is blind for the 30-sample warm-up (`proprietary/anomaly-detection/metric-buffer.ts:11`).

5. **The web UI drops retired ids.** `apps/web/src/hooks/useConnection.ts:130-142` picks the initial connection only from `selectable`, the connections that are not retired auto members (`isUnavailableMember`, `apps/web/src/utils/connectionType.ts:45-47`), and otherwise falls back to `currentId` or the first connected one. `apps/web/src/hooks/useConnectionUrlSync.ts:39-52` then rewrites `?connection=` to the chosen id with `replace: true`, so the requested id disappears from the URL.

Note: Sentinel members use `nodeId = runid || group/host:port` (`apps/api/src/topology/sentinel-topology.source.ts:97`). `run_id` changes on every process restart, so it must not be used as a stable key for Sentinel.

## Proposed change

### 1. Match by stable key before address (API, `membership-diff.ts`)

Add a key lookup in front of the address lookup in `diffMembership`. For cluster members (`source: 'cluster'`), try these in order:

1. **Valkey node id** (`membership.nodeId`, the `CLUSTER NODES` id, the same value `CLUSTER MYID` returns). It is unique within the cluster and survives an IP change whenever `nodes.conf` survives.
2. **Announced hostname** (`membership.hostname`, from `ip:port@cport,hostname` in `CLUSTER NODES`) when it is set. On Kubernetes this is usually the pod's DNS name and survives pod replacement.
3. **Address** (`host:port`), as today, as the last resort.

If an active or retired member matches by node id or hostname but its address differs, emit a new `diff.move: Array<{ id, node, from: {host, port} }>` entry instead of `add` + `retire`. `ConnectionRegistry.moveChild(id, node)` updates `host`, `port`, `name` and membership, persists them, and reconnects the adapter (same path as `refreshChild` uses for a hostname change). It keeps the id, detector state and history. Log `Node <nodeId> moved 10.244.5.24:6379 → 10.244.3.40:6379`.

Guards:
- A desired node can match at most one member. If node id and hostname point at different members, prefer node id and log the conflict.
- **Address reuse:** reactivate a retired member found by address only when its stored `nodeId` equals the new node's id, or its `hostname` equals the new node's hostname. Otherwise retire the old record for good (leave it retired) and `add` a new child. This fixes root cause 3.
- The retirement threshold (`gateRetirements`, `topology-auto-registration.service.ts:228-243`) counts only real retirements, not moves. Otherwise a whole-cluster roll would always hit the "hold" path.
- Sentinel keeps matching by address as today (its `nodeId` is a run id).

### 2. Record a successor when a node is replaced

When a sync retires child A and adds child B in the same reconcile, A and B were in the same shard, and B was not matched by any key, store `membership.successorId = B` on A. Shard identity comes from `CLUSTER SHARDS` `id`, which in our runs was stable through every roll. If discovery uses only `CLUSTER NODES`, use the slot range of the primary the node replicates. A retired child that already has a successor gets its successor's successor when B is itself replaced, so a chain always resolves to a live child (resolve with a depth limit of about 10).

This does not merge history: A and B are genuinely different Valkey processes, and B started with an empty dataset. The link only exists so the UI and API can lead the user from A to B.

Expose it as `TopologyMembershipDto.successorId?: string` (`apps/api/src/common/dto/connections.dto.ts:172-193`) and in `GET /api/connections` (which already returns retired members via `includeRetired: true`, `connections.controller.ts:63`).

### 3. Web: explicit handling of retired ids

- In `useConnectionState`, if the requested `?connection=` id exists but is a retired auto member:
  - and `successorId` resolves to a live connection, select the successor and show a dismissible banner: "Node `10.244.5.24:6379` left the cluster at <time>. Showing its replacement `10.244.3.40:6379`. [View the retired node's history]". The link opens the retired id read-only.
  - otherwise, show the retired connection read-only (historical pages only: anomalies, slow log history, incidents) with a "left cluster at <time>" banner and a link to the seed.
- If the requested id does not exist at all, show "Connection `<id>` no longer exists. Showing <default>." instead of switching silently.
- `useConnectionUrlSync` must not overwrite the requested id until one of the outcomes above has been chosen. When it redirects to a successor, it uses `navigate(..., { replace: true })` and keeps the original id in `history.state` so that Back still works.

### 4. Display name

Name children by the stable key when there is one: `<seed name> · <hostname>` if a hostname is announced, otherwise `<seed name> · <host>:<port>` (as today). On a move, update the name to the new address when the name was derived from the address.

### 5. Migration

None needed for the schema: `membership` is stored as JSON, and `nodeId` and `hostname` are already there for every auto child registered by v0.5x. On the first sync after upgrading, an existing child whose node id matches is moved instead of being replaced. Already-retired children stay retired. An optional one-off backfill can compute `successorId` for retired children by matching shard and retirement time (±60 s) against children added in the same window. It is best-effort and can be left out.

### Config knobs

- `CLUSTER_NODE_IDENTITY` = `auto` (default: node id, then hostname, then address) | `address` (today's behaviour, as an escape hatch).

### Kubernetes guidance (docs)

Add to `docs/cluster-auto-registration.md`: history follows a node across pod replacement only if the node keeps its node id (persistent `nodes.conf`) or announces a stable hostname. Show how to check (`CLUSTER SHARDS` → `hostname` field, `CLUSTER MYID` before and after deleting a pod), and describe what happens otherwise (a successor link instead of continuous history).

## Acceptance criteria

- [ ] `diffMembership` returns a `move` (not `add` + `retire`) for a member whose node id is unchanged and whose address changed. The member keeps its connection id.
- [ ] Same for a member with an unchanged `hostname` and a changed node id and address.
- [ ] A retired member is reactivated by address only when its node id or hostname matches. An address reused by a different node id produces `add` (a new id), and the old record stays retired.
- [ ] A 36-node cluster where every node moves address in one sync with node ids unchanged produces 36 moves, 0 retirements and no "Holding retirement" warning.
- [ ] When a node is replaced (new id, new IP, no hostname), the retired child gets `successorId` set to the child added for the same shard in that reconcile. `GET /api/connections` returns it.
- [ ] Opening `/anomalies?connection=<retired id with successor>` shows the successor and a banner naming the retired node. The retired node's history stays reachable from the banner.
- [ ] Opening `/anomalies?connection=<retired id without successor>` shows that connection's history read-only with a "left cluster" banner. It does not switch to the seed without a message.
- [ ] Opening `/anomalies?connection=<unknown id>` shows a "no longer exists" message.
- [ ] Sentinel auto-registration behaviour is unchanged (existing `topology-auto-registration.sentinel.spec.ts` passes unmodified).
- [ ] `CLUSTER_NODE_IDENTITY=address` restores the current behaviour exactly (existing `membership-diff.spec.ts` passes under it).

## Test plan

**Unit, `apps/api/src/topology/__tests__/membership-diff.spec.ts`:**
- current `[{id:'c1', host:'10.0.0.1', port:6379, membership:{nodeId:'n1', ...}}]`, desired `[{host:'10.0.0.9', port:6379, nodeId:'n1'}]` → `move:[{id:'c1', node.host:'10.0.0.9'}]`, `add:[]`, `retire:[]`.
- current `c1{nodeId:'n1', hostname:'valkey-bz-2-1-0.valkey-bz.valkey.svc'}`, desired `{host:'10.0.0.9', nodeId:'n2', hostname:'valkey-bz-2-1-0.valkey-bz.valkey.svc'}` → `move` c1.
- retired `c1{host:'10.0.0.1', nodeId:'n1'}`, desired `{host:'10.0.0.1', nodeId:'n7'}` → `add:[n7]`, no `reactivate`.
- desired with no key match, plus one active member gone from the same shard → `add` + `retire` with a successor pairing.
- 36 members all moved → `retire.length === 0`.

**Unit, `connection-registry.membership.spec.ts`:** `moveChild` keeps the id, updates host, port and name, persists, reconnects, and leaves `retiredAt` unset.

**Web, `apps/web/src/hooks/useConnection.test.tsx` and `useConnectionUrlSync.test.tsx`:**
- URL `?connection=old`, `old` retired with `successorId:'new'` → `currentConnection.id === 'new'` and the banner state contains `old`.
- URL `?connection=old`, retired, no successor → `currentConnection.id === 'old'` in read-only mode. The URL is not rewritten.
- URL `?connection=missing` → falls back to the default and sets the "no longer exists" flag.

**Harness repro** (needs Docker, kind, helm and kubectl; read `benchmarks/operator-sim/docs/RUNBOOK.md` first):

```sh
cd benchmarks/operator-sim
make up betterdb warm
PHASES=primaryKill,rollingUpdate make scenario
```

Then:
- `curl -s localhost:3001/api/connections | jq '[.connections[] | select(.membership)] | group_by(.membership.retiredAt != null) | map(length)'`. After one kill and one roll you should expect `[36, 37]` today (36 live; 37 retired = 36 original children + the child of the pod that replaced the killed one). Without persistence the counts stay the same after the change, but each retired child should now have `successorId` set. With node ids that persist, or with announced hostnames, you should see `[36]` (no retired children). Note that `cluster.persistence` in `config/sim.yaml` is not yet passed to the ValkeyCluster template (`infra/valkey/valkeycluster.yaml.tmpl` has no `spec.persistence`), so testing the persistent case needs that template change first.
- Run the per-pod count from this issue on the new run: the number of distinct `connectionId`s per `pod` in `runs/<run>/betterdb.jsonl` should be 1 per pod whenever node ids or hostnames persist.
- Open `/anomalies?connection=<an id that was live before the roll>` and check for the banner.

## Out of scope / open questions

- **Does the valkey-operator keep node ids across pod replacement when persistence is enabled?** Not checked in these runs (all were without persistence). If it does not, hostname announcement is the only stable key on Kubernetes. Can the operator set `cluster-announce-hostname` per pod (some operators expose this as a "preferred endpoint type: hostname" option)? Not verified for v0.8.0. If it does not, raise it with the operator project.
- A possible alternative stable key when neither persistence nor hostnames are available: reverse DNS (PTR) of the pod IP under the seed's headless Service domain (`<pod>.<service>.<ns>.svc.cluster.local`). Whether CoreDNS returns such PTR records for these pods depends on the pod's `subdomain`. Not verified.
- Merging history across a successor chain into one logical "node slot" view (for example "shard 2, replica position 1 over the last 7 days") is a larger product question. This issue only adds the link.
- Detector baselines are not carried over to a successor on purpose: a fresh replica with an empty dataset should not be compared against the old node's memory or keyspace baseline.

## References

- `apps/api/src/topology/membership-diff.ts:114-185` (`desiredFromDiscovery`, `diffMembership`)
- `apps/api/src/topology/topology-auto-registration.service.ts:72-111` (reconcile), `:228-243` (retirement hold), `:245-251` (purge)
- `apps/api/src/connections/connection-registry.service.ts:1441-1572` (add / refresh / retire / reactivate child)
- `apps/web/src/hooks/useConnection.ts:120-145`, `apps/web/src/hooks/useConnectionUrlSync.ts:26-52`, `apps/web/src/utils/connectionType.ts:41-47`
- `docs/cluster-auto-registration.md`
- Harness: `benchmarks/operator-sim/` (`FINDINGS.md`, `runs/2026-11-11T14-01-50-665-s42/`)
