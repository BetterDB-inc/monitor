# Flag nodes whose role or config epoch, as seen by peers, disagrees with the node's own view (stale "slotless master")

**Suggested labels:** `enhancement`, `bug`, `anomaly-detection`, `cluster`, `web`  ·  **Area:** `proprietary/anomaly-detection`, `apps/web/src/hooks`, `apps/web/src/pages`  ·  **Severity:** medium: the cluster keeps serving, but BetterDB shows a wrong topology ("13 masters" for 12 shards) as healthy and never flags a gossip state that does not converge on its own.

> **Testing:** the harness used to find and reproduce this is on branch [`bench/operator-sim`](https://github.com/BetterDB-inc/monitor/tree/bench/operator-sim/benchmarks/operator-sim) (`benchmarks/operator-sim/`; start with its README). Raw run data (`runs/<id>/*.jsonl`) is not committed; re-run the commands in the test plan to regenerate it.

## Summary

After an operator rolling update, part of a Valkey cluster can keep listing a node as a `master` that owns no slots, while that node reports itself as a replica and replicates normally. In a clean repro (no BetterDB, no load), 7 of 36 nodes listed node `6758063…` as `master` at config epoch **146**, while the node's own `CLUSTER NODES` line said `myself,slave … 145`, as did the other 28 nodes. The views did not converge for as long as we watched. BetterDB's Cluster page counted the stale entry and showed "Monitoring 13 master nodes and 23 replicas" for a 12 × 2 cluster, with health "OK" and no anomaly. This issue proposes (a) counting only slot-owning primaries in the UI and showing a view-inconsistency notice, (b) a detector that compares each node's self-reported role and epoch with how its peers see it, and (c) cross-filing upstream, since the root cause is likely in the operator or Valkey.

## How we found it

The `benchmarks/operator-sim` harness in this repo (branch `bench/operator-sim`) runs a Valkey cluster on Kubernetes through a fault timeline. An independent sampler records each node's `CLUSTER NODES` summary every 5 s, including any `master` entries without slots.

- kind v0.33.0, Kubernetes v1.37.0, 1 control plane + 6 workers, one 16 vCPU / 62 GiB host.
- valkey-operator v0.8.0. A `ValkeyCluster` with 12 shards × (1 primary + 2 replicas) = 36 pods, no persistence.
- Valkey 9.1.2 ↔ 9.1.3 image rolls.
- BetterDB Monitor v0.55.0. The seed connection is the operator's headless Service, plus 36 auto-registered per-pod connections, 1 s anomaly poll.

Where it was seen:

| source | rolls | persistent stale entry after the roll |
|---|---|---|
| Scenario runs `2026-11-10T18-35-22-462-s42`, `2026-11-10T19-54-07-874-s42`, `2026-11-11T14-01-50-665-s42`, control `2026-11-10T19-26-16-778-s42` | 4 | 3 of 4. The fourth, a roll-only run on a freshly reset cluster, stayed clean. Each persisted until observation ended (5–10 min). |
| Clean repro `benchmarks/operator-sim/scripts/repro-ghost-master.sh`: kind + operator only, no BetterDB, no load, no fault injection, 1M keys preloaded | 3 (9.1.3 → 9.1.2 → 9.1.3) | 1 of 3 (roll 3). Persisted through the whole 300 s observation. |

In the final scenario run (`2026-11-11T14-01-50-665-s42`), the same shape appeared: 7 of 36 nodes (all of shards 0 and 1, plus `valkey-bz-2-2-0`) listed `10.244.5.43` as a slotless master from the end of the roll until observation stopped 142 s later.

Harness self-check: node ids never changed IP, no IP was reused by another id, and the harness sends no membership commands (`CLUSTER FORGET` / `MEET` / `RESET`). This is not caused by the test tooling.

**Transient entries are normal and must not alert.** Restarted pods show up as a slotless `master` for a short time (5–45 s in our samples): it boots empty and reports `role:master` until the operator re-joins it as a replica. In that case the node's self-view also says `master`, so peers and node agree.

## Observed behaviour

Clean repro, roll 3, captured 2026-11-11T13:43:47Z (`runs/repro-ghost/evidence.txt`, not committed; attach to the issue). One line per pod: that pod's `CLUSTER INFO` epochs, then its `CLUSTER NODES` line for node `6758063940d5e14c7ffb6f63d68185dd288c2f8b`:

```
valkey-bz-0-0-0 | cluster_current_epoch:183  cluster_my_epoch:137   | 6758063940d5e14c7ffb6f63d68185dd288c2f8b 10.244.5.24:6379@16379 master - 0 1794404625834 146 connected
valkey-bz-0-1-0 | cluster_current_epoch:183  cluster_my_epoch:137   | 6758063940d5e14c7ffb6f63d68185dd288c2f8b 10.244.5.24:6379@16379 master - 0 1794404621000 146 connected
valkey-bz-0-2-0 | cluster_current_epoch:183  cluster_my_epoch:137   | 6758063940d5e14c7ffb6f63d68185dd288c2f8b 10.244.5.24:6379@16379 master - 0 1794404625000 146 connected
valkey-bz-1-0-0 | cluster_current_epoch:183  cluster_my_epoch:141   | 6758063940d5e14c7ffb6f63d68185dd288c2f8b 10.244.5.24:6379@16379 master - 0 1794404625000 146 connected
valkey-bz-1-1-0 | cluster_current_epoch:183  cluster_my_epoch:141   | 6758063940d5e14c7ffb6f63d68185dd288c2f8b 10.244.5.24:6379@16379 master - 0 1794404627000 146 connected
valkey-bz-1-2-0 | cluster_current_epoch:183  cluster_my_epoch:141   | 6758063940d5e14c7ffb6f63d68185dd288c2f8b 10.244.5.24:6379@16379 master - 0 1794404625000 146 connected
valkey-bz-2-0-0 | cluster_current_epoch:183  cluster_my_epoch:145   | 6758063940d5e14c7ffb6f63d68185dd288c2f8b 10.244.5.24:6379@16379 slave 9d297c89871b6e26d89a701e7e984ee57edc531e 0 1794404627000 145 connected
valkey-bz-2-1-0 | cluster_current_epoch:183  cluster_my_epoch:145   | 6758063940d5e14c7ffb6f63d68185dd288c2f8b 10.244.5.24:6379@16379 myself,slave 9d297c89871b6e26d89a701e7e984ee57edc531e 0 0 145 connected
valkey-bz-2-2-0 | cluster_current_epoch:183  cluster_my_epoch:145   | 6758063940d5e14c7ffb6f63d68185dd288c2f8b 10.244.5.24:6379@16379 master - 0 1794404628000 146 connected
valkey-bz-3-0-0 | cluster_current_epoch:183  cluster_my_epoch:150   | 6758063940d5e14c7ffb6f63d68185dd288c2f8b 10.244.5.24:6379@16379 slave 9d297c89871b6e26d89a701e7e984ee57edc531e 0 1794404628000 145 connected
… (shards 3–11: all 27 remaining nodes list it as `slave 9d297c89… 145`)
```

The node itself (`valkey-bz-2-1-0`, `INFO replication`):

```
role:slave
master_host:10.244.4.23
master_port:6379
master_link_status:up
master_sync_in_progress:0
```

Repro log (`runs/repro-ghost/ghost.log`), one line every ~16 s for the full 300 s observation:

```
2026-11-11T13:38:03Z round 3: Ready; observing 300s
2026-11-11T13:38:10Z slotless-master id=6758063940d5e14c7ffb6f63d68185dd288c2f8b ip=10.244.5.24 pod=valkey-bz-2-1-0 self-role=slave listed-by=7/36
…
2026-11-11T13:43:09Z slotless-master id=6758063940d5e14c7ffb6f63d68185dd288c2f8b ip=10.244.5.24 pod=valkey-bz-2-1-0 self-role=slave listed-by=7/36
2026-11-11T13:43:19Z round summary: 19 slotless-master observations
```

What stands out:

1. **Role disagreement.** 7/36 peers say `master` (no slots). The node and 28 others say `slave` of `9d297c89…`.
2. **Config epoch disagreement.** The peers that disagree hold config epoch **146** for the node. The node's own `myself` line says **145**, and the 28 agreeing peers also say 145.

   In this setup (no persistence) every pod replacement creates a **new** Valkey node id: `nodes.conf` is lost, and the final scenario run had 73 distinct node ids for 73 pod incarnations, with no id ever reused. So `6758063…` is not an old identity that came back with an older epoch. Most likely it is a node created during the roll that was a primary at epoch 146 at some point and is now a replica (self-line epoch 145). **The mechanism is open.** One candidate: peers that recorded the node as master @146 do not apply its later role change because the node now announces a lower config epoch (145) than the one they recorded. This has not been confirmed.
3. `cluster_state:ok` throughout, and all 16384 slots covered.

**BetterDB v0.55.0** (final run, screenshot `runs/2026-11-11T14-01-50-665-s42/screenshots/rollingUpdate-cluster.png`): the Cluster page header reads "Monitoring 13 master nodes and 23 replicas". The Cluster Health card shows State OK, Masters 13, Replicas 23. No finding identified the stale-master view in any of the four runs: there were no `ghost_membership` events, and in the two later runs no event mentioned the node at all. In the first run (`2026-11-10T18-35-22-462-s42`), 30 `cluster_topology` WARNINGs did name the stale node `10.244.1.11`, but described it as "Replica 10.244.1.11:6379 … is stuck replicating a failed primary … (valkey#2090)", one per observing connection. That is a different diagnosis from the stale view described here.

## Expected behaviour

- The Cluster page counts **primaries that own slots** (12 here) and shows separately "1 node is listed as a primary by some peers but has no slots and reports itself as a replica". The stale entry is not silently counted as a master.
- After the condition persists past a grace period that tolerates normal re-join churn, BetterDB raises one cluster-scoped finding. The finding names the node, its self-reported role and epoch, the role and epoch peers hold, the list of peers holding the stale view, and suggested next steps.

## Root cause

**UI.** `apps/web/src/hooks/useCluster.ts:77-92` classifies every node whose flags include `master` as a master, whether or not it owns slots:

```ts
for (const node of nodes) {
  if (node.flags.includes('master')) {
    masters.push(node);
  } else if (node.flags.includes('slave') || node.flags.includes('replica')) {
    replicas.push(node);
  }
}
```

`apps/web/src/pages/ClusterDashboard.tsx:193` renders `Monitoring {masters.length} master nodes and {replicas.length} replicas`, and `:223-227` passes the same counts to `ClusterHealthCard`. `apps/web/src/components/cluster/ClusterTopology.tsx:24` builds the topology from the same `flags.includes('master')` filter. The node list is one node's view (the seed connection's `CLUSTER NODES`), so whichever pod the headless Service resolves to decides what the page shows.

**Detection.** Every topology detector judges one connection's `CLUSTER NODES` snapshot in isolation (`proprietary/anomaly-detection/anomaly.service.ts:1994-2010`). None of them matches this state:

- `ghost-membership-detector.ts:3-41` / `detectGhostMembers` (`:207`) looks for one `ip:port` endpoint claimed by more than one node id (stale twin after `CLUSTER RESET`, live address collision, loopback flip). Here endpoint `10.244.5.24:6379` maps to exactly one id, so it is ignored.
- `duplicate-primary-detector.ts:3-14` needs two masters claiming overlapping slots. The stale master claims none.
- `stuck-replica-detector.ts:67-90` looks for replicas whose primary is dead or missing. No replica points at the stale master.
- `failover-churn-detector.ts:68-73` only considers primaries with slots.

The data needed to detect it is already collected. Every auto-registered child connection runs `CLUSTER NODES` on its own node every poll (`anomaly.service.ts:1984`), and that output contains the node's `myself` line: its self-reported role, master id and config epoch. `rememberClusterKey` (`anomaly.service.ts:7875-7888`) already groups connections into a cluster via `clusterKey`. For seed-only setups, `readNodeSelf` (`anomaly.service.ts:6315`) and `gatherReplicaSlotView` (`:7098`) already fan out to read other nodes' `myself` lines.

**Upstream.** BetterDB did not cause this; it reproduces with nothing but the operator and kubectl. Why some peers keep a higher-epoch `master` record for a node that now announces itself as a replica at a lower epoch is unknown. It may be Valkey gossip/epoch handling, or a sequence of operator actions (failover, `CLUSTER REPLICATE`) that Valkey does not reconcile. It should be filed upstream (see below).

## Proposed change

### (a) UI: count slot owners, flag inconsistency

- `useCluster.ts`: split nodes into
  - `primaries`: `master` flag, not `fail`/`noaddr`, `slots.length > 0`;
  - `emptyPrimaries`: `master` flag, no slots, no migration/import markers;
  - `replicas`.
- `ClusterDashboard.tsx:193`: "Monitoring 12 primaries and 23 replicas" plus, when `emptyPrimaries.length > 0`, a muted line "1 slotless primary (`10.244.5.24`, `6758063…`)". This includes a tooltip explaining that it is normal for under a minute while a node joins, and that if it persists you should check the cluster-view-disagreement finding.
- `ClusterHealthCard`: the Masters tile shows slot owners. Add an "Empty" sub-count when non-zero.
- `ClusterTopology.tsx:24`: render slotless masters in a separate "Not serving slots" group instead of as a shard with zero replicas.
- When a `cluster_view_disagreement` finding (below) is open for this cluster, show a warning banner on the Cluster page linking to it, following the existing banners in `apps/web/src/components/anomalies/*Banner.tsx`.

### (b) Detector: `MetricType.CLUSTER_VIEW_DISAGREEMENT = 'cluster_view_disagreement'` (state-based, cluster-scoped)

New pure module `proprietary/anomaly-detection/cluster-view-disagreement-detector.ts`:

```ts
export interface NodeSelfView { nodeId: string; role: 'master' | 'replica'; masterId: string | null; configEpoch: number; slots: number; observedAt: number }
export interface PeerView    { observerId: string; nodeId: string; role: 'master' | 'replica'; masterId: string | null; configEpoch: number; slots: number; flags: string[] }
export interface ViewDisagreement {
  nodeId: string; address: string;
  self: { role: string; configEpoch: number; masterId: string | null };
  stale: { role: string; configEpoch: number; observers: string[] };   // peers holding a view != self
  agreeing: number; totalObservers: number;
  kind: 'role_mismatch' | 'epoch_mismatch' | 'both';
}
export function detectViewDisagreements(selves: NodeSelfView[], peers: PeerView[]): ViewDisagreement[];
```

Rules:

1. **Inputs.** Each poll, every connection in the same `clusterKey` contributes its own `myself` line (self view) and its lines for every other node (peer views). Keep the latest view per observer, valid for `3 × poll interval`. The aggregation lives in the service, keyed by `clusterKey`, the same way reshard snapshots are shared across connections.
2. **Role mismatch.** The self view is a replica, and ≥ 1 peer that is not `fail`/`fail?`/`noaddr`/`handshake` lists the node as `master` with 0 slots. The reverse (self `master` with slots, peers say `slave`) is also flagged. The transient re-join case is excluded by construction: there, the self view is `master` with no slots and peers agree.
3. **Epoch mismatch.** Some peers hold a `configEpoch` for the node that is higher than the node's own `myself` epoch. Peers holding a *lower* epoch is ordinary propagation lag and is ignored. A persistent higher-than-self value means those peers are holding a record the node no longer announces.
4. **Persistence.** Fire only after the same `(nodeId, kind, stale epoch)` signature persists for `ANOMALY_VIEW_DISAGREEMENT_MIN_PERSIST_MS` (default **120000**). This is above the 5–45 s re-join churn seen in every roll and above typical `cluster-node-timeout` values. Implement with `applyTopologyPersistenceGate` (`anomaly.service.ts:7203`), keyed by cluster rather than by connection.
5. **Quorum of evidence.** Require the node's own self view (from its connection or the fan-out). If the node is unreachable, do not fire; that case belongs to the failure detectors. Require ≥ `ANOMALY_VIEW_DISAGREEMENT_MIN_OBSERVERS` (default **1**) stale observers.
6. **Severity.** WARNING by default. CRITICAL if the stale view involves slots: peers believe a node that reports itself as a replica owns slots, or a node owning slots is seen by peers as a replica. That case means clients may be redirected wrongly.
7. **One finding per cluster**, not per connection. `connectionId` = seed. The message and event carry the node and the observer list (see the de-duplication issue).

Message example:

> `WARNING: 7 of 36 nodes still list 10.244.5.24:6379 (6758063) as a master with no slots at configEpoch 146, but the node reports itself as a replica of 9d297c8 at configEpoch 145. Stale views: valkey-bz-0-0-0, 0-1-0, 0-2-0, 1-0-0, 1-1-0, 1-2-0, 2-2-0. The cluster is serving normally; this view has not self-corrected in 2 minutes. See <docs link> for remediation options.`

Remediation text should be reviewed before shipping. We did not test a fix. Possible options, in order of preference: let the operator re-announce; `CLUSTER BUMPEPOCH` on the affected node so its epoch exceeds the stale 146; as a last resort, `CLUSTER FORGET` + re-`MEET` from the stale observers.

### (c) Upstream cross-filing

Ship the repro with the upstream report: `benchmarks/operator-sim/scripts/repro-ghost-master.sh` uses kubectl and `valkey-cli` only:

```bash
CONTEXT=kind-bz-sim NS=valkey CLUSTER=bz \
IMAGES="valkey/valkey:9.1.3 valkey/valkey:9.1.2" ROUNDS=3 OBSERVE_SEC=300 INTERVAL_SEC=10 \
./scripts/repro-ghost-master.sh | tee ghost.log
```

File it first against valkey-io/valkey, as a gossip/epoch question: peers keep a higher-epoch `master` record for a node that announces itself as a replica at a lower epoch. Attach the operator's action log for the affected shard (failovers, `CLUSTER REPLICATE` calls) so maintainers can tell whether the operator sequence is unusual, and cross-reference valkey-operator. Link the upstream issue from this one once filed.

### Back-compat

- UI counts change (13 → 12 in this case). That is the intended correction. Mention it in release notes.
- New metric type and env vars. No existing events change.

## Acceptance criteria

- [ ] With the repro's `CLUSTER NODES` output as input, the Cluster page shows 12 primaries, 24 replicas when the node's own view is used, or 23 plus "1 slotless primary" from a stale observer's view, never "13 master nodes".
- [ ] A slotless `master` that agrees with its own self view (re-joining pod) for 45 s produces no finding.
- [ ] The repro state (self `slave` @145, 7 peers `master` @146, no slots) produces exactly one `cluster_view_disagreement` WARNING per cluster after 120 s. It lists all 7 observers and `kind: 'both'`.
- [ ] The finding resolves when all observers agree with the self view for 2 consecutive polls.
- [ ] An epoch-only mismatch (roles agree, peers persistently hold a higher epoch than the node's self-line) is reported with `kind: 'epoch_mismatch'`.
- [ ] If the node itself cannot be read, no finding is raised.
- [ ] Unit tests for the pure detector and for `useCluster` classification.

## Test plan

**Unit, detector:** build `NodeSelfView[]`/`PeerView[]` from the evidence lines above (parse them with `MetricsParser.parseClusterNodes`):

- 36 observers; node X self = `slave` of Y @145; observers in shards 0, 1 and `2-2-0` = `master`, no slots, @146; others = `slave` @145 → one disagreement, `observers.length === 7`, `kind === 'both'`.
- Re-join: X self = `master`, no slots, @0; all peers `master`, no slots → none.
- Peer flagged `fail?` holding the stale view → not counted.
- Self view missing → none.
- Persistence: present for 119 s → no event; 120 s → one event; 10 more minutes → still one event.

**Unit, web (`useCluster` test, `apps/web/src/types/cluster.test.ts` style):** 12 masters with slots + 1 `master` without slots + 23 `slave` → `primaries.length === 12`, `emptyPrimaries.length === 1`.

**Harness:**

```bash
cd benchmarks/operator-sim
make up betterdb warm
PHASES=rollingUpdate make scenario   # repeat (make reset between takes) until the sampler records a persistent slotless master
make report
```

Look for `cluster_view` samples with a non-empty `slotlessPrimaries` list in `runs/<run>/groundtruth.jsonl` after the roll's end event. These should be matched by a single `cluster_view_disagreement` event in `runs/<run>/betterdb.jsonl`, and the Cluster page screenshot (`screenshots/rollingUpdate-cluster.png`) should show 12 primaries plus the notice. The standalone script above reproduces the cluster state without BetterDB. Point a BetterDB instance at that cluster to test the detector against a long-lived stale view.

## Out of scope / open questions

- Is the stale view harmful beyond display? It owns no slots, so client routing is unaffected. Open questions: could it affect replica migration (`cluster-allow-replica-migration`), failover auth counting, or operator reconciliation that counts masters? Worth asking upstream.
- Remediation: which command is safe to recommend, and when? Needs an upstream answer before BetterDB suggests one.
- The 3/4 vs 1/3 frequency difference (prior fault phases vs clean cluster) is unexplained.
- Cluster V2 (Raft) mode: topology is consensus-managed. Gate this detector to gossip mode like the other topology detectors (`anomaly.service.ts:1994`).

## References

- Harness: `benchmarks/operator-sim/` (branch `bench/operator-sim`), `FINDINGS.md` sections "Ghost slotless master, harness check" and "Ghost slotless master — clean repro".
- Repro script: `benchmarks/operator-sim/scripts/repro-ghost-master.sh`. Captured output: `runs/repro-ghost/{ghost.log,evidence.txt}` (not committed, attach).
- Runs: `benchmarks/operator-sim/runs/2026-11-11T14-01-50-665-s42/SUMMARY.md` (final run), `…/2026-11-10T19-54-07-874-s42/SUMMARY.md`.
- Code: `apps/web/src/hooks/useCluster.ts:77-92`, `apps/web/src/pages/ClusterDashboard.tsx:193`, `:223-227`, `apps/web/src/components/cluster/ClusterTopology.tsx:24`, `proprietary/anomaly-detection/ghost-membership-detector.ts:3-41`, `:207`, `duplicate-primary-detector.ts:3-14`, `anomaly.service.ts:1984-2010`, `6315`, `7098`, `7203`, `7875-7888`.
- Related drafts: cluster-wide de-duplication (09), roll-aware alerting (08).
