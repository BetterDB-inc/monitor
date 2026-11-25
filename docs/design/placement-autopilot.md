---
title: Placement autopilot design
layout: default
nav_exclude: true
---

# Placement autopilot: design (issue #722)

**My call** marks a choice made here without a ruling, **Agreed in review** an answer from the review on this issue, and **Decided** a decision on the remaining points. The review's answers to the last open questions are at the end.

## 1. What already exists

Hot shard detection (#694), the rebalance planner and running a plan from the Anomalies page (#695) already ship. So do the slot migration events (#734), the detectors that carry the failing node, the incident timeline and the activity log. The autopilot is mostly a controller around them: per-connection mode and policy, persistent actions with a cluster lock, a gate from existing detectors, slow load averages for hysteresis, and verification with rollback.

## 2. Concepts

### 2.1 Modes (per connection)

| Mode | Plans computed | Shown | Runs |
| --- | --- | --- | --- |
| Observe | No plan table (only the balance read-out) | Per-shard load and imbalance, `key_level` explanations, hash-tag advice | Nothing |
| Recommend | Yes | Plan, projected per-shard load after the move, why the policy would or would not allow it | Nothing on its own. Commands stay copyable, and the #695 run button stays, as today |
| Approve | Yes, as pending **actions** | As Recommend, plus Approve / Reject | On explicit approval (UI or MCP), by a signed-in admin |
| Auto | Yes | As Approve | Without approval, only when every policy rule allows it |

- **Default.** A new connection starts in Observe (acceptance criterion 2). Existing cluster connections move to Recommend in the phase 1 migration, keeping today's plans and #695 run button. Recommend writes nothing. **Agreed in review.**
- **MCP.** `get_hot_shards` keeps its shape and keeps returning `rebalance` in every mode: it is a read the caller asked for, and Observe only changes what the UI pushes. **Agreed in review.**
- **Tier.** Observe and Recommend stay on Pro (the anomaly module), Approve is Pro (the run button is already there), Auto is Enterprise. **Agreed in review.**
- **Durable storage.** Approve and Auto need `sqlite`, `turso` or `postgres`. With `STORAGE_TYPE=memory` a restart loses actions, budget, cooldown history and lock, so the mode selector stops at Recommend with the support reason `memory_storage` (2.8).
- **One owner per cluster.** The mode belongs to the connection that reads the whole cluster (the seed). Member connections created by auto-registration show the seed's mode. When a cluster is added twice (two seeds with overlapping node ids), only one can be in Approve or Auto; the other is limited to Observe and Recommend and shows "Placement is managed by connection <name>". **My call.**
- **Env flags.** `BETTERDB_SLOT_MIGRATION` stays the install-wide master switch for any write. With it off, Approve and Auto can't be selected and read as `flag_off`. A second flag, `BETTERDB_PLACEMENT_AUTO`, defaults to **false**: Auto is opt-in per install and per connection, so an install that enabled the #695 button doesn't find Auto selectable after an upgrade.
- **Installs without sign-in.** With `WORKSPACE_DISABLED=true` there is no user and no role check. From phase 3 the #695 run button creates an approved action, so it and Approve follow one rule: every write (run button, Approve, Reject, Cancel, Rollback) is recorded with an anonymous actor (`actor_via = 'anonymous'`, `actor_user_id = 'anonymous'`, the request IP). Approve is allowed on that basis; Auto is not, since its opt-in must name a person. Today's button is kept. **Decided.** Cloud mode must be checked in phase 3: if it has signed-in users with roles, it is treated like self-hosted.
- **Auto opt-in.** An admin picks Auto, the dialog states the policy and the budgets, and the admin types the connection name. The opt-in is stored with who, when and the policy version. It is cleared, and the mode drops to Approve (with a notice and a webhook), when:
  - the connection's host or port changes;
  - the support verdict turns unsupported;
  - two actions in 24 h are rolled back or end `ineffective` (circuit breaker, 2.7);
  - an admin presses **Pause**;
  - any policy change loosens a rule (2.2). Tightening keeps Auto.

  **My call.** Separately, Auto **pauses** (as if an admin pressed Pause, with the `system` actor, a notice and a webhook) when it sees a migration job that isn't ours, from another monitor or tool. An admin resumes it. **Agreed in review.**
- Changing the mode or policy, approving, rejecting, cancelling, rolling back and pausing need the admin role. Members see everything read-only.

### 2.2 Policy (operator-set, per connection)

Stored as one `PlacementPolicy` document per connection. It feeds the existing `RebalancePolicy` for the planner, plus new gate fields. The defaults are **Decided**. They are starting values, not measured.

| Field | Default | Loosens when | Used by |
| --- | --- | --- | --- |
| `triggerRatio` | 2.0 (same as `hot_shard`) | lowered | Gate: a shard over this ratio to the median, sustained, is a candidate |
| `maxCpuShare` | none | set or lowered | Gate: a shard over this share of cluster slot CPU is a candidate even below `triggerRatio` (below) |
| `maxNetworkShare` | none | — | Shown and advised only in v1 (see below) |
| `nodeCpuLimitUsecPerSecond` | 800,000 | raised | Planner (exists) |
| `resolveRatio` | 1.25 | raised | Planner (exists) |
| `sustainMinutes` | 30 | lowered | Hysteresis (2.4) |
| `slotCooldownDays` | 7 | lowered | Hysteresis: a moved slot doesn't move again, except for rollback |
| `noReturnDays` | 7 | lowered | Hysteresis: a slot doesn't go back to a shard it left, except for rollback |
| `maxMigrationsPerHour` | 4 (2 in Auto) | raised | Budget: started jobs (one job = one step = one source→target set of ranges). What's left caps the plan's targets (below) |
| `maxBytesPerHour` | 2 GiB (1 GiB in Auto), estimate | raised | Budget: **estimated** bytes moved (keys × the source's average key size, as `memoryWarnings` does), labelled an estimate: big keys make it wrong |
| `maintenanceWindows` | `[]` = any time | widened or emptied | Gate for Auto. Approve warns outside a window, doesn't block. **My call** |
| `excludedShardIds` / `excludedSlots` | `[]` | an entry removed | Gate and planner: an excluded shard is never source or target; an excluded slot never moves |
| `abortLatencyMs` | 50 ms PING p50, or 3× the node's pre-move baseline, whichever is higher, sustained 5 s | raised | Guard (2.6) and gate (2.3) |
| `verifyMinutes` | 10 | lowered | Verification (2.7) |
| `verifyTolerance` | 0.5 | lowered | Verification: under half the projected node CPU drop is `ineffective` (recorded, not rolled back) |
| `autoRollback` | on | turned off | Verification: roll back a move whose verdict is `worse` |

- There are no per-blocker switches: every blocker in 2.3 is always on.
- **The remaining budget sizes the plan.** Each target is one step and one job; the planner's `maxTargets` is 4, Auto's job budget 2 per hour. The controller passes `maxTargets = min(policy maxTargets, jobs left this hour)`, so it plans only what can run now. When a plan's estimated bytes exceed the bytes left this hour, it drops the last target and plans again, down to one. With no job or bytes left, the `budget` blocker applies. A plan is never cut short by its own budget, so never verified as partial for that reason.
- **Excluded shards.** The planner today filters exclusions only on targets. The controller refuses a candidate with an excluded source before calling the planner; `excludedSlots` is passed as today. The planner's own `excludedShardIds` (keeping later plans in `planRebalances` off earlier targets) is merged with the policy's list, not replaced.
- **`maxCpuShare`.** The controller has its own trigger list (2.4) and calls `planRebalance` itself; it doesn't wait for a `hot_shard` event. When the planner answers `settling` for a share candidate (ratio already at or below `resolveRatio`), nothing moves. The card says "Over the CPU share limit, but balanced by ratio: the cluster needs more shards", and that feeds the scale-out trigger in phase 6. **My call.**
- **`maxNetworkShare`.** The planner balances CPU only, and bytes out count the replication stream once per replica. In v1 a shard over the network share is shown with advice ("network-heavy: check big values or a replica count") and never moves anything. A network objective in the planner is out of scope. **Decided.**
- **Loosening.** The "Loosens when" column is the rule: saving a policy with any loosening change while in Auto drops the mode to Approve, and the admin has to opt in again.

The policy is checked on save and refused when it is inconsistent, for example `resolveRatio ≥ triggerRatio`, a window with no duration, or a budget of 0 with Auto selected.

### 2.3 Blocking conditions (the gate)

One pure function, `placementGate(facts, policy, now) → Allowed | Blocked[]`. It is evaluated:

- when a recommendation is made (to show why it would wait);
- on approve;
- immediately before each step is sent, on fresh reads;
- on every follow tick of a running action, for the "stop after this step" rules.

Blocked means no migration job starts (acceptance criterion 4).

**Scope.** "Source" and "target" mean every node of that shard: the primary and each replica. An event names a node id. The gate maps it to its shard through the same fresh `CLUSTER NODES` read.

**Cluster-wide blockers** (any one blocks every move):

| Blocker | Source of truth |
| --- | --- |
| `unhealthy_node` | Fresh `CLUSTER NODES` (as `recheckFailure` does): any slot-owning primary failing, or any node flagged `fail` / `pfail` |
| `migration_running` | `CLUSTER GETSLOTMIGRATIONS` on every primary, legacy `MIGRATING` / `IMPORTING` markers, another open action of ours (the cluster lock, 3.3). The action that holds the lock, and the jobs of its own steps, don't block its next step |
| `cluster_state` | Fresh `CLUSTER INFO` `cluster_state` not `ok`, or an open `cluster_state` event |
| `topology_divergence` | Open `topology_divergence` event (#690/#693): nodes disagree on who owns slots |
| `slot_migration_stuck` | Open `slot_migration_stuck` event |
| `orphaned_slot_keys` | Open `orphaned_slot_keys` event |
| `ghost_membership` | Open `ghost_membership` event |
| `budget` | No job or bytes left over the steps of the last 60 min, counting steps in `sending` (2.2) |
| `paused` | Admin |
| `unsupported` | Support verdict (2.8) |

**Source or target blockers:**

| Blocker | Source of truth | Fresh stand-in when the node isn't collected |
| --- | --- | --- |
| `failover` | Open `failover_churn`, `replication_role`, `lagging_promotion`, a `NODE_FAILOVER` match | A config epoch change in the controller's `CLUSTER NODES` history in the last 5 min |
| `fork` | Open `persistence_child` / `fork_memory_risk`, plus live `INFO persistence` (`rdb_bgsave_in_progress`, `aof_rewrite_in_progress`) | `INFO persistence` alone. An atomic migration snapshots the source, so a running fork stacks a second one |
| `replication_divergence` | Open `replication_divergence` on a replica | `INFO replication` on the primary: every replica `online`, offset within 1 s of the primary's writes |
| `latency` | Open `command_p99` regression, plus the pre-move PING baseline (10 PINGs from the node socket, p50 over the 50 ms floor of `abortLatencyMs`; the 3× part is relative to this baseline, so it can't judge it) | PING baseline alone |
| `incident` | An incident whose recovery is `active`, `recovering`, `degraded` or `unknown`, counting only signals other than `hot_shard`, `reshard_shard_skew`, `slot_migration`, `placement_action` and `placement_rollback`. On the source it also skips the hot-source symptoms exempted below, so an incident of only exempt signals doesn't block | — |

**Per-slot, per-action and other rules:**

| Blocker | Source of truth | Scope |
| --- | --- | --- |
| `excluded` | Policy | The source shard is excluded |
| `cooldown` / `no_return` | `placement_actions` history (phase 3) | Per slot. The planner drops those slots; it blocks only when nothing is left |
| `quarantined` | A source shard whose action was rolled back in the last 24 h | Auto only. Approve shows it |
| `outside_window` | Policy | Auto only |
| `coverage` | A node of the source or target has no connection (`collected: false`) | Auto only; Approve warns, naming the nodes (below) |
| `unknown` | Any read above failed or timed out, including a fresh stand-in | Blocked: a blocker we can't read is a blocker |

- **Nodes nobody watches.** Detector blockers exist only for nodes the monitor connects to. For a `collected: false` node the gate uses the fresh stand-in above; a failed stand-in is `unknown`. Auto needs every source and target node collected (member auto-registration covers this); Approve allows stand-ins and names the unwatched nodes in the confirmation. **Decided.**
- **A hot source and its own symptoms.** A hot primary often raises `command_p99`, `load_saturation` or `cpu_utilization` on itself, which would block the move when it helps most. On the **source only**, these three don't block when they opened after the sustain trigger fired (2.4); one that opened before blocks as usual. The `incident` blocker applies the same exemption. The PING baseline always applies on the source: too slow to answer PING is too slow to snapshot a slot range. On the target, every symptom blocks. **My call**; the incident part is **Agreed in review**.

### 2.4 Hysteresis: sustained trends, not peaks

The 30 s EWMA in `ShardLoadTracker` is right for detection and wrong for acting. **My call:**

- Add two more per-slot EWMAs next to the existing one (3 × `Float64Array(16384)`, about 400 KB per cluster): **sustain** (time constant `sustainMinutes / 3`) and **baseline** (6 h, shown on the card only).
- Add a time-based ring buffer per shard: each entry is a sample's timestamp, sustain ratio, share and a `settling` flag. Entries older than `sustainMinutes` drop, whatever the poll interval. The trigger reads it.
- When a slot changes owner, its sustain and baseline values go with it, so the new owner's sustain ratio reflects the load it took on and the trigger sees no false calm. The fast rate is still cleared as today. Verification never uses carried values (2.7).
- **Trigger:** the sustain ratio is over `triggerRatio` (or the share over `maxCpuShare`) for at least 90% of the **time** the ring buffer covers, each sample weighted by the time to the next one. Samples flagged `settling` (the shard took or lost a slot in the last 2 samples) count neither way. The trigger also needs non-settling samples over at least 80% of `sustainMinutes`, else the shard reads "not enough load history". A 20-minute peak never acts. The controller then calls the planner itself (2.2).
- **Churn guards:** `slotCooldownDays` and `noReturnDays` (2.2), both 7 days. A slot moved for a 2-hour daily peak can't move again, anywhere, for a week. The next peak is carried by the new placement; if the source is still hot, other slots move: progress, not churn.
- **Who the churn guards apply to.** Cooldown and no-return bind the load-balancing actions (Spread, Isolate). Rollback is exempt (2.7), and so is Pack in phase 6: emptying a node for scale-in moves every slot it owns, recent ones included. Pack still avoids returning a slot to a shard it left within `noReturnDays` when another target fits. Every slot Pack or a rollback moves starts a fresh cooldown.
- **Warm-up:** Auto doesn't act until the sustain ring buffer is full, and the slots it would move have had a sustain EWMA for at least 3 time constants. The tracker resets everything when a sample lacks usage fields, and a slot when its counters go back (a primary restart); each reset restarts the warm-up for what it cleared. The UI shows "warming up until <time>". Recommend and Approve show plans with a "load history too short" note.

### 2.5 Placement actions

| Action | Phase | Rule |
| --- | --- | --- |
| **Spread** | 1 (exists) | `planRebalance` as is: cold slot ranges off the hot shard |
| **Isolate** | 1 (advice) / after 5 (runs) | When `key_level` comes from pinned slots, move whole pinned slots, one per target, to the coldest shards. Covers the issue's single hot slot under `nodeCpuLimit`: moving one slot beats moving ~200 cold ones. Shown only when the hottest shard after the move is at least 25% below the hot shard before, and no target ends over `resolveRatio`. A single slot over `nodeCpuLimit` stays `key_level`: slot placement can't help it (the issue's constraint). Runnable only after phase 5. **My call** |
| **Pack** | 6 | Move cold slots off one node onto the others, within the limits, to empty it for scale-in |
| **Scale out / in** | 6 | Provisioning hook (2.10) |

Every action is a row in `placement_actions`, and each step is a row in `placement_steps` (3.2). The action state machine:

```
proposed ──approve──▶ approved ──CAS + lock──▶ running ──all steps done──▶ verifying ──pass──▶ succeeded
   │  │                  │                      │  │                        ├─ineffective / inconclusive (recorded, flagged)
   │  └─reject/expire    └─gate blocked: waits   │  └─guard trips ─▶ aborted  └─worse ─▶ rolling_back ─▶ rolled_back
   │     ▶ rejected/       (expired after        │      (or aborted_pending)           └─▶ rollback_blocked / rollback_failed
   │       expired         15 min)               ├─next step blocked 30 min ─▶ verifying (finished steps only)
   └─(Auto: approved by `system` at creation)    └─job failed / unknown ─▶ failed
```

Step states: `planned → sending → running → done | failed | cancelled`.

- **Every transition is a compare-and-set** on the stored state (`UPDATE … SET state = 'running' WHERE id = ? AND state = 'approved'`). Two API instances on one database can't both start an action. **My call.**
- **No owner: any instance advances any action.** Each instance's controller tick reads the open actions of its clusters and tries the next transition (follow a job, send the next step, verify, end) through the compare-and-set; the one whose write lands does the work. While one instance is up, an action can't stay `running` with its lock held; with none up, nothing else starts either, and the restart recovery below picks it up. Sending a step is `planned → sending` by compare-and-set, then the command, so only the winner sends it. **Fence.** The sender opens its own connection to the source and names it with `CLIENT SETNAME betterdb-step-<stepId>` before the `planned → sending` compare-and-set. It sends the command on that connection only, and never reopens it (as #695 does today). A step left in `sending` for over 30 s has lost its sender, or its sender is paused. Any instance then takes it over by compare-and-set on its `sending_at`. The taker first ends the sender's connection on the source: `CLIENT LIST`, then `CLIENT KILL ID` for each client with that name, repeated until none is listed. Only then does it read `CLUSTER GETSLOTMIGRATIONS` and settle the step as after a restart (below). The server itself enforces this: once the named connection is gone, no command from that sender can reach the source, and a command the source had already run shows up in the read that follows. A paused sender that resumes finds its connection closed, so it sends nothing. Its `sending → running` write is refused, so it records nothing. When the taker can't end the connection (a `NOPERM`, or the source doesn't answer), it settles nothing and keeps the action and its lock, so the cluster stays blocked until the fence succeeds. This needs `+client|list` and `+client|kill` for the monitoring user, under the `acl` reason (2.8). Cancels likewise (`cancel_requested_at` by compare-and-set). The guard runs on every instance that sees a running step; a duplicate PING is harmless and only one cancel wins. **My call**, over a heartbeat: no lease to renew, a takeover is one compare-and-set, and it reuses the compare-and-set and restart recovery phase 3 needs anyway.
- **Write-ahead.** Before a step's `CLUSTER MIGRATESLOTS` is sent, the step is written as `sending` with `jobsBefore` (jobs already listed on the source); then the command goes out, and the reply moves it to `running`. The cancel fields (`cancelRequestedAt`, `cancelAcceptedAt`, `failedBeforeCancel`) are written as they happen.
- **After a restart**, for each step in `sending` or `running`, the controller reads `CLUSTER GETSLOTMIGRATIONS` on the source and adopts a job not in `jobsBefore` whose source, target and ranges match (`matchesJob` rules). If none: ranges now on the target = `done`; still on the source = `failed`, "no job found after a restart". The budget counts `sending` steps, so a crash can't undercount it. While the process is down the guard is too; Valkey ends the job on its own.
- **Before each step**, the controller re-checks that the source still owns the step's ranges (`recheckFailure`), re-runs the gate on fresh reads, and re-projects from the steps done. A step whose ranges moved under it is dropped.
- **A running action whose next step stays blocked for 30 min** stops taking steps and goes to verification with the steps that finished.
- An Approve-mode proposal expires after 30 min, or as soon as the plan it holds changes (the same `sameMoves` rule as `runRebalance` today). **My call.**
- A rollback is its own action (`kind: rollback`, `rollbackOf`). It doesn't pass through `proposed` and is never rolled back itself.
- **Steps:** one target, so one `CLUSTER MIGRATESLOTS`, per step, with a fixed 120 s pause between steps (the 2 settling samples plus margin). No per-step size caps in v1: the hourly budgets bound the total. **My call**: this trades the plan-wide all-or-nothing start for smaller moves and real abort points.

### 2.6 Throttle and abort during a move

- **One action at a time per cluster**, enforced by the cluster lock (3.3), keyed by node ids, not by connection id. One job at a time within it.
- Budgets (2.2) are checked before each step, from the stored steps, so a restart doesn't reset them.
- **Guard**, while a step runs: PING round-trip time every second on every node of the source and the target, from the monitor's own node sockets. A trip needs `abortLatencyMs` to hold for 5 s. `INFO latencystats` deltas can come later.
- **What the guard can and can't see.** PING isn't a write, so it doesn't wait on the slot write pause at the end of an atomic migration and misses the write latency clients see then. It catches a node that stops answering: a fork stall, a long command, an overloaded event loop. Valkey bounds the write pause; the latency check (2.7) and `command_p99` show its effect afterwards. The guard is not protection against the write pause.
- The guard also runs during the steps of a rollback action, with the same trip rule. A trip there cancels under the same foreign-job rule and ends it `rollback_failed`, with a WARNING and a webhook.
- In Auto, seeing a job that isn't ours on any primary (before a step or during one) also pauses Auto (2.1).
- On a trip:
  1. Re-read `CLUSTER GETSLOTMIGRATIONS` on the source.
  2. If every active job there is ours, send `CLUSTER CANCELSLOTMIGRATIONS` to the source. That command cancels every migration of the node, which is why this check comes first.
  3. If a job that isn't ours is listed, don't cancel. Mark the action `aborted_pending`, raise a WARNING, and stop further steps.
  4. Slots already moved stay where they are, and the action goes to verification with the steps that finished.

  **My call.**
- **The manual Cancel follows the same rule.** Today `cancelRebalance` checks only that the read worked. From phase 3, the Cancel button and `POST /anomaly/hot-shards/:shardId/rebalance/cancel` refuse with `409` and name the foreign job when one is listed on the source.
- **The read-then-cancel gap.** A foreign job can start between the read and the cancel (one round trip); ours can't, because of the cluster lock. One that does would be cancelled too; the UI and docs say so, and it can't be closed from outside the server.
- Only latency triggers a cancel. A failover or fork mid-run stops the next step but doesn't cancel the current one: Valkey fails a job on its own across a failover, and a cancel then is one more topology change. **My call.**

### 2.7 Verification after each move, and rollback

**What it measures.** `CLUSTER SLOT-STATS` charges CPU to slots, so a slot's counter moves with it and slot sums always match the projection. The failures verification is for (pinned or proxied clients, stale slot maps following `MOVED`, more client handling or replication output on the source, extra target load) show up in node CPU and latency, not slot sums. **My call:**

- Wait for the move to settle: `REBALANCE_OUTCOME_SETTLE_MS` (60 s) plus the 2 settling samples. Then measure over `verifyMinutes` on **fresh samples only**: fast per-node rates after settling, never carried sustain values.
- **Node CPU** comes from `INFO cpu` on every primary: the delta of `used_cpu_sys + used_cpu_user` over the window, in µs/s. "Before" is the same read over the `verifyMinutes` before the first step.
- **One unit throughout: node CPU.** Node CPU includes overhead no slot accounts for (client handling, replication output, background work), so node ratios are flatter than slot ratios. The projection is made in node CPU too, never a slot-ratio projection against a node-ratio measurement:
  - `projectedNode(source) = nodeBefore(source) − Σ slot CPU moved off it`
  - `projectedNode(target) = nodeBefore(target) + Σ slot CPU moved onto it`
  - every other primary keeps `nodeBefore`;
  - ratios are to the median of those projected values, and the measured ratios to the median of the measured values, so a traffic change across the whole cluster doesn't decide the verdict.
- **The projection is for the steps that finished**, not the whole plan:
  - `projectedDrop = nodeRatioBefore(source) − projectedNodeRatio(source, finished steps)`
  - `actualDrop = nodeRatioBefore(source) − measuredNodeRatio(source)`
- **Verdicts.** Rollback is only for a move that made things worse: it is a second fork and write pause, worth it only when the new placement is worse than the old. **Agreed in review.**
  - **Worse** (the definition every rollback rests on; **Agreed in review**) if any of these holds for the median of the window's samples, and did not already hold for that node before the move:
    - a target primary's node CPU is over `nodeCpuLimitUsecPerSecond`;
    - a target's node ratio is over `triggerRatio`;
    - the PING p50 of any node of the source or the targets is over `abortLatencyMs`.
  - **Ineffective** if it isn't worse but `actualDrop < verifyTolerance × projectedDrop`: the move didn't help as projected. Nothing is rolled back. It is recorded, flagged for a human, sends `placement.action.completed` with the verdict, counts toward quarantine and the circuit breaker, and its slots keep their cooldown.
  - **Pass** otherwise.
  - **Inconclusive** when no sample comes in, or the median node CPU moved by more than 30% during the window. That is today's `outcomeUnavailable`: no rollback, flagged for a human.
- **Explanation:** slot sums stay as the per-range "carried its load" record: the range's slot CPU on the target against its slot CPU before. A slot-sum pass with an ineffective node CPU verdict reads "the load didn't follow the slots: check for pinned clients or a proxy".
- **On worse with `autoRollback` on** (Approve and Auto alike): create a rollback action that moves the exact ranges back.
  - The rollback skips the budget, window, cooldown and no-return checks.
  - It still obeys `unhealthy_node`, `migration_running`, `cluster_state`, `topology_divergence`, `failover`, `fork` and `latency`. A `latency` block on the target it leaves doesn't stop it (that is the reason for the rollback); on the shard it returns to, it does.
  - The PING guard runs during its steps (2.6).
  - If those blockers hold it for 30 min, it ends `rollback_blocked`, with a WARNING and a webhook for a human.

  **My call**, within the rule **Agreed in review**.
- **Quarantine:** after a rollback or an ineffective verdict, the source shard is quarantined for 24 h in Auto, whatever a new plan picks: the usual cause (pinned clients, a proxy) belongs to the source. Approve shows the quarantine and lets an admin go ahead.
- **One-click rollback:** any `succeeded` or `ineffective` action from the last 24 h whose ranges are all still owned by its targets. It goes through the same rollback path, and an admin starts it.

### 2.8 Support verdict ("not supported" for managed services)

A per-connection `PlacementSupport`, computed at connect and on every topology change, and updated when a command comes back `NOPERM`. Its first failing reason shows on the placement card and in the API and MCP. The order is **my call**.

| Reason | Detection |
| --- | --- |
| `not_cluster` | Not cluster mode |
| `provider_managed` (with `provider`) | Rebalance's narrow check: `isManagedProviderHost` (host suffix) or `isManagedProviderBuild` (`redislabs`), plus `MONITOR_PROVIDER_OVERRIDE` naming a managed provider (the operator's own statement). **Not** the "Amazon Linux" OS signal: it false-positives on self-hosted EC2, this feature's audience. Add Azure Cache (`.redis.cache.windows.net`) and Aiven (`.aivencloud.com`) suffixes, others as verified. Text: "Managed by <provider>: slot moves go through the provider's resharding." A managed host given by IP or a custom DNS name is caught by `command_unavailable` or `acl` below. **Agreed in review** |
| `per_node_connections` | Cluster nodes registered one by one as separate connections (no cluster-wide view, so `hot_shard` doesn't run either) |
| `slot_stats_off` | On the server: `cluster-slot-stats-enabled` not `yes` on every primary, or Valkey < 8.0. In the monitor: `METRICS_SLOT_STATS_TOP_N=0`, or the capability tracker has switched `canClusterSlotStats` off for this connection |
| `not_dialed` | Agent or OTLP connection: the monitor can't open node sockets |
| `server_version` | Not every primary on Valkey ≥ 9.0. Redis 8.4+ is `copy_only` (**Agreed in review**) |
| `command_unavailable` | `COMMAND INFO CLUSTER\|MIGRATESLOTS` returns nothing (renamed or disabled), checked on every primary |
| `acl` | The first `NOPERM` on `CLUSTER MIGRATESLOTS`, `CANCELSLOTMIGRATIONS`, `GETSLOTMIGRATIONS`, or the fence's `CLIENT LIST` / `CLIENT KILL` (2.5). Stored until the next topology change or an admin's "check again". **My call** |
| `memory_storage` | `STORAGE_TYPE=memory` (2.1). Limits the mode to Recommend |
| `no_sign_in` | `WORKSPACE_DISABLED=true` (2.1). Limits the mode to Approve, with an anonymous actor (2.1) |

- Observe and Recommend work on every reason except `not_cluster`, `per_node_connections`, `slot_stats_off` and `not_dialed`: the plan is advice. Approve and Auto can't be selected (except per the `no_sign_in` row). The verdict text is the "with the reason" of acceptance criterion 7.
- **Stale load.** The shard load is fed only when every node answered the poll. Older than 3 poll intervals, the gate reads `unknown` and the card names the node that didn't answer: a gate state, not a support reason.
- **No per-provider verification.** The feature is for self-hosted clusters. The host suffix, build id and override check, plus `command_unavailable` and `acl`, is all the support verdict needs. **Agreed in review.**

### 2.9 Hash-tag advisor (advisory only)

- **Inputs:** its own `CLUSTER GETKEYSINSLOT <slot> 500` read on each pinned slot (at most 3), needing no LFU policy, plus the per-slot `key-count` from `SLOT-STATS`. The hot-key read (`hot-shard-keys.ts`) stays and only adds names when LFU is on.
- **Rule:**
  - Parse the hash tag as Valkey does: the first `{`, then the first `}` after it, with a non-empty inside.
  - When at least 50% of the sampled names in a pinned slot share one tag, name that tag.
  - Separately, a slot holding at least 20× the median slot key count is named as a key-count outlier even without load.

  **My call.**
- **Output:** a sentence after the `key_level` explanation, for example `92% of the sampled keys in slot 9189 share the hash tag {cart}. Splitting that tag in the application spreads them across slots.` The tag is handled like hot key names: at most 64 characters, escaped, at most 3 per message, the full list only in the API response.
- A `NOPERM` on `GETKEYSINSLOT` ends the read with a note, like the hot-key read.
- Never a plan, never an action.

### 2.10 Scale out / in hooks (phase 6)

- **Scale out:**
  - Trigger: the planner answers `cluster_hot` over the sustain window, a `maxCpuShare` candidate is balanced by ratio (2.2), or no plan fits the budget for 24 h.
  - Send `placement.scale.requested` with `direction`, `reason`, per-shard load, a `requestId` and the suggested extra shards (the fewest empty primaries with which the planner resolves).
  - One open request per cluster, none repeated for 24 h unless acknowledged.
  - When a new empty primary appears (topology auto-registration sees it) and stays healthy for 2 samples, the planner already prefers it as a target. The request moves to `fulfilled`.
- **Scale in:**
  - Trigger: every shard under 25% of `nodeCpuLimit` for 24 h, and Pack finds a node it can empty within the limits.
  - Pack moves its slots away with the usual gate, steps and verification; then `placement.scale.ready` names the empty primary for the receiver to remove.
- BetterDB never adds, removes or `CLUSTER FORGET`s a node itself.
- A `ProvisioningHook` interface keeps the webhook as its first implementation. The webhook is enough for phase 6. **Agreed in review.**
- **Later: `valkey-io/valkey-operator`.** The Valkey project's own operator is the target for a later integration: cluster-mode only, scaling shards with atomic slot migration (the same Valkey 9 floor). It isn't production-ready yet, so nothing is built against it now. The operator owns slot allocation and rebalances on its own when the shard count changes, so there the hook would only change the shard count on the `ValkeyCluster` resource, and the autopilot must not also place slots on the new shard. `migration_running` already makes us wait while the operator moves slots; who owns placement after a scale is decided per cluster when that integration is built.

## 3. Data model and storage

Four new tables and one changed table, each in the memory, sqlite and postgres adapters, with `StoragePort` methods. The sqlite adapter also serves `STORAGE_TYPE=turso` (`SqliteAdapter` over the libsql driver), so every sqlite migration here, the `activity_events` rebuild included, runs on turso unchanged. Approve and Auto need one of the durable backends (2.1); the memory adapter exists for tests and Recommend.

### 3.1 `placement_policies` (phase 1: mode; phase 2: policy)

| Column | Type | Note |
| --- | --- | --- |
| `connection_id` | text PK | |
| `mode` | text | `observe` \| `recommend` \| `approve` \| `auto` |
| `policy` | JSON text | `PlacementPolicy` (2.2), validated by a shared zod schema |
| `auto_opt_in` | JSON text, null | `{ userId, email, at, policyVersion }` |
| `paused` | JSON text, null | `{ userId, email, at }` |
| `version` | integer | Optimistic concurrency: a write needs the version it read |
| `updated_at` | integer | |

`StoragePort`: `getPlacementPolicy(connectionId)` and `savePlacementPolicy(policy, expectedVersion)`. Deleted with the connection. The phase 1 migration writes `mode = 'recommend'` for every existing cluster connection (2.1).

### 3.2 `placement_actions` and `placement_steps` (phase 3)

`placement_actions`:

| Column | Type | Note |
| --- | --- | --- |
| `id` | text PK | |
| `connection_id` | text, indexed with `created_at` | |
| `cluster_nodes` | JSON | The primary node ids at creation: the lock key (3.3) |
| `kind` | text | `spread` \| `isolate` \| `pack` \| `rollback` |
| `state` | text | 2.5. Every write is a compare-and-set on it |
| `mode_at_creation` | text | |
| `plan` | JSON | Moves, steps, projection (the existing `RebalancePlan` shape) |
| `policy_snapshot` | JSON | The policy at approval: "the policy that allowed it" |
| `gate_decisions` | JSON | The rules evaluated and their result at each step start |
| `approved_by` | JSON | `{ source: ui\|mcp\|system, userId, email, tokenId }` |
| `load_before` / `load_projected` / `load_measured` | JSON | Per shard: slot CPU, node CPU, share, ratio, PING p50 |
| `verdict` | JSON, null | `pass` / `ineffective` / `worse` / `inconclusive`, with the node CPU numbers (2.7) |
| `source_shard_id` | text, indexed | Quarantine (2.7) |
| `rollback_of` / `rolled_back_by` | text, null | |
| `created_at`, `approved_at`, `started_at`, `ended_at`, `verified_at` | integer | |
| `anomaly_event_ids` | JSON | The timeline events it raised |

`placement_steps`:

| Column | Type | Note |
| --- | --- | --- |
| `action_id`, `index` | PK | |
| `state` | text | `planned \| sending \| running \| done \| failed \| cancelled`, compare-and-set |
| `source_node_id`, `target_node_id`, `ranges` | text / JSON | What `matchesJob` needs to adopt a job |
| `jobs_before` | JSON | Written with `sending`, before the command is sent |
| `job` | JSON | The job name, state, phase and message, as `RebalanceRunJob` |
| `cancel_requested_at`, `cancel_accepted_at`, `failed_before_cancel` | integer / JSON | As `RebalanceRun` |
| `bytes_estimated` / `keys_moved` / `slots_moved` | integer | Budgets |
| `sending_at`, `started_at`, `ended_at` | integer | `sending_at` indexed for the hourly budget |

Retention: `PLACEMENT_ACTION_RETENTION_DAYS`, default 90, pruned with the activity job. Today's in-memory `RebalanceRun` becomes a view over the rows, surviving a restart. The cooldown and no-return rules (2.4) read the `done` steps of the last `max(slotCooldownDays, noReturnDays)`.

### 3.3 `placement_locks` (phase 3)

| Column | Type | Note |
| --- | --- | --- |
| `node_id` | text PK | One row per primary node id of the cluster |
| `action_id` | text | The action holding it |
| `acquired_at` | integer | |

- Starting an action inserts one row per primary node id in one transaction. A primary key conflict means an action on an overlapping cluster holds the lock, so the start is refused; this works across connections (a cluster added twice) and API instances on one database.
- The lock is released in the same transaction that moves the action to a terminal state. After a restart, rows whose action is terminal are freed.
- Memory adapter: a map with the same semantics, which covers one process.
- There is no lease. Auto's tick loop on several instances is safe because creating an action already takes the lock. **My call.**
- **Nobody owns a held lock.** The lock belongs to the action, not an instance. Any instance advances the action through the compare-and-set (2.5), so the lock is released when the action ends, whoever ends it. No heartbeat expires.

### 3.4 `activity_events.actor_via` adds `system` (phase 3)

- Sqlite and turso: the `CHECK` constraint can't be altered, so the table is rebuilt in a migration with the existing copy-and-rename pattern (`rebuildWithNullableColumns`) inside `db.transaction`, which turso runs through the libsql driver as it does today. The phase 3 test runs the rebuild on both drivers.
- Postgres: drop and re-add the constraint.
- Memory: type only.
- The new `CHECK` list is `('session','token','cli','system','anonymous')`: `anonymous` for installs without sign-in (2.1).
- System rows use `actor_user_id = 'system:placement'` and `actor_email = 'placement-autopilot'`, so the `NOT NULL` columns stay; `ip` is empty. Anonymous rows use `actor_user_id = 'anonymous'`, `actor_email = 'anonymous'` and the request IP. **My call**: smaller than making the columns nullable.
- New actions:
  - `placement.mode.set` and `placement.policy.set`
  - `placement.action.approve`, `.reject`, `.start`, `.abort`, `.rollback`
  - `placement.paused` and `placement.resumed`
- Each row carries `targetType: 'placement_action'`, the action id, and `details` with the before, projected and after load.

### 3.5 Timeline events (phase 3)

Two new `MetricType`s, persisted like any anomaly event, so they appear in the incident timeline and the `nodes` list:

- `placement_action` (INFO): opens when a step starts, resolves when the action ends, and names the moves. `values` carries the before, projected and measured ratios of the source and the targets.
- `placement_rollback` (WARNING): a `worse` verdict, a rollback, a `rollback_blocked`, or a guard abort. An `ineffective` verdict is a WARNING on `placement_action` itself, as nothing is rolled back.

The gate excludes both from the `incident` blocker (2.3).

### 3.6 In memory only

The two extra EWMAs and the sustain ring buffers (2.4), the controller's `CLUSTER NODES` epoch history, the guard samples, and the support verdict cache. All are rebuilt after a restart; the warm-up rule covers the EWMAs and ring buffers.

## 4. API, MCP and webhooks

REST, under the anomaly module's guard (Pro, as `/anomaly/*`), with the `x-connection-id` header:

| Route | Role | Phase |
| --- | --- | --- |
| `GET /placement` (mode, support, policy, balance per shard with fast and sustain ratios, recommendations with gate result, budget use, next window, active blockers, warm-up) | member | 1 (mode/support/balance), 2 (policy/gate) |
| `PUT /placement/mode` `{ mode, confirmName? }` | admin | 1 (Observe/Recommend), 3 (Approve), 5 (Auto) |
| `PUT /placement/policy` `{ policy, version }` | admin | 2 |
| `GET /placement/actions` (`state`, `from`, `to`, `cursor`, `limit`) and `GET /placement/actions/:id` | member | 3 |
| `POST /placement/actions/:id/approve` `{ moves }` (the moves shown, as `runRebalance` takes today) | admin | 3 |
| `POST /placement/actions/:id/reject`, `/cancel`, `/rollback` | admin | 3 |
| `POST /placement/pause`, `/resume` | admin | 3 |

- `POST /anomaly/hot-shards/:shardId/rebalance` stays and, from phase 3, creates an approved Spread action (one code path, same response shape). **My call.**
- Approve, Auto and write routes need a signed-in admin, except on installs without sign-in, which record an anonymous actor (2.1).
- Auto is Enterprise; `PUT /placement/mode` refuses `auto` on Pro with the usual entitlement error.

MCP, under `/mcp/instance/:id/placement/...`. Write tools need an admin's personal token and are recorded under that user, source `mcp`:

| Tool | Phase |
| --- | --- |
| `get_placement_status` | 1 |
| `list_placement_actions` | 3 |
| `approve_placement_action` (takes the moves it read, like the UI) | 3 |
| `reject_placement_action`, `rollback_placement_action`, `cancel_placement_action` | 3 |

No MCP tool sets Auto or edits the policy: opting in to autonomy stays a human action in the UI. **My call.** `get_hot_shards` keeps its shape, keeps `rebalance` in every mode (2.1), and gains `advice.hashTags`.

Webhooks (Pro tier, `node` block as on other cluster alerts):

| Event | When | Phase |
| --- | --- | --- |
| `placement.action.proposed` | An Approve-mode proposal is created | 3 |
| `placement.action.started` | The first step starts | 3 |
| `placement.action.completed` | Verified `pass`, `ineffective` or `inconclusive` | 4 |
| `placement.action.rolled_back` | A `worse` verdict's rollback done, failed or blocked; guard abort | 4 |
| `placement.mode.changed` | Including the automatic drop from Auto to Approve, and Auto pausing on a foreign job | 5 |
| `placement.scale.requested`, `placement.scale.ready` | 2.10 | 6 |

## 5. UI

- **Placement card on the Cluster page** (new), and a link to it from the Anomalies rebalance panel:
  - the mode selector;
  - the support badge with the reason;
  - balance bars per shard (fast and sustain ratio, with the trigger and resolve lines);
  - active blockers, and the nodes the monitor doesn't watch;
  - budget used this hour (bytes labelled as an estimate);
  - the next maintenance window, and the warm-up end.
- **Observe:** the bars, `key_level` and hash-tag advice. No plan table.
- **Recommend:** today's `RebalanceSuggestion` (plan, projection table, warnings, commands), plus the gate result: "Would run now" or "Waits for: failover on 10.0.0.3, budget".
- **Approve:** the proposal with Approve / Reject. The confirmation repeats the moves, warnings, unwatched nodes and the policy rules that allowed it, like today's "Run this plan" dialog.
- **Auto:** the opt-in dialog (2.1). Pause is always visible. Saving a loosening policy warns first that it drops the mode to Approve.
- **Actions list** (`RebalanceRuns` grows into it):
  - state, steps and jobs;
  - who or what approved, and the policy version;
  - before, projected and measured load (slot CPU and node CPU);
  - the verification verdict and the "carried its load" record;
  - Rollback and Cancel buttons. Cancel names a foreign job when it refuses.

  Members see no email addresses, as today.
- **Policy editor:** a drawer from the card, with the validation errors from `PUT /placement/policy`.
- **Verdicts:** `ineffective` shows "Didn't help as projected: not rolled back" with a Rollback button for an admin; `worse` shows what got worse.
- **Unsupported:** the card shows the reason (e.g. "Managed by AWS ElastiCache: slot moves go through the provider's resharding"); the mode selector is limited to Observe and Recommend, or Observe only when slot load can't be read.

## 6. Phases

Each phase is one PR or a small stack, shipping behind the ones before it. The benchmark harness (section 7) grows with the phases, each adding what its scenarios need.

### Phase 1: Recommend mode with post-move projection

Two PRs that don't depend on each other. **Agreed in review.**

**1a. Modes, read-out and support.**

- **Ships:**
  - The `mode` (Observe for new connections, Recommend for existing ones), in a minimal `placement_policies` row (only `mode`), so the table exists from phase 1. **My call**
  - The Observe balance read-out.
  - Recommend = today's plan and projection.
  - The support verdict (2.8) and its UI.
  - Isolate as advice.
  - `GET /placement`, `PUT /placement/mode`, `get_placement_status`.
- **Reuses:** `planRebalances`, `RebalanceSuggestion`, `describeNoPlan`, `isManagedProviderHost` / `isManagedProviderBuild`.
- **Storage:** `placement_policies` with `mode` only, in 3 adapters (turso through sqlite), plus the upgrade migration.
- **Safety:** nothing new is written to the cluster. The existing `BETTERDB_SLOT_MIGRATION` run button keeps working unchanged, in Recommend only.
- **Benchmark:** the simulator's load model and planner layer. Scenarios B2 (single hot key, without the tag part) and B8 (managed).

**1b. Hash-tag advisor** (its own PR, any time after 1a or before it).

- **Ships:** the advisor (2.9) with its own key read, `advice.hashTags` in `get_hot_shards`, the sentence on the card.
- **Benchmark:** B2's hash-tag variant, with LFU on and off.

### Phase 2: Policy and guardrails

- **Ships:**
  - `PlacementPolicy`, its editor and validation, with the loosening table.
  - The sustain and baseline EWMAs and the sustain ring buffer.
  - The controller's own trigger list (2.4) and its call to the planner.
  - The gate (2.3) with coverage and fresh stand-ins, shown on recommendations.
  - Exclusions on source and target.
  - The existing run button goes through the gate.
- **Reuses:** each blocking detector's open-event index, the node ref's `collected` flag, `recheckFailure`, the slot migration state reads.
- **Storage:** `placement_policies.policy`, `.version`.
- **API:** `PUT /placement/policy`. `GET /placement` gains the gate and the blockers.
- **Safety:** the gate is one pure function with a table-driven spec: every blocker × source/target/replica/unrelated node × open/closed/unknown × collected/not collected.
- **Benchmark:** the simulator gains the gate and the trigger. B3 (peak-only, trigger part), B4 (blockers).

### Phase 3: Approve mode with audit and rollback

- **Ships:**
  - `placement_actions`, `placement_steps` and the state machine, with compare-and-set transitions and write-ahead steps.
  - `placement_locks` (one action per cluster across connections and instances).
  - Restart recovery: adopt or close `sending` and `running` steps.
  - Steps, the hourly budgets, and the PING guard (2.6).
  - Cooldown and no-return, read from stored steps.
  - The foreign-job rule on the manual Cancel route.
  - Approve mode (UI and MCP), on Pro, for signed-in admins (or under the anonymous-actor rule for installs without sign-in).
  - The remaining budget as the planner's target cap (2.2).
  - The `memory_storage` support reason.
  - One-click rollback.
  - The activity `system` (and `anonymous`) actor and the new actions, with the `activity_events` rebuild tested on the better-sqlite3 and libsql drivers and postgres.
  - The `placement_action` / `placement_rollback` timeline events.
  - Webhooks `proposed` and `started`.
  - The existing run route moves onto actions.
- **Reuses:** `slot-rebalance-run.ts` (`matchesJob`, `followJob`, the cancel semantics), `writeShard`, the cache-proposal flow's propose/approve/audit shape.
- **Storage:** `placement_actions`, `placement_steps`, `placement_locks`, plus the `activity_events` migration.
- **Safety:**
  - Approval needs the moves shown (stale-plan guard).
  - The gate runs on fresh reads, and ownership is re-checked, before each step.
  - A cancel, from the guard or a human, is sent only when every job on the source is ours.
  - Any instance advances any action through the compare-and-set; there is no owner and no heartbeat (2.5).
  - Check how cloud mode signs users in before Approve is offered there.
- **Benchmark:** the fake cluster gains migration emulation. B6 (latency abort), B7 (budget), B11 (restart mid-run; kill between send and reply: job adopted, budget counts it), B12 (two seed connections, two instances, one killed mid-run).

### Phase 4: Verification after each move, with automatic rollback

- **Ships:**
  - The verifier (2.7): projection and measurement in node CPU, against finished steps, with `pass` / `ineffective` / `worse` / `inconclusive` verdicts and automatic rollback of `worse` moves.
  - Quarantine by source shard and `rollback_blocked`.
  - The per-range "carried its load" record.
  - Webhooks `completed` and `rolled_back`.
- **Reuses:** `withOutcome` (becomes a verdict), the node sockets, `INFO cpu`.
- **Storage:** `placement_actions.verdict`, `.load_measured`.
- **Safety:**
  - A rollback is never rolled back.
  - An inconclusive verdict never rolls back.
  - Only a `worse` verdict rolls back; `ineffective` is recorded and flagged.
  - A rollback obeys the health blockers, `latency` included, and runs under the guard.
- **Benchmark:** the simulator gains the verifier and node CPU no slot accounts for. B1 (skewed load verified, with fixed node overhead), B5a (a move that makes a target worse is rolled back), B5b (one that doesn't help is recorded and flagged), B10 (partial action verified on finished steps), B11's verdict check.

### Phase 5: Auto mode

- **Ships:**
  - Auto on Enterprise: opt-in, circuit breaker, maintenance windows, pause on a foreign job, `BETTERDB_PLACEMENT_AUTO` (default false), Pause, warm-up, the coverage requirement and the loosening rule.
  - The several-monitors limitation in the docs (9).
  - Webhook `mode.changed`.
- **Reuses:** everything above. Auto is "approved by `system` at creation".
- **Safety:**
  - Auto acts only when every rule allows it.
  - Its default budgets are lower than Approve's (half). **My call**
  - It drops to Approve on the triggers in 2.1.
- **Benchmark:** the whole suite runs in Auto. B9 (several hot shards).

### After phase 5: Isolate runs

Isolate becomes a runnable action, with the same gate, steps and verification as Spread. No acceptance criterion needs it before then.

### Phase 6: Scale-out / in hooks

- **Ships:**
  - `ProvisioningHook` with the webhook implementation.
  - The scale request lifecycle.
  - Pack for scale-in, exempt from the cooldown and no-return rules (2.4).
  - Webhooks `scale.requested` and `scale.ready`.
- **Reuses:** `cluster_hot`, topology auto-registration, the planner's empty-primary preference.
- **Storage:** a `kind: scale` row in `placement_actions`. **My call**
- **Benchmark:** B13 (cluster hot, and Pack emptying a node that holds slots moved in the last 7 days).

## 7. Benchmark harness

**My call:** three layers. Only the first runs in CI. Each phase adds what its scenarios need (section 6).

1. **Simulator** (`benchmarks/placement/`, no Docker, deterministic):
   - A fake clock and a per-slot load model: a base load, skew, daily peaks, single hot keys and hash tags, with and without an LFU policy.
   - **Node CPU is modelled apart from slot CPU.** A "load doesn't follow" mode leaves CPU on the source (or adds it on a target) that no slot accounts for, as pinned clients or `MOVED` handling would.
   - It feeds `SLOT-STATS`-shaped counters and `INFO cpu` into the real `ShardLoadTracker`, planner, gate, controller and verifier, imported by path and pinned by hash like `benchmarks/split-brain`.
   - An emulated executor moves ownership after a time proportional to the bytes, and can inject a target latency rise, a failover, a process death between send and reply, and so on.
   - It reports migrations per day, bytes moved, the time to resolve, and the actions by final state.
2. **Fake cluster** (`apps/api/test/load/fake-cluster.ts` extended):
   - A per-slot load profile and a slot ownership map.
   - `CLUSTER MIGRATESLOTS`, `GETSLOTMIGRATIONS` and `CANCELSLOTMIGRATIONS` emulation, and a foreign job on request.
   - It runs the real API end to end and counts every write command per node.
3. **Live Valkey 9 cluster** (Docker, run on request only, like the #695 live run): it checks the real command, job following, cancel, a real rollback, and whether a source cancel also stops jobs importing into that node.

| # | Scenario | Expectation |
| --- | --- | --- |
| B1 | Skewed load: one of 6 shards at 3× the median by slot CPU over ~200 warm slots, for 2 h; variant where every node carries a fixed overhead no slot accounts for (hot shard ~2× by node CPU) | One Spread action, verdict `pass` on node CPU in both variants, shard ≤ `resolveRatio` by slot CPU, no further action for 7 days (acceptance criterion 3a) |
| B2 | Single hot key: one slot carries 85% of its shard and more than `nodeCpuLimit` | No action in any mode. The `key_level` explanation names the slot (and the key when LFU is on). The hash-tag variant names the tag, with LFU off too (criterion 3b) |
| B3 | Peak-only: a daily 20-min peak at 3× on one shard for 7 simulated days; variant with a 2-h peak; variant with a 15 s poll | 0 migrations; with the 2-h peak at most 1 action over the 7 days, no slot moves twice, and nothing moves back (criterion 3c) |
| B4 | Blockers: each blocker of 2.3 raised on the source, target, a replica, an unrelated node, and cluster-wide as a plan is ready; variants with the node not collected, and a source symptom (alone and as an incident) before and after the trigger | No job starts while it is open on source or target, cluster-wide, or `unknown`; an unrelated node doesn't block; a not-collected node uses its stand-in; it starts once the blocker clears (criterion 4) |
| B5a | A move that makes a target worse: after the move, a target ends over `nodeCpuLimit`, over `triggerRatio`, or its PING over `abortLatencyMs`, none of which held before. With the fixed-overhead variant of B1 | Verdict `worse` → automatic rollback → slots back, source quarantined. Timeline and activity rows with the before, projected and after load (criteria 5, 6) |
| B5b | A move that doesn't help: the slot sums move but the node CPU stays on the source, and no target crosses a `worse` limit. With the fixed-overhead variant of B1 | Verdict `ineffective`, nothing rolled back, recorded and flagged for a human, source quarantined. Timeline and activity rows with the before, projected and after load (criteria 5, 6) |
| B6 | Latency guard: the target's PING goes to 200 ms mid-step; variants with a foreign job on the source, a manual Cancel with a foreign job, and the same trip in a rollback step | A cancel within 6 s, `aborted`; the foreign-job variants send no cancel, end `aborted_pending` (Auto pauses), and the Cancel route answers `409` naming the job; the rollback variant ends `rollback_failed` |
| B7 | Budget: 5 hot shards at once; variant in Auto with a 4-target plan and 2 jobs per hour | No more than `maxMigrationsPerHour` jobs and `maxBytesPerHour` per rolling hour; the Auto variant plans 2 targets, runs them, and is never verified as partial |
| B8 | Managed: an ElastiCache host name, the override; a self-hosted EC2 host with "Amazon Linux" in the OS field; variants for `NOPERM`, a renamed command, Valkey 8.1, `METRICS_SLOT_STATS_TOP_N=0`, `STORAGE_TYPE=memory` | Support verdict with the right reason, Approve/Auto refused, 0 write commands counted (criterion 7); the EC2 host is supported |
| B9 | Several hot shards with overlapping targets | Plans in `planRebalances` order, one action at a time, no target over the line |
| B10 | Partial action: the third of four steps stays blocked for 30 min | Verification on the two finished steps, against their own projection; a good partial move passes |
| B11 | Monitor restart in the middle of a run; variant killed between send and reply | The action is followed again from storage, the job adopted as ours, the budget counts it, and (phase 4) the verdict still comes |
| B12 | The same cluster added as two seed connections; two API instances on one database; one instance killed in the middle of a step | One connection takes Approve or Auto; one action starts; the survivor follows the job, sends the next step and releases the lock |
| B13 | Cluster hot for 2 h; then cold for 24 h with a node holding recently moved slots | One `scale.requested`, not repeated within 24 h; slots placed once an empty primary joins; Pack empties the node despite the cooldown |

## 8. Acceptance criteria → where they are met

| Criterion | Met by |
| --- | --- |
| Design doc reviewed before implementation | Reviewed on this issue; this version answers the review |
| Default Observe; Auto needs an explicit per-connection opt-in | 2.1 (new connections in Observe, existing ones keep what they have, both env flags opt-in, re-opt-in on loosening, signed-in only), phases 1 and 5 |
| Benchmark: skew rebalanced; single hot key not, with an explanation; peaks don't churn | 2.4, 2.5, 2.9; B1, B2, B3 |
| No migration starts while a blocking condition is active | 2.3 (cluster-wide and per-shard blockers, coverage, evaluated before every step, unknown = blocked), 2.5 (lock, CAS); B4, B12 |
| A move that makes the placement worse is rolled back automatically; one that doesn't help is recorded and flagged (criterion as reworded in review) | 2.7 (node CPU on both sides, fresh samples, finished steps only, `worse` defined); B5a, B5b, B10 |
| Every action is in the audit log and the incident timeline with before/after load | 2.5 (write-ahead), 3.2, 3.4, 3.5; B5a, B5b, B11 |
| Managed services show the feature as unsupported, with the reason | 2.8 (host suffix, build id, override; `command_unavailable` and `acl` for the rest); B8 |

The issue's policy items: max CPU share is a trigger (2.2); max network share is shown and advised only (decided); excluded shards are never a source or a target (2.2).

## 9. Risks

- **The assumption that load moves with the slot** fails for proxied or pinned clients. Node CPU verification is there for this, and the per-range record shows when it happened.
- **`CLUSTER CANCELSLOTMIGRATIONS` cancels every job of the source.** We cancel only when every job there is ours (2.6), from the guard and the human route. A foreign job started in the round trip between read and cancel can still be hit.
- **Several monitors on one cluster: a documented limitation.** Instances sharing a database are covered by the lock and compare-and-set. Independent installs aren't: `migration_running` makes the second wait but can't stop both starting at the same instant. Auto pauses as soon as it sees a job that isn't ours (2.1). **Agreed in review.**
- **Verdicts are only as good as node CPU.** A traffic change on one shard in the verify window can mislabel a move. Since only `worse` rolls back, a mislabel costs a flag, a quarantine or a breaker count, not a second migration.
- **Unwatched nodes** rely on fresh stand-ins in Approve, which see less than the detectors (no history of failovers before the monitor started, no latency regression). Auto requires coverage.
- **`AnomalyService` is 13.6k lines.** **My call:** the controller, gate, verifier and actions live in a new `proprietary/placement/` module; `AnomalyService` exposes a narrow port: the latest sample, the verdicts, the open events by node, and the node read/write helpers.
- **Hash-tag names and key names leave the database** in messages and webhooks. They get the same caps and escaping as hot keys.

## Answered in review

The design was approved on the issue. Settled: the upgrade default, the tier, several monitors and automatic rollback are **Agreed in review**; installs without sign-in, unwatched nodes, network share and the default numbers are **Decided** (each is marked where it applies). The last three questions were answered in review:

1. **Managed provider accounts:** none needed. Managed providers stay unsupported with the reason, and there is no per-provider verification (2.8).
2. **Redis 8.4+ (`CLUSTER MIGRATION IMPORT`):** copy-only for now. Running it would need a second executor: the command is per target, and a failed task retries forever.
3. **Scale hooks:** the webhook is enough for phase 6; `ProvisioningHook` stays for a later `valkey-io/valkey-operator` integration (2.10).
