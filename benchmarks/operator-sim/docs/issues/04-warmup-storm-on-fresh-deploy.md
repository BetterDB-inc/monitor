# Collapse cluster-wide step changes into one finding to stop the alert storm when load arrives

**Suggested labels:** `enhancement`, `anomaly-detection`, `false-positive`, `cluster`, `webhooks`  ·  **Area:** `proprietary/anomaly-detection` (`anomaly.service.ts`, `spike-detector.ts`, `correlator.ts`)  ·  **Severity:** medium-high. On a fresh deploy, or whenever traffic moves on the whole cluster at once, every node raises its own WARNING or CRITICAL findings, each one dispatched to webhooks. In our test that was 176 findings in one minute, and a first-time user cannot tell any of them apart from a real incident.

> **Testing:** the harness used to find and reproduce this is on branch [`bench/operator-sim`](https://github.com/BetterDB-inc/monitor/tree/bench/operator-sim/benchmarks/operator-sim) (`benchmarks/operator-sim/`; start with its README). Raw run data (`runs/<id>/*.jsonl`) is not committed; re-run the commands in the test plan to regenerate it.

## Summary

Each connection has its own z-score detectors with a 300-sample (5-minute at 1 s polling) rolling baseline. When BetterDB is deployed onto an idle cluster, those baselines learn "idle". When application traffic then arrives, the same step change appears on every node at the same moment: ops/s, input KB/s, connected clients, memory, fragmentation and CPU all move. In our test, all 37 connections (the seed plus 36 auto-registered pods) fired independently: 237 non-slowlog findings in the 6-minute warm-up, 176 of them in a single minute. After the warm-up, the same deployment produced 0 findings outside fault windows over 34 minutes, so the detectors are sound once their baselines reflect real load. This issue proposes treating "the same metric moved the same way on most nodes of one cluster at the same time" as **one** finding, plus a re-baseline step so a single level shift is not re-reported every cooldown.

## How we found it

The findings come from a load-and-fault-injection harness that lives in this repo at [`benchmarks/operator-sim`](../../) (branch `bench/operator-sim`).

- **Cluster:** kind (Kubernetes v1.37.0) on one 16 vCPU host. valkey-operator v0.8.0, 12 shards × (1 primary + 2 replicas) = 36 Valkey 9.1.2 pods, 1M preloaded keys.
- **BetterDB:** Monitor v0.55.0 (plus local commit `173a4a3f`, the counter-rate fix), `CLUSTER_AUTO_REGISTER_NODES=true` → 37 connections, `ANOMALY_POLL_INTERVAL_MS=1000`. It was deployed onto the **idle** cluster about 5.5 minutes before the run started, so every baseline buffer was full of idle samples.
- **Load:** a 3000 req/s application mix plus about 1.5k req/s from memtier, starting 8.6 s after the run began. A 6-minute baseline (no faults) followed, then seven fault injections.
- **Run:** `runs/2026-11-11T14-01-50-665-s42`. The harness counts a finding as "unmatched" when it falls outside every fault's match window, and it ignores the first 30 s of the run.

## Observed behaviour

Unmatched findings during the 6-minute baseline (final run, harness accounting):

| | count |
|---|---|
| all | 315 (every unmatched finding in the run; 0 in the 34 minutes after the baseline) |
| slowlog-driven (`slowlog_last_id`, `slow_queries`) | 78 (covered by the issue on slowlog alerts from BetterDB's own polling) |
| **everything else** | **237, across all 37 connections** |

Non-slowlog findings per minute after the run started: `0–1 min: 39`, **`1–2 min: 176`**, `2–3: 12`, `3–4: 2`, `4–5: 0`, `5–6: 8`.

The busiest 60 s, by metric and by the number of distinct connections that fired:

| metric | findings | connections |
|---|---|---|
| `memory_used` | 37 | 37 |
| `fragmentation_ratio` | 36 | 36 |
| `cpu_utilization` | 35 | 35 |
| `ops_per_sec` | 32 | 32 |
| `input_kbps` | 31 | 31 |
| `connections` | 24 | 24 |
| groups (`memory_pressure`, `traffic_burst`, …) | 11 | – |

Typical messages: the first at load start, then the re-fires one cooldown later.

```
t=11.7s  CRITICAL: ops_per_sec spike detected. Value: 339, Baseline: 13 (2415.4% above normal, Z-score: 9.74)
t=11.7s  CRITICAL: input_kbps spike detected. Value: 17, Baseline: 1 (3248.7% above normal, Z-score: 9.91)
t=11.7s  WARNING: connections spike detected. Value: 45, Baseline: 40 (13.0% above normal, Z-score: 2.24)
t=87s    WARNING: ops_per_sec spike detected. Value: 472, Baseline: 103 (360.3% above normal, Z-score: 2.04)
```

Counting raw events with no 30 s grace, BetterDB emitted 427 non-slowlog anomaly events up to the end of the 6-minute baseline. Each one is persisted and handed to the webhook sink.

The same pattern happens with real cluster-wide traffic changes. The injected 3× traffic spike was detected correctly, but as dozens of per-node `ops_per_sec`, `input_kbps` and `cpu_utilization` findings, not as one.

## Expected behaviour

When BetterDB is deployed onto a cluster and load arrives, or traffic shifts on the whole cluster, the user sees **one** finding per metric that says it changed on most of the cluster, for example "ops_per_sec rose on 32 of 37 nodes of cluster `bz`", and receives one webhook per metric. A change confined to one node or shard is still reported per node, as today, so a hot shard stays visible. A single level shift is reported once, not again at every cooldown until the 5-minute window has caught up.

## Root cause

All references are to `origin/master` (7b29d758); the code is identical in v0.55.0.

- **Baselines are per connection and learn whatever they see first.** `proprietary/anomaly-detection/metric-buffer.ts:10-11` (`maxSamples = 300`, `minSamples = 30`) and `anomaly.service.ts:1192-1209` (one `MetricBuffer` and one `SpikeDetector` per metric per connection). After 30 idle samples the detector is "ready" (`metric-buffer.ts:26-28`), and after 300 its whole baseline is idle.
- **There is no cross-connection deduplication before persisting and alerting.** Every finding goes `detect()` → `addAnomaly()` (`anomaly.service.ts:1489-1493`, `:7613-7635`) → `writeAnomaly()` → `anomalyWebhookSink.dispatchAnomalyWebhook()` (`:7698`). The correlator (`correlator.ts:434-504`) partitions by cluster scope (`anomaly.service.ts:1024-1025`, `correlationScopeOf` at `:7934`) and groups anomalies into 5 s windows (`correlationIntervalMs = 5000`, `:990`). But that runs *after* each event has been persisted and webhooked, and it produces groups in addition to the events, not instead of them.
- **A level shift is re-reported.** After a step from 13 to 339 ops/s, the 300-sample window is a mix of idle and loaded samples for 5 minutes. When the cooldown expires (`spike-detector.ts:60-64`, 60 s by default per `anomaly.types.ts:98-105`), z is still above 2 (e.g. mean 103, stddev 181, value 472 → z = 2.04), so the detector fires again. That is where the second and third waves come from.
- **A longer warm-up would not have helped.** The buffers were already full (5.5 minutes of samples) when load started. The baseline was mature, it just described an idle cluster.

## Proposed change

**Recommendation:** (1) collapse cluster-wide spikes into one finding, and (2) re-baseline after a confirmed level shift. Both are listed under "Options considered" below.

### 1. Cluster-wide collapse (`fleet episode`)

New class `FleetSpikeCollapser` (`proprietary/anomaly-detection/fleet-spike-collapser.ts`), used by `AnomalyService` for spike-detector findings only, i.e. the z-score and threshold findings from `SpikeDetector`. State-based detectors are excluded (failover, role, topology, replication, …).

- Key: `(correlationScopeOf(connectionId), metricType, anomalyType)`.
- When a finding arrives and no episode is open for its key, open one with that finding as **leader**. The leader is persisted and webhooked as today, so there is no added detection latency.
- When a finding arrives within `ANOMALY_FLEET_WINDOW_MS` (default **10 000**) of an open episode's start, it becomes a **member**. It is persisted with `fleetEpisodeId = leader.id`, but it is **not** webhooked and is hidden from the default event list.
- When the window closes, if the episode has members on ≥ `ANOMALY_FLEET_MIN_FRACTION` (default **0.5**) of the scope's live connections and on at least `ANOMALY_FLEET_MIN_NODES` (default **3**), mark the leader `clusterWide: true` with `affectedConnections: n` and `scopeConnections: m`, and rewrite its message to `"<metric> spike on n of m nodes (cluster-wide). Example: <leader message>"`. Otherwise, release the members: webhook each of them as today. That way a two-shard incident still alerts per node, with at most a 10 s delay for nodes after the first.
- During `ANOMALY_FLEET_HOLD_MS` (default **300 000**, one buffer length) after a cluster-wide episode, later spike findings for the same key are absorbed into it (persisted, not webhooked). The exception is a finding that escalates severity or whose value exceeds the episode's maximum by more than the metric's floor (see the issue on z-score floors).
- Set `ANOMALY_FLEET_WINDOW_MS=0` to disable the feature.

UI: in the Anomalies list, show a cluster-wide leader as one row with an "n of m nodes" badge that expands to its members. `GET /api/anomaly/events` (`anomaly.controller.ts:57`) gains `includeFleetMembers=true` (default `false`) for API consumers that want every per-node row.

Storage: two nullable columns (or JSON fields) on stored anomaly events, `fleet_episode_id` and `cluster_wide`, added in the same way as other optional anomaly fields. Existing rows are unaffected.

### 2. Re-baseline after a confirmed level shift

In `SpikeDetector` or `AnomalyService`: when a metric has been above the z threshold for `levelShiftSamples` consecutive polls (default **30**, i.e. 30 s at 1 s polling) **and** fired at least once, trim the buffer to the post-shift samples. The detector is then compared with the new level and stops re-firing every cooldown. A later move away from that level is detected normally. This is a small, local change, and it applies to single-node level shifts too, for example a client fleet re-pointed to one node.

### Options considered

| option | effect on this storm | downside |
|---|---|---|
| Longer warm-up (`minSamples` 30 → 300+) | **none**: buffers were already full of idle data | delays real detection on every new connection |
| Suppress until the buffer has seen N minutes of "non-idle" data | would hide this storm | "idle" is hard to define, and it hides a real incident on a quiet cluster |
| Global startup grace (`ANOMALY_STARTUP_GRACE_MS`) | none here: load came 5.5 min after deploy | only covers the first minutes after a restart |
| **Cluster-wide collapse + re-baseline** (recommended) | 176 → about 6–8 per-metric findings in the busiest minute, and no second or third wave | needs a cluster scope (non-cluster standalone instances unaffected) |

## Acceptance criteria

- [ ] Unit: 10 connections in one scope each report an `ops_per_sec` spike within 2 s → 1 webhook dispatch, 10 persisted rows, a leader with `clusterWide: true` and `affectedConnections: 10`, and a message containing `on 10 of 10 nodes`.
- [ ] Unit: 2 of 10 connections report a spike within 2 s → after the window, both are webhooked (leader immediately, member at window close), and neither is marked cluster-wide.
- [ ] Unit: after a cluster-wide episode, a re-fire on the same key 60 s later is absorbed (no webhook). A CRITICAL re-fire after a WARNING episode is not absorbed.
- [ ] Unit: findings in different scopes (two clusters) never share an episode.
- [ ] Unit (level shift): with default settings (z 2/3, 3 consecutive, 60 s cooldown), 300 samples at 13 followed by a ramp of 240 samples `340 + 1.5·i` fires today at sample 302 (z ≈ 10) and again at sample 364 (value 436, baseline 94, z ≈ 2.2). With re-baselining it fires once, at sample 302.
- [ ] `ANOMALY_FLEET_WINDOW_MS=0` restores today's behaviour exactly (existing anomaly tests pass unchanged).
- [ ] Harness: the final-run equivalent shows ≤ 30 non-slowlog unmatched findings in the 6-minute warm-up (from 237), and all 7 injections are detected, including `hotShard`, which is a single-shard fault.

## Test plan

**Unit tests:** `proprietary/anomaly-detection/__tests__/fleet-spike-collapser.spec.ts` (pure class with an injected clock and scope-size lookup) covering the cases above. Add integration-style cases in `anomaly.service.spec.ts` using the existing multi-connection fixtures and `mockAnomalyWebhookSink`, and assert on `dispatchAnomalyWebhook` call counts.

**Harness reproduction.** The key step is deploying BetterDB onto an *idle* cluster and only then starting load, which is what `make up betterdb warm` followed by `make scenario` does:

```bash
cd benchmarks/operator-sim
SIM_OVERRIDES='{"betterdb":{"buildRef":"<your-branch>"}}' make up betterdb warm
sleep 330            # let BetterDB fill its 300-sample baselines on the idle cluster
PHASES=spike,hotShard make scenario     # 6-min baseline (load starts here) + a cluster-wide and a single-shard fault
make report
```

Check:
- `runs/<id>/SUMMARY.md`: the "Unmatched detections by metric" counts for `memory_used`, `fragmentation_ratio`, `cpu_utilization`, `ops_per_sec`, `input_kbps` and `connections` should be in single digits (final v0.55.0-based run: 37 / 37 / 48 / 32 / 35 / 24).
- `runs/<id>/findings.jsonl`: `spike` and `hotShard` are both `"detected": true`, and `hotShard`'s first match is on a pod of shard 7 (`nodeMatch: "exact"` or `"same-shard"`).
- `runs/<id>/betterdb.jsonl`: events with `clusterWide: true` appear at load start and during `spike`.

## Out of scope / open questions

- **Should the first leader wait for the window?** Waiting `ANOMALY_FLEET_WINDOW_MS` before dispatching the leader would let its first webhook already say "cluster-wide", at the cost of 10 s of detection latency. The proposal above dispatches immediately and updates afterwards. Would webhook consumers prefer a follow-up "updated" event?
- **Scope size during rolls.** During a rolling update, the number of live connections changes (children retire and re-register on new IPs). The fraction should use the connections that polled successfully in the window, not the registered count.
- **Per-connection duplication of state-based cluster findings** (`cluster_topology`, `node_failover` repeated by every connection during a roll) is a related but separate problem, tracked in #717. This proposal is limited to `SpikeDetector` findings.
- **Near-constant metrics** (fragmentation 1.01 → 1.02, CPU 1.7 % → 2.5 %) are part of this storm, but they are fixed by the floors in the issue on z-score floors. Both fixes are needed.

## References

- `proprietary/anomaly-detection/metric-buffer.ts:8-28`
- `proprietary/anomaly-detection/spike-detector.ts:55-64, :128-150`
- `proprietary/anomaly-detection/anomaly.service.ts:990, :1024-1025, :1192-1209, :1478-1494, :7613-7635, :7698, :7934`
- `proprietary/anomaly-detection/correlator.ts:434-528`
- `apps/api/src/anomaly/anomaly.types.ts:98-156`
- Harness: `benchmarks/operator-sim/FINDINGS.md` (final-run notes), run `2026-11-11T14-01-50-665-s42` (`betterdb.jsonl`, `SUMMARY.md`)
