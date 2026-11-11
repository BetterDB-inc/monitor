# Detect a slot-owning primary that has no attached (or no synced) replica

**Suggested labels:** `enhancement`, `anomaly-detection`, `cluster`, `kubernetes`  ·  **Area:** `proprietary/anomaly-detection`  ·  **Severity:** high: without persistence, losing the primary during this window loses the shard's data, and BetterDB reports nothing specific about it.

> **Testing:** the harness used to find and reproduce this is on branch [`bench/operator-sim`](https://github.com/BetterDB-inc/monitor/tree/bench/operator-sim/benchmarks/operator-sim) (`benchmarks/operator-sim/`; start with its README). Raw run data (`runs/<id>/*.jsonl`) is not committed; re-run the commands in the test plan to regenerate it.

## Summary

During every Kubernetes operator rolling update we ran (4 of 4), the primary of each of the 12 shards (12/12) spent 6–37 s with `connected_slaves:0` in its own `INFO replication`. Nothing replicated its data during that window. With persistence off, a primary crash inside the window would have lost the whole shard. BetterDB raised generic failover/role findings during the roll but nothing that names this state, so an operator cannot tell a safe roll from one that is one crash away from data loss. This issue proposes a state-based detector, `primary_without_replicas`, that fires when a primary that owns slots has had zero attached replicas, or zero synced (`state=online`) replicas, for at least N seconds, and only when that shard is expected to have replicas.

## How we found it

The `benchmarks/operator-sim` harness in this repo (branch `bench/operator-sim`) drives a Valkey cluster on Kubernetes through a scripted fault timeline. In parallel, an independent sampler records "ground truth" straight from every node so BetterDB's output can be scored against it.

- kind v0.33.0, Kubernetes v1.37.0, 1 control plane + 6 workers (3 fake zones), one 16 vCPU / 62 GiB host.
- valkey-operator v0.8.0 (Helm chart `valkey/valkey-operator` 0.8.0). A `ValkeyCluster` with 12 shards × (1 primary + 2 replicas) = 36 pods, **no persistence**, `maxmemory 256mb`.
- Valkey 9.1.2, rolled to 9.1.3 by the `rollingUpdate` phase (operator image change). The operator rolls one shard at a time: both replicas first, then a failover onto a rolled replica, then the old primary.
- BetterDB Monitor v0.55.0, `ANOMALY_POLL_INTERVAL_MS=1000`, `CLUSTER_AUTO_REGISTER_NODES=true`. The seed connection is the operator's headless Service, plus 36 auto-registered per-pod connections.
- Load: 3000 rps application mix plus memtier, 1M keys preloaded.
- Ground truth: the sampler opens one socket per node and reads `INFO` every 1 s on primaries and every 5 s on replicas (`connected_slaves`, `master_link_status`, role changes).

Runs (data under `benchmarks/operator-sim/runs/`; raw JSONL is gitignored, `SUMMARY.md` per run is committed):

| run | roll | shards with 0 attached replicas | longest window per shard |
|---|---|---|---|
| `2026-11-10T18-35-22-462-s42` (first full run) | 36 pods | 12/12 | 7–37 s (approximate: the phase lost its start marker) |
| `2026-11-10T19-26-16-778-s42` (roll-only control) | 36 pods, 527 s | 12/12 | 6–13 s (9, 9, 8, 12, 6, 6, 13, 6, 8, 7, 7, 6) |
| `2026-11-10T19-54-07-874-s42` | 36 pods, 489 s | 12/12 | 6–25 s (10, 9, 6, 25, 9, 20, 9, 7, 9, 9, 13, 13) |
| `2026-11-11T14-01-50-665-s42` (final full run) | 36 pods, 521 s | 12/12 | 7–27 s (8, 7, 27, 14, 9, 7, 14, 7, 14, 8, 9, 7) |

## Observed behaviour

**Mechanism, shard 3, run `2026-11-10T19-26-16-778-s42`** (times from the start of the roll):

1. ~124 s: the operator restarts replica `valkey-bz-3-0-0`. The new pod starts empty and reports `role:master` with no slots until the operator re-joins it as a replica at 142.8 s.
2. 133 s: Kubernetes marks that pod Ready, because the readiness probe only sends `PING`.
3. ~130 s: the operator restarts the **second** replica, `valkey-bz-3-2-0`.
4. 130.8 s → 141.8 s: primary `valkey-bz-3-1-0` reports `connected_slaves:0`.
5. 150.8 s: the first replica is back in sync (`master_link_status:up`). 160.9 s: failover to `valkey-bz-3-2-0`.

So for about 11 s the shard's only copy of the data was the primary. Counting "no replica with `master_link_status:up`" (5 s resolution) gives windows of 10–40 s per shard. In the final run: shard 0 10–30 s, shard 2 100–115 s and 125–165 s, shard 3 140–165 s, and so on.

**What BetterDB raised during the roll** (final run, roll window): `replication_role` 7 CRITICAL ("Node role changed from master to replica — possible failover or split-brain detected") and 2 WARNING; `node_failover` correlated groups 12 CRITICAL and 4 WARNING; `cluster_state` 13 CRITICAL and 14 WARNING; and 678 `cluster_topology` WARNINGs about stuck replicas (see the related de-duplication issue). **No finding mentions a primary without replicas.** None of the existing detectors checks this condition (see Root cause).

This is the risk that valkey-operator tracks in [valkey-io/valkey-operator#552](https://github.com/valkey-io/valkey-operator/issues/552) ("Without persistence, draining two nodes in a row loses a shard"). [#563](https://github.com/valkey-io/valkey-operator/issues/563) ("Within a shard, the next node rolls before replica streaming finishes") was closed as a duplicate of #552. The fix, [PR #562](https://github.com/valkey-io/valkey-operator/pull/562) ("wait for a caught-up replica before draining a primary"), was still open and unmerged as of 2026-11-11. Other operators, Helm charts and hand-written StatefulSets can produce the same window, so BetterDB should detect it no matter which tool caused it.

## Expected behaviour

When a primary that owns slots in a shard that normally has replicas has zero attached replicas, or zero replicas in sync, for longer than a short grace period, BetterDB raises one finding for that shard. The finding names the primary, the shard (slot ranges), how long the condition has lasted, and whether persistence is off. It resolves automatically when a replica is back online. It must still fire during a planned operator roll, because that is exactly when this risk appears. A standalone instance or a cluster that was never configured with replicas must not trigger it.

## Root cause

There is no detector for this state. The relevant pieces on `origin/master` (7b29d758), unchanged from v0.55.0:

- `INFO` is fetched once per connection per poll in `pollConnection`, and its sections are flattened into one record. `proprietary/anomaly-detection/anomaly.service.ts:1429-1458`:
  ```ts
  protected async pollConnection(ctx: ConnectionContext): Promise<void> {
  ...
      const info = this.convertInfoToRecord(infoResponse);
  ```
- `connected_slaves` is read only for other purposes:
  - the data-loss snapshot (`anomaly.service.ts:1768`),
  - replica output-buffer pressure, which **returns early** when `connectedSlaves === 0` (`anomaly.service.ts:5053`, `5068`),
  - the drop-count corroboration for control-plane saturation (`anomaly.service.ts:5386-5393`).

  None of these alerts on the count reaching zero.
- Role changes are handled as edge events only. `anomaly.service.ts:1660-1735` emits `replication_role` when this connection's role flips, but says nothing about the shard's replica coverage.
- The replica-side detectors look at the replica, not the primary. `resync_loop` (`stuck-replica-detector.ts:181`, wired at `anomaly.service.ts:2112`) needs a 300 s link-down window (`RESYNC_LOOP_MIN_WINDOW_MS`). The stuck-replica check (`stuck-replica-detector.ts:67-90`) looks for replicas pointing at a dead primary. In the failure above, the replicas are not pointing anywhere: they are restarting, or report `role:master` while empty.
- Per-replica state is already parsed. `apps/api/src/database/parsers/replication-info.parser.ts:28-44` (`parseReplicaLines`) turns `slaveN:ip=…,port=…,state=online,offset=…,lag=…` into `{ addr, state, offset, lagSec }`. The detector can therefore count *synced* replicas (`state=online`) from the primary's own INFO, without contacting the replicas.

Patterns to follow for a state-based detector:

- `MetricType` enum entries with a doc comment and membership in `METRICS_HANDLED_OUTSIDE_EXTRACTOR` (`proprietary/anomaly-detection/types.ts:5-79`, `88-126`). `FAILOVER_CHURN`, `RESYNC_LOOP` and `REPL_BUFFER_PRESSURE` are examples.
- A pure evaluator in its own file with external per-key state and an emit-acknowledge contract (`failover-churn-detector.ts:18-21`, `evaluateFailoverChurn`), wrapped by a small service method (`anomaly.service.ts:7425-7456`, `detectFailoverChurn`), and cleaned up in `onConnectionRemoved` (`anomaly.service.ts:1211`, for example line 1300 `this.failoverChurnState.delete(connectionId)`).
- "Live primary owns slots": `failover-churn-detector.ts:68-73` (`isLivePrimary` requires `node.slots.length > 0`), with `canonicalSlotKey` (`failover-churn-detector.ts:75-83`, currently not exported) as a stable shard key.
- Persistence/dedupe gate: `applyTopologyPersistenceGate` (`anomaly.service.ts:7203`).

## Proposed change

### Detector: `MetricType.PRIMARY_WITHOUT_REPLICAS = 'primary_without_replicas'` (state-based)

New file `proprietary/anomaly-detection/primary-without-replicas-detector.ts` with a pure evaluator:

```ts
export interface PrimaryReplicaInput {
  role: string;                 // INFO role
  ownsSlots: boolean | null;    // cluster: myself line has slots; null in standalone
  shardKey: string;             // canonical slot ranges (cluster) or node run_id/replid (standalone)
  attached: number;             // INFO connected_slaves
  synced: number;               // parseReplicaLines(...).filter(r => r.state === 'online').length
  persistenceOff: boolean;      // aof_enabled:0 && rdb_changes_since_last_save keeps growing / no successful save seen
  timestamp: number;
}
export interface ShardReplicaState {
  expectedReplicas: number;     // high-water mark, see below
  expectedSeenAt: number;
  zeroSince: number | null;     // first poll with synced === 0
  attachedZeroSince: number | null;
  alerted: 'none' | 'warning' | 'critical';
}
export function evaluatePrimaryWithoutReplicas(
  state: ShardReplicaState, input: PrimaryReplicaInput, cfg: Config,
): PrimaryWithoutReplicasFinding | null;
```

Rules:

1. **Only slot owners.** In cluster mode, evaluate only when `role === 'master'` and the node's `myself` line in `CLUSTER NODES` has `slots.length > 0`. A freshly restarted pod reporting `role:master` with no slots is the *cause* of this problem, not a primary at risk, so it is excluded. The poll already fetches `CLUSTER NODES` at `anomaly.service.ts:1984`, so this needs no extra command.
2. **Only shards that are expected to have replicas.** `expectedReplicas` is a high-water mark of `connected_slaves` kept per `(clusterKey, shardKey)`. It is raised immediately when a higher count is observed and decays only after `ANOMALY_PRIMARY_REPLICAS_EXPECTATION_TTL_MS` (default 24 h) without seeing it. It is optionally cross-checked against `CLUSTER NODES`: the number of nodes whose `master` field is this primary's id, including ones flagged `fail`. If `expectedReplicas === 0`, never alert. This covers standalone instances without replicas, clusters built with 0 replicas, and BetterDB being started while replicas are already missing. The last case is a documented limitation: with no history, nothing is expected.
3. **Keyed by shard, not by connection.** State lives in `Map<clusterKey, Map<shardKey, ShardReplicaState>>`, so it survives a failover (new primary, same slot set) and a pod getting a new IP (new BetterDB connection id, same slots). `clusterKey` already exists (`connectionClusterKeys`, `anomaly.service.ts:686`).
4. **Thresholds.** These are defaults, sized from the observed 6–37 s windows at 1 s polling:
   - `synced === 0` for ≥ `ANOMALY_PRIMARY_NO_REPLICA_WARN_MS` (default **5000**) → **WARNING**.
   - `synced === 0` for ≥ `ANOMALY_PRIMARY_NO_REPLICA_CRIT_MS` (default **30000**) → escalate to **CRITICAL**. Escalate immediately at the warning threshold when `persistenceOff` is true and `attached === 0`. If persistence cannot be determined with the minimal-ACL user, treat it as unknown and do not escalate early.
   - Set either threshold to `0` to disable that level. Changes are hot-reloadable through the existing per-detector settings (`PATCH /settings/anomaly/detectors`) if the threshold DTO is extended. Otherwise env-only in the first iteration.
5. **One event per shard episode.** Emit once at WARNING. Emit an escalation event at CRITICAL that is linked by `correlationId`. Resolve both when `synced ≥ 1` for 2 consecutive polls. When several connections observe the same shard (the seed fan-out and the per-node connection), dedupe on `(clusterKey, shardKey)`, not on `connectionId` (see the de-duplication issue).
6. **Not suppressed during rolls.** If roll-aware alerting lands (separate issue), this detector is explicitly exempt from downgrade or suppression. Its message gains "during an operator roll" context instead.

Message example:

> `CRITICAL: Primary 10.244.4.28:6379 (90735665) for slots 4096-5460 has had no synced replica for 31 s (0 attached, 2 expected). Persistence is off — losing this node now loses the shard. If a rolling update is in progress, pause it until a replica reports master_link_status:up.`

Fields on the event: `value = synced`, `baseline = expectedReplicas`, `threshold = expectedReplicas`, `nodeAddr`, plus the shard key in the message. A small `details` object (`{ attached, synced, expected, zeroForMs, persistenceOff, slots }`) is optional if the stored event type allows it.

### Wiring

- Call `detectPrimaryWithoutReplicas(info, ctx, timestamp, nodes)` from `pollConnection` next to `detectFailoverChurn` (`anomaly.service.ts:2000`) for cluster mode. Call it with `nodes = undefined` for standalone (`role:master`, `ownsSlots = null`). Sentinel-managed standalone primaries are included.
- Add the new metric type to `METRICS_HANDLED_OUTSIDE_EXTRACTOR`.
- Add a display label in `apps/web/src/components/anomalies/anomaly-display.ts`: "Primary Without Replicas".
- Correlator: optionally add `PRIMARY_WITHOUT_REPLICAS` as an optional metric on the `NODE_FAILOVER` rule (`correlator.ts:113-135`), so a roll's failover group shows the unsafe window.
- Prometheus gauge `betterdb_primary_synced_replicas{connection,shard}` (optional, cheap).

### Back-compat

New metric type and env vars only. No change to existing events. Users who don't want it set both thresholds to `0`.

## Acceptance criteria

- [ ] A primary that owns slots with `expectedReplicas ≥ 1` and `synced === 0` for ≥ 5 s produces exactly one `primary_without_replicas` WARNING for that shard, across all connections that observe it.
- [ ] The same condition lasting ≥ 30 s produces one CRITICAL escalation for that shard. With `aof_enabled:0`, `attached === 0` and persistence known to be off, the CRITICAL is raised at 5 s.
- [ ] The event resolves within 2 polls after a replica reports `state=online`.
- [ ] A node reporting `role:master` with **no slots** never produces this finding.
- [ ] A standalone instance or cluster shard that has never had a replica (`expectedReplicas === 0`) never produces this finding.
- [ ] State survives a failover in the shard and a change of the primary's IP/connection id (same slot set → same episode).
- [ ] In the harness `rollingUpdate` phase, the finding fires for every shard whose ground-truth zero-replica window is ≥ 5 s, and does not fire outside the roll.
- [ ] Unit tests cover all rules above. The new type is in `METRICS_HANDLED_OUTSIDE_EXTRACTOR` (the existing guard test passes).

## Test plan

**Unit (`__tests__/primary-without-replicas-detector.spec.ts`), with a fake clock and 1 s steps:**

| input sequence | expected |
|---|---|
| `role:master`, slots `0-5460`, `connected_slaves:2`, two `state=online` lines for 60 s | `expectedReplicas = 2`, no finding |
| then `connected_slaves:0` for 4 s | no finding |
| … 5th second | one WARNING, `value 0`, `baseline 2` |
| … to 30 s | one CRITICAL escalation, no repeat WARNING |
| then `connected_slaves:1`, `state=online` twice | resolved; next zero window starts a new episode |
| `connected_slaves:1` with `state=wait_bgsave` (attached, not synced) for 10 s | WARNING, message says "1 attached, 0 synced" |
| `role:master`, **no slots**, `connected_slaves:0` | never fires |
| standalone `role:master`, `connected_slaves:0` since start | never fires (`expected 0`) |
| expected 2, `aof_enabled:0`, persistence-off evidence, `attached 0` for 5 s | CRITICAL at 5 s |
| two connection ids reporting the same `(clusterKey, shardKey)` | one event |
| shard primary changes id (failover) with same slots while zero | same episode, no second WARNING |

**Harness repro** (needs Docker, kind, ~16 vCPU; targets in `benchmarks/operator-sim/Makefile`, settings in `benchmarks/operator-sim/config/sim.yaml`):

```bash
cd benchmarks/operator-sim
# point config/sim.yaml betterdb.imageTag at a build containing the detector
make up betterdb warm
PHASES=rollingUpdate make scenario
make report
```

What to look for:

- In `runs/<run>/betterdb.jsonl`, `primary_without_replicas` events (one per shard, 12 expected).
- In `runs/<run>/groundtruth.jsonl`, `connected_slaves` = 0 on `role:primary` samples. Each event should start ≤ 6 s after the ground-truth zero window opens and resolve after it closes.
- `SUMMARY.md` "Operator lifecycle observations" lists the same shards.
- Negative check: `make scenario` without the roll phase (`PHASES=spike,hotShard`) produces none.

## Out of scope / open questions

- **Determining "persistence off" with a minimal-ACL user.** `CONFIG GET save` may be denied. INFO only gives `aof_enabled`, `rdb_last_bgsave_status` and `rdb_changes_since_last_save`. Proposal: escalate early only on positive evidence. Is that enough?
- **Expected replica count from the deployment.** On Kubernetes the `ValkeyCluster.spec.replicas` field is authoritative, but BetterDB has no Kubernetes API access today (see the roll-awareness issue). The high-water mark is the portable fallback.
- **Multiple replicas expected but only one synced** (`synced < expected` but ≥ 1): useful as INFO-level "reduced redundancy"? Not proposed here.
- Fixing the operator behaviour is upstream: valkey-operator #552 / PR #562.

## References

- Harness: `benchmarks/operator-sim/` (branch `bench/operator-sim`), `FINDINGS.md` section "Operator roll: every shard briefly had no attached replica".
- Runs: `benchmarks/operator-sim/runs/2026-11-10T19-26-16-778-s42/SUMMARY.md`, `…/2026-11-10T19-54-07-874-s42/SUMMARY.md`, `…/2026-11-11T14-01-50-665-s42/SUMMARY.md`.
- valkey-operator: [#552](https://github.com/valkey-io/valkey-operator/issues/552) (open), [#563](https://github.com/valkey-io/valkey-operator/issues/563) (closed as duplicate of #552), [PR #562](https://github.com/valkey-io/valkey-operator/pull/562) (open).
- Code: `proprietary/anomaly-detection/types.ts:5-126`, `anomaly.service.ts:1429-1458`, `1660-1735`, `1984-2000`, `5053-5068`, `7203`, `7425-7456`, `failover-churn-detector.ts:68-83`, `apps/api/src/database/parsers/replication-info.parser.ts:28-44`.
- Related drafts: roll-aware alerting (08), cluster-wide de-duplication (09).
