# Emit cluster-scoped findings once per cluster, not once per monitored node

**Suggested labels:** `enhancement`, `anomaly-detection`, `cluster`, `webhooks`, `performance`  ·  **Area:** `proprietary/anomaly-detection`  ·  **Severity:** medium: one cluster condition becomes ~30 identical events and ~30 webhook deliveries. That buries real findings, inflates storage, and makes alert volume grow with cluster size.

> **Testing:** the harness used to find and reproduce this is on branch [`bench/operator-sim`](https://github.com/BetterDB-inc/monitor/tree/bench/operator-sim/benchmarks/operator-sim) (`benchmarks/operator-sim/`; start with its README). Raw run data (`runs/<id>/*.jsonl`) is not committed; re-run the commands in the test plan to regenerate it.

## Summary

When cluster nodes are auto-registered (`CLUSTER_AUTO_REGISTER_NODES=true`), every per-node connection runs the topology detectors against its own `CLUSTER NODES` view. Each connection then emits its own copy of a finding that describes the whole cluster. During one 36-pod operator roll, BetterDB stored **676** `cluster_topology` events in ~7 minutes. These were 22 distinct conditions (a specific replica stuck on a specific failed primary), each reported once by 30–32 different connections. The same happened in all four runs (676, 682, 678, 678). This issue proposes keying cluster-scoped detectors by cluster instead of by connection, so each condition becomes one event that lists the affected nodes and how many nodes observed it. It also proposes a correlator-level safety net for the rest.

## How we found it

The `benchmarks/operator-sim` harness in this repo (branch `bench/operator-sim`) runs a Valkey cluster on Kubernetes through a fault timeline and records every BetterDB event it sees.

- kind v0.33.0, Kubernetes v1.37.0, 1 control plane + 6 workers, one 16 vCPU / 62 GiB host.
- valkey-operator v0.8.0. A `ValkeyCluster` with 12 shards × (1 primary + 2 replicas) = 36 pods. Valkey 9.1.2 rolled to 9.1.3.
- BetterDB Monitor v0.55.0, `CLUSTER_AUTO_REGISTER_NODES=true`, `ANOMALY_POLL_INTERVAL_MS=1000`. The seed connection is the operator's headless Service, plus 36 auto-registered per-pod connections. Each pod restart gives the pod a new IP, so new child connections are registered with new ids, and **61** distinct connection ids emitted these events over a roll.
- Runs: `benchmarks/operator-sim/runs/2026-11-10T18-35-22-462-s42` (first full run), `…/2026-11-10T19-26-16-778-s42`, `…/2026-11-10T19-54-07-874-s42`, `…/2026-11-11T14-01-50-665-s42`.

## Observed behaviour

All `cluster_topology` events in all four runs are the stuck-replica WARNING (valkey#2090 detector):

```
WARNING: Replica 10.244.3.27:6379 (624da3cd) is stuck replicating a failed primary 56fd1e82 at 10.244.2.24:6379@16379 and has not re-attached to a live primary (valkey#2090). If a replacement node took over this shard, run `CLUSTER REPLICATE <new-primary-id>` on 10.244.3.27:6379 to recover.
```

| run | `cluster_topology` events | distinct (replica, primary) pairs | connections per pair | span |
|---|---|---|---|---|
| `2026-11-10T18-35-22-462-s42` | 676 | 22 | 30–32 | 421.6 s |
| `2026-11-10T19-26-16-778-s42` | 682 | 22 | 30–32 | 433.4 s |
| `2026-11-10T19-54-07-874-s42` | 678 | 22 | 30–31 | 390.0 s |
| `2026-11-11T14-01-50-665-s42` | 678 | 22 | 30–32 | 423.1 s |

In every run, each connection emitted each pair **exactly once**, so per-connection dedupe works as designed. The multiplication comes entirely from the number of connections. The copies land almost together: in the final run, all ~31 copies of a pair arrived within 0.1 s for most pairs and within 20.7 s at worst. The events arrive in bursts of ~62 per shard (two replicas × ~31 observers), one shard after another as the roll progresses. All 678 events carried the same `scopeId` (the seed connection).

Per-minute counts in the final run: 126, 62, 122, 62, 124, 62, 60, 60.

Every stored event also goes out as an `anomaly.detected` webhook delivery, and counts toward the Prometheus anomaly counter.

The same per-connection structure applies to the other cluster-wide signals (see Root cause). For example, in the final run 8 connections each raised "CRITICAL: Cluster state changed from ok to fail — slots may be uncovered" at the same second (122.5 s into the roll), and each raised its own recovery 6.5 s later.

(Separately: these 22 warnings name the replicas and primaries by their pre-roll IP addresses, and each condition cleared within the roll. Whether they should fire at all during a planned roll is covered by the roll-awareness issue. This issue is about the 30× multiplication.)

## Expected behaviour

One condition in a cluster → one event, with:

- the affected node(s) (`nodeAddr` / ids in the message and a structured list);
- how many monitored nodes observed it (`observedBy: 31 of 37`), and which ones when the list is short;
- one webhook delivery, and one resolve when the condition clears in all views.

The per-node Anomalies view still shows the event for the nodes it affects.

## Root cause

**Topology detectors run once per connection, on that connection's view.** In `proprietary/anomaly-detection/anomaly.service.ts:1994-2010`, inside `pollConnection` (called for every registered connection):

```ts
if (!isRaft && nodes) {
  await this.detectDuplicatePrimaries(ctx, timestamp, nodes);
  await this.detectStuckReplicas(ctx, timestamp, nodes);
  await this.detectHostnameStaleness(ctx, timestamp, nodes, shards);
  await this.detectGhostMembers(ctx, timestamp, nodes);
  await this.detectForgetRejoin(ctx, timestamp, nodes);
  await this.detectFailoverChurn(ctx, timestamp, nodes);
  ...
  await this.detectReplicaSlotState(ctx, timestamp, perNodeView.nodes, shards, perNodeView.unreachableIds);
}
```

**Their dedupe and persistence state is keyed by connection.** `detectStuckReplicas` (`anomaly.service.ts:6456-6500`) goes through `applyTopologyPersistenceGate` (`anomaly.service.ts:7203`). There, `firstSeenByConn`, `activeByConn` and `eventIdsByConn` are all `Map<connectionId, …>`:

```ts
const connId = ctx.connectionId;
const firstSeen = firstSeenByConn.get(connId) ?? new Map<string, number>();
const active = this.connectionClaims(activeByConn, connId, () => new Set<string>());
```

The latch is also per connection: `addLatchedAnomaly(event, eventCtx, \`${connId}:${signature}\`, …)` → `const latch = \`${anomaly.metricType}:${scope}\`` (`anomaly.service.ts:7645`). With N connections viewing the same cluster, the same signature passes the 30 s gate (`STUCK_REPLICA_MIN_PERSIST_MS`, `anomaly.service.ts:6096`) N times. `detectDuplicatePrimaries` (`anomaly.service.ts:6018-6080`, per-connection `activeTopologyConflicts`) and `detectFailoverChurn` (`anomaly.service.ts:7425-7456`, `failoverChurnState` per connection) have the same structure. Cluster state transitions (`anomaly.service.ts:1896-1925`) are tracked per connection in `lastClusterState`.

**Downstream does not collapse them.**

- Every first save dispatches a webhook (`anomaly.service.ts:7683-7701` → `proprietary/webhook-pro/webhook-anomaly-integration.service.ts:27-30` → `dispatchAnomalyDetected`). The webhook dispatcher has no dedupe for `anomaly.detected`; its alert-state hysteresis is for threshold alerts only.
- The correlator does partition by cluster scope (`correlator.ts:434-450`; the scope resolver is `correlationScopeOf`, `anomaly.service.ts:1024-1025`, `7920-7935`), so the copies can share a correlated group. But the 676 raw events are still stored, listed and delivered individually.

**What already exists to build on.**

- `clusterKey` per connection (`connectionClusterKeys`, `anomaly.service.ts:686`; `rememberClusterKey`, `:7875-7888`).
- The seed/scope id stamped on every event (`stamp` → `scopeId`, `anomaly.service.ts:7608-7610`).
- Reshard-pressure state that is already shared across connections by `clusterKey` (`detectReshardPressure`, `anomaly.service.ts:6098-6180`), as a precedent.

## Proposed change

### A. Cluster-keyed state for cluster-scoped detectors (primary fix)

1. Declare scope per metric/detector: `CLUSTER_SCOPED_DETECTORS = { stuckReplica, duplicatePrimary, ghostMember, forgetRejoin, hostnameStaleness, failoverChurn, replicaSlotState, clusterViewDisagreement (proposed) }`.
2. Generalise `applyTopologyPersistenceGate` with `scopeKey: string`, defaulting to `ctx.connectionId`. Cluster-scoped callers pass `clusterScopeKey(ctx) = this.connectionClusterKeys.get(ctx.connectionId) ?? ctx.connectionId`.
   - `firstSeen` per `(scopeKey, signature)` = earliest observation by any connection.
   - New `observers: Map<scopeKey, Map<signature, Map<connectionId, lastSeenAt>>>`.
   - Emit once per `(scopeKey, signature)`. The latch key becomes `${metricType}:${scopeKey}:${signature}`.
   - The event's `connectionId` is the seed/scope connection (`seedIdOf` / `correlationScopeOf`), and `nodeAddr` is the affected node.
3. **Recovery.** A signature is resolved when no observer has reported it for `2 × poll interval` while at least one observer has polled successfully in that time. A signature from an observer that is unreachable is preserved, as `preserveSignature` does today.
4. **Optional quorum**, `ANOMALY_CLUSTER_FINDING_MIN_OBSERVERS` (default **1**, keeps today's sensitivity). Raising it requires several nodes' views to agree before alerting, which filters single-node gossip lag.
5. **Payload.** Add to `AnomalyEvent` / `StoredAnomalyEvent`:
   ```ts
   scope?: 'node' | 'cluster';
   affectedNodes?: Array<{ id: string; addr: string }>;
   observedBy?: { count: number; total: number; sample: string[] }; // sample ≤ 10 addresses
   ```
   Persist as nullable JSON columns (SQLite/Postgres migration). Mention the count in the message: "… (seen by 31 of 37 monitored nodes)".
6. **Node-local signals that mean something cluster-wide** (`cluster_state` transitions): keep per-node detection, but aggregate at emit time. If ≥ 2 connections in one cluster flip `ok → fail` within `ANOMALY_CLUSTER_AGGREGATE_WINDOW_MS` (default 5000), emit one cluster event, "cluster_state fail on 8 of 36 nodes", with `affectedNodes`, and one matching recovery.

### B. Safety net in `addAnomaly` (covers detectors not yet migrated)

Add an optional `dedupeKey` on `AnomalyEvent`. In `addAnomaly` (`anomaly.service.ts:7613`): if an **unresolved** event with the same `(scopeId, metricType, dedupeKey)` exists in `recentAnomalies`, record the extra observer on it (update `observedBy`, no new row, no new webhook) instead of storing a new event. Detectors opt in by setting `dedupeKey`. Default unset, so behaviour is unchanged.

### Webhooks and integrations

- One `anomaly.detected` per cluster finding. The payload gains `scope`, `affectedNodes` and `observedBy`. This is additive: consumers that ignore unknown fields are unaffected.
- Consumers that counted per-node events will see fewer. Call this out in release notes.
- `ANOMALY_CLUSTER_DEDUPE=false` restores per-connection emission for one release as an escape hatch.
- OTLP/Prometheus counters increment once per cluster finding.

### UI

- The Anomalies page for a child connection includes cluster-scoped events whose `affectedNodes` contains that node, so per-node drill-down keeps working.
- The event card shows "Seen by 31 of 37 nodes" with an expandable list.

## Acceptance criteria

- [ ] For a cluster monitored through a seed plus N auto-registered node connections, one stuck-replica condition (same replica id, same primary id) produces exactly **one** stored event and **one** `anomaly.detected` delivery, independent of N.
- [ ] That event lists the replica in `affectedNodes` and `observedBy.count` equal to the number of connections that saw it.
- [ ] The event resolves once no connection reports the condition for 2 polls. A connection that disappears mid-episode (pod IP change) neither resolves nor duplicates it.
- [ ] The same holds for duplicate-primary, ghost-membership, hostname-staleness, failover-churn and replica-slot-state findings (one test each).
- [ ] Simultaneous `cluster_state` `ok → fail` on ≥ 2 nodes within 5 s produces one cluster event plus one recovery.
- [ ] Harness `rollingUpdate`: `cluster_topology` events ≤ number of distinct (replica, primary) pairs (22 in the reference runs), down from 676–682.
- [ ] `ANOMALY_CLUSTER_DEDUPE=false` reproduces today's per-connection behaviour (existing tests pass unchanged with the flag off).

## Test plan

**Unit (`anomaly.service.spec.ts` / new `cluster-scoped-findings.spec.ts`):**

- Register 3 connections with the same `clusterKey`. Feed each the same `CLUSTER NODES` snapshot in which replica `r1` points at primary `p1` flagged `fail`. Advance 31 s with 1 s polls. Expect: 1 event, `observedBy.count === 3`, webhook sink called once.
- Connection 2 is removed mid-episode and connection 4 is added with the same view → still 1 event, `observedBy` updated, no resolve.
- All 3 views stop showing the pair → resolved after 2 polls. Re-appears → new event.
- 2 connections in **different** clusters with the same signature → 2 events.
- `cluster_state`: 8 connections flip to `fail` within 1 s → 1 event with 8 `affectedNodes`. All recover → 1 recovery.
- Flag off → 3 events (today's behaviour).

**Harness:**

```bash
cd benchmarks/operator-sim
# config/sim.yaml: betterdb.imageTag → build with the change
make up betterdb warm
PHASES=rollingUpdate make scenario
make report
python3 - <<'EOF'
import json, collections, glob
run = sorted(glob.glob('runs/*-s42'))[-1]
ev = [json.loads(l) for l in open(run + '/betterdb.jsonl')]
t = [e['payload'] for e in ev if e['kind'] == 'event' and e['payload']['metricType'] == 'cluster_topology']
print(len(t), collections.Counter(p.get('scope') for p in t))
EOF
```

Expect ≤ 22 `cluster_topology` events, each with `scope: 'cluster'` and `observedBy.count` around 30, instead of ~678. The `SUMMARY.md` "Unmatched detections by metric" line should no longer show `cluster_topology 676`.

## Out of scope / open questions

- Whether the stuck-replica warnings should fire during a planned roll at all (roll-awareness issue), and why they name pre-roll addresses (per-node identity across IP changes, tracked separately).
- Seed-only deployments (no auto-registration) are unaffected today, since only one connection polls. The change must not alter their behaviour.
- Agent connections (`connectionType: 'agent'`) that see only one node: should they count as observers? Proposed: yes, as long as they share the `clusterKey`.
- Should the event be attributed to the seed connection or to the "most affected" node connection? Proposed: the seed (stable id), with `nodeAddr` for the node.

## References

- Harness: `benchmarks/operator-sim/` (branch `bench/operator-sim`), `FINDINGS.md` ("BetterDB emitted 676 cluster_topology events … across 37 connections").
- Runs: `benchmarks/operator-sim/runs/2026-11-10T18-35-22-462-s42/SUMMARY.md` ("cluster_topology ×676"), plus the other three runs listed above.
- Code: `proprietary/anomaly-detection/anomaly.service.ts:686`, `1024-1025`, `1896-1925`, `1994-2010`, `6018-6080`, `6096`, `6098-6180`, `6456-6500`, `7203-7300`, `7425-7456`, `7608-7613`, `7645`, `7683-7701`, `7875-7888`, `7920-7935`; `correlator.ts:434-450`; `proprietary/webhook-pro/webhook-anomaly-integration.service.ts:27-30`; `stuck-replica-detector.ts:67-98`.
- Related issues: roll-aware alerting (#716), stale role view detector (#715), primary without replicas (#714).
