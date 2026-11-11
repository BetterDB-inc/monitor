# Make alerting aware of planned rolling updates and add maintenance windows

**Suggested labels:** `enhancement`, `anomaly-detection`, `webhooks`, `kubernetes`, `web`  ·  **Area:** `proprietary/anomaly-detection`, `apps/api/src/settings`, `apps/web`, `charts/betterdb-monitor`  ·  **Severity:** medium: every routine operator roll pages as CRITICAL, which trains on-call to ignore the role and failover alerts that matter during a real incident.

> **Testing:** the harness used to find and reproduce this is on branch [`bench/operator-sim`](https://github.com/BetterDB-inc/monitor/tree/bench/operator-sim/benchmarks/operator-sim) (`benchmarks/operator-sim/`; start with its README). Raw run data (`runs/<id>/*.jsonl`) is not committed; re-run the commands in the test plan to regenerate it.

## Summary

A planned Kubernetes operator rolling update (image or config change) restarts every pod and fails over every shard on purpose. BetterDB reports each step as a potential incident. In one 36-pod roll it raised 7 CRITICAL "Node role changed from master to replica — possible failover or split-brain detected", 12 CRITICAL `node_failover` groups and 13 CRITICAL `cluster_state` transitions, plus 678 stuck-replica WARNINGs. v0.55.0 has no maintenance window, no silence, and no knowledge that a roll is in progress. `PATCH /api/settings/anomaly/detectors` only changes thresholds. This issue proposes (1) a generic maintenance-window / silence API and UI, (2) automatic roll detection, through the Kubernetes API when BetterDB is given read access and through a topology heuristic otherwise, and (3) a policy that **downgrades** expected roll noise instead of hiding it, while keeping full severity for states that are unsafe during a roll.

## How we found it

The `benchmarks/operator-sim` harness in this repo (branch `bench/operator-sim`) runs a Valkey cluster on Kubernetes through a fault timeline. One phase is `rollingUpdate`: it patches the `ValkeyCluster` image and lets the operator roll.

- kind v0.33.0, Kubernetes v1.37.0, 1 control plane + 6 workers, one 16 vCPU / 62 GiB host.
- valkey-operator v0.8.0. A `ValkeyCluster` with 12 shards × (1 primary + 2 replicas) = 36 pods, no persistence. Valkey 9.1.2 → 9.1.3.
- The operator rolls one shard at a time: both replicas, then a failover onto a rolled replica, then the old primary. A roll takes 489–527 s.
- BetterDB Monitor v0.55.0, 1 s anomaly poll. The seed connection is the operator's headless Service, plus 36 auto-registered per-pod connections.
- Runs: `benchmarks/operator-sim/runs/2026-11-10T19-26-16-778-s42` (roll-only control), `…/2026-11-10T19-54-07-874-s42`, `…/2026-11-11T14-01-50-665-s42` (final full run), `…/2026-11-10T18-35-22-462-s42` (first full run).

## Observed behaviour

Findings inside the roll window (from the patch to 60 s after the operator reports Ready), by run:

| run | `replication_role` | `node_failover` groups | `cluster_state` | `cluster_topology` (stuck replica) |
|---|---|---|---|---|
| `2026-11-10T19-26-16-778-s42` (control) | 7 CRITICAL, 2 WARNING | 7 CRITICAL, 1 WARNING | none | 682 WARNING |
| `2026-11-10T19-54-07-874-s42` | 6 CRITICAL, 3 WARNING | 10 CRITICAL, 8 WARNING | 14 CRITICAL, 15 WARNING | 678 WARNING |
| `2026-11-11T14-01-50-665-s42` | 7 CRITICAL, 2 WARNING | 12 CRITICAL, 4 WARNING | 13 CRITICAL, 14 WARNING | 678 WARNING |
| `2026-11-10T18-35-22-462-s42` (the phase lost its start marker, so these are whole-run counts of findings that matched no injection) | 9 | 14 | 14 | 676 WARNING |

Example messages (final run, seconds from the patch):

```
 38.8  CRITICAL  replication_role  CRITICAL: Node role changed from master to replica — possible failover or split-brain detected
 81.4  CRITICAL  replication_role  (valkey-bz-1-1-0) same message
122.5  CRITICAL  cluster_state     CRITICAL: Cluster state changed from ok to fail — slots may be uncovered   (8 nodes at once)
129.0  WARNING   cluster_state     WARNING: Cluster state recovered from fail to ok                           (same 8 nodes, 6.5 s later)
177.2  WARNING   replication_role  WARNING: Node promoted from replica to master — failover completed
group  CRITICAL  node_failover     Node failover detected — this instance transitioned role
group  CRITICAL  node_failover     Node failover detected with correlated slowlog spike — the slow queries are likely caused by the failover transition
```

Each `replication_role` event also fires the `failover.started` / `failover.completed` webhooks. Every stored anomaly also goes out as `anomaly.detected`. Only 7 of the 12 demotions were seen, because each restarted pod gets a new IP and a new BetterDB connection id, and the per-connection "last role" is lost (tracked separately).

Not all of this is noise. During the same rolls every shard spent 6–37 s with **no replica attached to its primary** (tracked in #714). Some nodes really did report `cluster_state:fail` for ~6.5 s. A useful roll-aware mode must quiet the expected steps and keep those signals loud.

## Expected behaviour

- An operator can declare a maintenance window for a connection or a whole cluster ahead of time, through UI or API, and BetterDB can open one automatically when it recognises an operator roll.
- During the window, expected roll events are still recorded but are shown and delivered at reduced severity: a role change on a node that the roll restarted, failovers onto a synced replica, short `cluster_state` blips, and stuck-replica warnings that clear within the roll. Each is tagged "during planned maintenance: <reason>".
- Unsafe states keep their full severity and still page: a primary with no synced replica, two primaries for one slot range, data-loss signals, failover churn, a `cluster_state:fail` that outlasts a short grace period, anything still open after the roll ends.
- Health gates that read role-change history keep working, so events are not dropped.

## Root cause

- Role changes are edge-triggered with a fixed severity. `proprietary/anomaly-detection/anomaly.service.ts:1660-1750`: a master→replica flip emits `severity: AnomalySeverity.CRITICAL` (`:1679`) with the "possible failover or split-brain" message, and calls `webhookEventsProService.dispatchFailoverStarted` (`:1700`). A replica→master flip emits WARNING (`:1718`) and `dispatchFailoverCompleted` (`:1736`). No context is consulted.
- Cluster-state transitions: `anomaly.service.ts:1896-1925` emits CRITICAL on `ok → fail` and WARNING on recovery, per connection.
- The correlator turns any window containing `replication_role` or `cluster_state` into a `NODE_FAILOVER` group (`proprietary/anomaly-detection/correlator.ts:113-146`). The group severity is the maximum of its members (`correlator.ts:565-585`).
- Every first save of an anomaly dispatches `anomaly.detected` (`anomaly.service.ts:7683-7701` → `proprietary/webhook-pro/webhook-anomaly-integration.service.ts:27-30`). There is no silence hook.
- Settings: `PATCH /settings/anomaly/detectors` (`apps/api/src/settings/settings.controller.ts:95-114`) updates per-metric thresholds only. There is no window, silence or mute entity anywhere in `apps/api/src` or `proprietary/` (searched for `silence`, `maintenance`, `snooze`, `mute`).
- BetterDB has **no Kubernetes API access** today. `@kubernetes/client-node` is used only by the cloud provisioning service (`proprietary/entitlement/src/provisioning/provisioning.service.ts:7`), not by the monitor. The Helm chart (`charts/betterdb-monitor/templates/`) has no ServiceAccount, Role or RoleBinding.
- Consumer to keep working: `apps/api/src/monitor/health-gate.service.ts:117-128` counts stored `replication_role` events in a recent window to decide `failoverInProgress`. Dropping events during a roll would make this gate think no failover is happening.

What the operator exposes (valkey-operator v0.8.0, `api/v1alpha1/valkeycluster_types.go`):

- `ValkeyCluster.status.state` ∈ `Initializing | Reconciling | Ready | Degraded | Failed`.
- `ValkeyCluster.status.reason`, for example `UpdatingNodes`, `Reconciling`, `PrimaryLost`, `MissingReplicas`.
- `ValkeyCluster.status.conditions[]`, including `Progressing` (each with `observedGeneration`).
- `ValkeyNode.spec.workloadRevision`, the pod-template hash the cluster controller has authorised, and `ValkeyNode.status.observedGeneration`.

There is **no** top-level `ValkeyCluster.status.observedGeneration` in v0.8.0. Generic StatefulSet signals also exist: `status.currentRevision != status.updateRevision` and `status.updatedReplicas < status.replicas`.

## Proposed change

### 1. Maintenance windows (generic, works without Kubernetes)

**Entity** `MaintenanceWindow`, persisted through `StoragePort` (memory, SQLite and Postgres adapters):

```ts
interface MaintenanceWindow {
  id: string;
  scope: { kind: 'connection' | 'cluster' | 'all'; id?: string };   // cluster = seed connection id / correlation scope
  startsAt: number; endsAt: number;                                  // endsAt required; max 24 h (configurable)
  mode: 'downgrade' | 'suppress';                                    // default 'downgrade'
  metricTypes?: MetricType[];                                        // default: the roll-expected set below
  reason: string;
  source: 'user' | 'api' | 'auto:k8s' | 'auto:heuristic';
  createdBy?: string; createdAt: number; endedEarlyAt?: number;
}
```

**API** (license-gated like the detector settings, `@RequiresFeature(Feature.ANOMALY_DETECTION)`):

- `POST /api/maintenance-windows`: create. Body as above, or `{ scope, durationMs, reason }`.
- `GET /api/maintenance-windows?active=true`.
- `DELETE /api/maintenance-windows/:id`: end early.
- An MCP tool with the same semantics, so CI/CD can open a window before `kubectl patch` and close it after.

**UI.**

- Settings → "Maintenance windows": list, create, end.
- Anomalies page and Cluster page: "Start maintenance (30 min)" quick action, plus a banner while a window is active ("Planned maintenance: image roll 9.1.2 → 9.1.3, auto-detected from ValkeyCluster bz, started 14:30:55").
- Events raised during a window show a "maintenance" badge with the original severity on hover.

### 2. Automatic roll detection

**2a. Kubernetes (opt-in).**

- `BETTERDB_K8S_ROLL_AWARENESS=true` enables an in-cluster client (`@kubernetes/client-node`, already a dependency in the monorepo).
- Per connection, an optional `kubernetesRef: { kind: 'ValkeyCluster' | 'StatefulSet', namespace, name }` is set in connection settings, or auto-suggested when the seed host is `<svc>.<ns>.svc.cluster.local` and a `ValkeyCluster` with a matching Service exists.
- Watch (or poll every 5 s) the referenced object. A roll is in progress while any of these hold:
  - `status.state == 'Reconciling'` with `status.reason == 'UpdatingNodes'`;
  - condition `Progressing=True`;
  - any `ValkeyNode` whose `spec.workloadRevision` differs from the current pod-template hash;
  - for a StatefulSet, `currentRevision != updateRevision`.
- Open an `auto:k8s` window when the roll starts. Close it 60 s after the object is `Ready` again (configurable `ANOMALY_ROLL_SETTLE_MS`, default 60000).
- Chart: `rbac.create` (default false) renders a ServiceAccount + Role with `get/list/watch` on `valkeyclusters.valkey.io`, `valkeynodes.valkey.io` and `apps/statefulsets` in the configured namespaces.

**2b. Heuristic (default on, no Kubernetes access needed)**, `ANOMALY_ROLL_HEURISTIC=true`. Per cluster (`clusterKey`), infer "rolling restart in progress" when within `ANOMALY_ROLL_HEURISTIC_WINDOW_MS` (default 120000):

- ≥ 2 nodes restarted one after another: `uptime_in_seconds` reset, `run_id` changed, or a new node id appeared in place of a departed one. Without persistence, a replaced pod comes back with a new IP and a new node id.
- At most one shard has a restarted or not-yet-synced node at any time.
- Every failover promoted a replica that was in sync at promotion time. Judge this from fresh state (the old primary's `INFO replication` `slaveN:…state=online` line, or the promoted node's own offsets at promotion), not from a periodically sampled `master_link_status`: in our final run, 7 of the 13 promotions during the roll had a last 5 s-sampled `master_link_status` of `down` / `master_sync_in_progress:1` about 5 s before promotion. 5 s sampling cannot tell whether those replicas finished syncing in between, so a stale-sample rule would wrongly classify a normal roll as unsafe.
- No more than one node per shard down at a time.

Open an `auto:heuristic` window scoped to the cluster. Close it after `ANOMALY_ROLL_SETTLE_MS` with no further restarts. If any condition is violated (two nodes of a shard down, a failover onto an unsynced replica, `cluster_state:fail` > grace), close the window immediately and raise the suppressed findings at full severity again. The heuristic is a best effort; the Kubernetes signal or an explicit window is authoritative.

### 3. Policy: downgrade vs suppress, and what never gets quieter

Default mode is **downgrade**. Events are stored with the original severity in `originalSeverity`, the effective severity set to `info`, and `maintenanceWindowId` set. The UI and correlator use the effective severity. `HealthGateService` keeps counting them, because it counts by metric type, not severity.

**Suppress** mode, opt-in per window, stores the event as resolved immediately and skips webhook and OTLP delivery. It is meant for user-declared windows only; auto-detected windows never use suppress.

Roll-expected set (affected by a window):

| finding | inside a window |
|---|---|
| `replication_role` (demotion or promotion) on a node the roll restarted or failed over | → info. `failover.*` webhooks carry `"maintenance": true` and are skipped for webhooks that opt out (`skipDuringMaintenance`, default true). |
| `node_failover` groups made only of the above | → info |
| `cluster_state` `ok → fail` that recovers within `ANOMALY_ROLL_CLUSTER_STATE_GRACE_MS` (default 15000; observed 6.5 s) | → warning. Stays CRITICAL if not recovered by then. |
| `cluster_topology` stuck-replica warnings that clear before the window closes | → info |
| z-score findings on nodes restarted < 5 min ago (fresh baselines) | → info |

Never downgraded, at full severity regardless of window:

- `primary_without_replicas` (proposed in the companion issue);
- duplicate primaries / split-brain (`cluster_topology` CRITICAL from `duplicate-primary-detector`);
- data-loss rules (`anomaly.service.ts:1753`);
- `failover_churn`;
- `ghost_membership`;
- `cluster_view_disagreement` (companion issue) still open after the window closes;
- anything not in the roll-expected set.

Implementation sketch: a `MaintenanceService` with `effectiveSeverity(event, ctx): { severity, windowId?, mode? }`, called in `AnomalyService.addAnomaly` (`anomaly.service.ts:7613`) before `stamp`/persist, and in `Correlator.createGroup` (`correlator.ts:565-585`) for group severity. Webhook dispatch (`anomaly.service.ts:7698`, `:1700`, `:1736`) checks `mode` and the per-webhook opt-out.

### Back-compat

- No windows → identical behaviour to today. Heuristic auto-windows only downgrade the listed roll-expected events. They can be disabled with `ANOMALY_ROLL_HEURISTIC=false`.
- New nullable columns on anomaly events: `original_severity`, `maintenance_window_id`. Migration for SQLite and Postgres.
- Webhook payloads gain an optional `maintenance` object. Existing consumers ignore unknown fields.

## Acceptance criteria

- [ ] `POST/GET/DELETE /api/maintenance-windows` exist, are validated (endsAt > startsAt, max duration), persisted, and survive a restart.
- [ ] With a window active on a cluster, a master→replica role change on one of its nodes is stored with `severity: info`, `originalSeverity: critical`, `maintenanceWindowId` set. The `failover.started` webhook is not delivered to webhooks with `skipDuringMaintenance: true`.
- [ ] `HealthGateService` still reports `failoverInProgress: true` during a window when a role change happened.
- [ ] Inside a window, a `primary_without_replicas` or duplicate-primary finding is delivered at its normal severity.
- [ ] A `cluster_state:fail` lasting > 15 s inside a window is CRITICAL. One recovering in 6.5 s is WARNING.
- [ ] With `BETTERDB_K8S_ROLL_AWARENESS=true` and RBAC, patching `ValkeyCluster.spec.image` opens an `auto:k8s` window within 10 s, and the window closes ≤ 60 s after `status.state == Ready`.
- [ ] Without Kubernetes access, the harness `rollingUpdate` phase opens an `auto:heuristic` window before the second shard's failover. Killing a primary outside a roll (`primaryKill` phase) does **not** open one.
- [ ] UI: banner during an active window, badge on downgraded events, create/end from Settings.

## Test plan

**Unit.**

- `MaintenanceService.effectiveSeverity`: table-driven. `(replication_role, critical, window downgrade)` → info. `(primary_without_replicas, critical, window)` → critical. `(cluster_state fail, recovered at 6.5 s, window)` → warning. `(cluster_state fail, open at 15 s)` → critical. No window → unchanged.
- Correlator: a group of only downgraded `replication_role` events → group severity info. The same group plus a full-severity member → that member's severity.
- Heuristic: a synthetic per-node sequence of uptime resets, one node at a time with synced failovers → window opens. Two nodes of one shard down simultaneously → no window, or the window closes with re-escalation.
- Kubernetes watcher with a fake API: `Reconciling/UpdatingNodes` → open. `Ready` + 60 s → close.

**Harness.**

```bash
cd benchmarks/operator-sim
make up betterdb warm
PHASES=rollingUpdate make scenario
make report
```

Compare `runs/<run>/betterdb.jsonl` against the baseline table above: `replication_role` / `node_failover` CRITICAL counts inside the roll should drop to 0 (now info, tagged with a window id). `primary_without_replicas` (if 06 has landed) stays WARNING/CRITICAL. `SUMMARY.md` still shows the roll as detected. Then run `PHASES=primaryKill make scenario`: its failover must still be CRITICAL/WARNING, with no window opened. For the Kubernetes path, install BetterDB with `rbac.create=true` (set in the harness Helm values under `config/sim.yaml` → `betterdb`) and `BETTERDB_K8S_ROLL_AWARENESS=true`. The `events.jsonl` `rollingUpdate` start/end timestamps should bracket the window's open/close within 10 s and 60 s respectively.

## Out of scope / open questions

- Scheduled or recurring windows (cron), and approval flows. Start with ad-hoc windows.
- Whether auto windows should be on by default for the heuristic path. Proposed: on, downgrade only.
- Mapping a BetterDB connection to a `ValkeyCluster` automatically when the seed is not the operator's Service.
- Per-connection identity breaking on pod IP change (role history lost for restarted pods) is tracked in #718. It undercounts role changes today (7 of 12 seen).

## References

- Harness: `benchmarks/operator-sim/` (branch `bench/operator-sim`), `FINDINGS.md`. Runs `2026-11-10T19-26-16-778-s42`, `2026-11-10T19-54-07-874-s42`, `2026-11-11T14-01-50-665-s42` (`SUMMARY.md` committed; raw JSONL gitignored).
- Code: `proprietary/anomaly-detection/anomaly.service.ts:1660-1750`, `1896-1925`, `7613`, `7683-7701`; `correlator.ts:113-146`, `565-585`; `proprietary/webhook-pro/webhook-anomaly-integration.service.ts:27-30`; `apps/api/src/settings/settings.controller.ts:95-114`; `apps/api/src/monitor/health-gate.service.ts:117-128`; `charts/betterdb-monitor/templates/`.
- valkey-operator v0.8.0 `api/v1alpha1/valkeycluster_types.go` (`ClusterState`, `Reason*` constants), `api/v1alpha1/valkeynode_types.go` (`WorkloadRevision`).
- Related issues: primary without replicas (#714), stale role view (#715), cluster-wide de-duplication (#717).
