# FINDINGS

Running log across runs. Tested on a 12-shard × 2-replica Valkey cluster on a single host (kind); synthetic workload; not prod numbers.

## Setup surprises (2026-11-10)

- Chaos Mesh 2.8.8 supports only K8s 1.35–1.37 → kind upgraded to v0.33.0 (repo-local `.bin/`), node image v1.37.0 pinned by digest.
- BetterDB PR #651 (headless-Service seed) unmerged in v0.54.0 / master → run uses a local build of #651 rebased on master (labelled "unreleased build" in SUMMARY).
- BetterDB v0.54.0 lacks `/api/anomaly/coverage` (#673) and per-node `nodeAddr` (#654); local build has #654.
- Operator v0.8.0 CRD uses `spec.replicas`; forces `cluster-allow-replica-migration no`, `cluster-replica-validity-factor 0`, `shutdown-on-sigterm failover`.
- Operator #533 (known issue): no-persistence in-place container restart can empty a shard → scenario uses pod-kill only.
- BetterDB Helm chart (0.51.1) lags the app (0.54.0).
- Phase 1: kind v0.33.0 / K8s v1.37.0, 1 CP + 6 workers across 3 fake zones, metrics-server 0.9.0: `kubectl top` OK.
- Phase 2: operator v0.8.0 → ValkeyCluster `bz` 12×(1+2) Ready in ~60 s (Initializing → UpdatingNodes → AddingNodes → ClusterHealthy). All `spec.config` keys applied (maxmemory, slowlog/commandlog 10 ms, latency-monitor 10 ms, enable-debug-command local). Default user is `nopass +@all`; operator adds `_operator`, `_exporter`, `_replication` users. Pods export `VALKEYCLI_AUTH`, so bare `valkey-cli` prints AUTH warnings.
- Placement: node.spread.shard=Required satisfied for all 12 shards; zone.spread.shard=Preferred leaves shard 4 with primary+replica both in zone-a (6 workers / 3 zones).
- `enable-debug-command local` means DEBUG SLEEP only works via `kubectl exec`, not from app clients → slowCommands uses `bigSet` by default.
- Phase 4 run 1 (failed): memtier `--key-zipf-exp 1` over 100k keys put ~3× memtier GET/SET on shard 8 (+77% cmds/s vs mean) → exponent lowered to 0.4. App-gen paced on fixed 10 ms ticks under-delivered (2559/3000 RPS) → paced on elapsed time. Client p99 median 47 ms / p95 236 ms while server usec_per_call was 5–30 µs: client-side/host contention (host load avg ~40 on 16 cores; non-sim processes using ~4 cores).
- BetterDB license key rejected by the entitlement server (`Invalid license key`) → tier community; anomaly APIs return 402. Steady-state FP check reported as "unavailable", not as zero FPs.
- Phase 3: seed = operator headless Service; 36/36 children auto-registered and connected within 1 sync; zero register/retire churn over 300 s → PR #651 regression check passes on the local build (0.54.0-pr651.280ca92d.3ca8f8dc). `/api/anomaly/coverage` 402 (license).
- Phase 4 run 3: per-primary cmds/s within ±2.8% (mean 1532), app-gen 2998/3000 ops/s, 0 errors. Client p99 median 50 ms / p95 202 ms; memtier (independent C client) p50 7.3 / p99 63 / p99.9 116 ms → tail is host/kind contention, not the generator or Valkey (usec_per_call ≤ 30 µs). Fails the p99-stability check; record, don't tune the threshold away.
- License: second key validates (enterprise, expires 2027-02-03); anomaly APIs available. `betterdb` now restarts the pod when the key in the Secret changes.
- BetterDB v0.55.0 released 2026-11-10 with #651/#654/#673/#682 → switched from the local build to the released `0.55.0-no-ai` image (chart 0.51.1 + tag override).
- Phase 3 (v0.55.0) PASS: headless-Service seed, 36/36 children registered + connected, coverage 37 entries all `no_targets` (= every primary monitored as its own connection — the healthy state with auto-register, not a gap), 36/36 children feeding anomaly buffers, zero churn over 300 s.

### Phase 4 run 4 — first steady-state with anomaly detection on (2026-11-10T16:36Z, 300 s, nothing injected)

479 BetterDB events across all 37 connections. Classified against ground truth:

| metric | events | when | verdict |
|---|---|---|---|
| slowlog_last_id | 221 | spread over whole window | **true signal, environmental**: SLOWLOG shows plain GET/HGET/SET/ZADD at 10–23 ms (threshold 10 ms). Valkey descheduled on an oversubscribed host (load avg ~32 on 16 cores; non-sim apps ~4 cores). Will mask the slowCommands phase unless host contention drops. |
| ops_per_sec, input_kbps, connections, cpu_utilization, output_kbps | ~205 | 90% in first 120 s | **harness error**: BetterDB restarted ~10 min earlier with no load; settle was 60 s, so the window opened while z-score buffers still held the idle baseline. settleSec → 360. Not counted against BetterDB. |
| keyspace_misses | 53 | steady, all 5 min | **BetterDB false positive (product bug)**: v0.55.0 `anomaly.service.ts:1150` z-scores the cumulative `keyspace_misses` INFO counter (same for `evicted_keys`, `acl_access_denied_auth`). Monotonic growth always exceeds the trailing mean → "CRITICAL … 0.3% above normal". Will also make memoryPressure (evicted_keys) "detect" trivially. |
| command_p99, load_saturation | 3 | — | consistent with host contention; not yet attributed |

Per-node `nodeAddr` is absent on these events (v0.55.0); attribution is by `connectionId` (each child = one pod).
- Host: killed idle `atomix-server` (26 days up, ~1 core) at user's request; load avg 28 → 15.
- `CLUSTER SLOT-STATS ORDERBY cpu-usec` needs `cluster-slot-stats-enabled yes` (not live-settable). Adding it rolled all 36 pods via the operator in 506 s under app-gen load; total keys on primaries 1,112,808 → 1,113,145 (no loss; growth = rate-limit keys written during the roll); cluster_state ok, 36 known nodes after.
- GLIDE standalone client won't connect to a replica-only address ("No primary node found", also with readFrom=preferReplica) → ground truth uses a 120-line RESP2 client (`src/resp.ts`), one socket per node.
- Phase 5 PASS: 40 s smoke → 36/36 pods, primaries @1 s / replicas @5 s, CLUSTER SHARDS @5 s, SLOT-STATS cpu-usec top-20 @10 s, slowlog/commandlog deltas by id (entries before collector start excluded), LATENCY LATEST only on change, 0 collector errors.
- **Gossip view divergence after operator roll (real, not harness):** 39 min after the 17:45 slot-stats roll, `valkey-bz-5-1-0` (shard 5) reports `role:slave` of 5-2-0 and 19 nodes agree, but **16 of 35 peers still list it in CLUSTER NODES as `master` with no slots**. cluster_state stays ok. Ground truth now records a per-node `cluster_view` (primaries with slots / slotless `master` entries) every 5 s. To check: is this Valkey 9.1.2 gossip (role change not re-announced) or an operator CLUSTER REPLICATE path? Does BetterDB flag it (ghost_membership / cluster_topology)?
- Smoke run 1 hung: harness `topology()` took the slotless "master" as shard 5's primary → `tagForShard` looped forever (100% CPU, found via inspector stack). Fixed: only slot owners count; tag search bounded; throws on a slotless shard. maxmemory on 5-2-0 restored by hand (the run never reached revert).

<!-- run:smoke-2 -->
## Run smoke-2 (2026-11-10T18:21:48.429Z)

> Tested on a 12-shard × 2-replica Valkey cluster on a single host (kind); synthetic workload; **not prod numbers**. Times are detection latencies on this rig, not SLAs.

**Setup.** 12 shards × (1 + 2) = 36 pods, cluster mode, valkey-operator 0.8.0, `valkey/valkey:9.1.2`, maxmemory 256mb/node, no persistence. kind v1.37.0 on 16 vCPU / 63 GiB, linux 6.6.144-3-MANJARO. BetterDB `betterdb/monitor:0.55.0-173a4a3f-no-ai`, headless-Service seed, 36 auto-registered node connections, 1 s anomaly poll. Load: app-gen 3000 rps (GLIDE, messaging mix) + memtier 128 req/s; 1,000,000 keys preloaded.

**Result: 5/6 injections detected on target; 194 unmatched detections (false positives) — connections ×37, cpu_utilization ×37, input_kbps ×37, ops_per_sec ×37.**

| phase | target | detected | inject→detect | onset→detect | what BetterDB said | ground truth |
|---|---|---|---|---|---|---|
| spike | cluster | **no** | — | — | **MISS** | ops/s 33894 → peak 29294 |
| hotShard | shard 7 | yes (exact) | 4.9 s | 2.1 s | critical traffic_burst @valkey-bz-7-1-0: High operations spike detected | ops/s 2079 → peak 5808 |
| slowCommands | shard 3 | yes (same-shard) | 8.3 s | 6.9 s | critical slowlog_last_id @valkey-bz-3-1-0: CRITICAL: slowlog_last_id spike detected. Value: 1, Baseline: 0 (2900.0% above normal, Z-s; group slow_queries: Slow query rate spike detected — elevated rate of new slow queries per | 8 slowlog entries, max 40 ms |
| memoryPressure | shard 5 | yes (exact) | 3.9 s | 3.1 s | critical keyspace_misses @valkey-bz-5-2-0: CRITICAL: keyspace_misses spike detected. Value: 152/s, Baseline: 2.21/s (6766.7% above no; group memory_pressure: Memory fragmentation spike detected | 102634 keys evicted; maxmemory seen 67108864/268435456 |
| replicaLag | shard 9 | yes (exact) | 7.0 s | -1.2 s | critical backlog_coverage_risk @valkey-bz-9-1-0: Replication backlog covers only 3.0s of writes at 3472653 bytes/s: a replica disconnected  | max lag 44.4 MiB, link-down samples 0 |
| primaryKill | shard 2 | yes (exact) | 1.8 s | -1.9 s | warning node_failover @valkey-bz-2-2-0: Node failover detected — this instance transitioned role | valkey-bz-2-2-0 promoted after 3.7 s |

"onset→detect" measures from the first ground-truth signal (e.g. first eviction, first slowlog entry, replica promotion), which is the fairer number; negative = BetterDB flagged before our 1 s/5 s truth sampling saw it.

**Misses and false positives.** spike (expected traffic_burst) Unmatched detections by metric: connections 37, cpu_utilization 37, group:slow_queries 1, group:traffic_burst 1, group:unknown 1, input_kbps 37, ops_per_sec 37, output_kbps 12, slowlog_last_id 31.

**Operator lifecycle observations.**
- Primary kill (shard 2): valkey-bz-2-2-0 promoted after 3.7 s; BetterDB flagged node_failover after 1.8 s.
- Rolling update not run.

**Next steps.** Repeat on dedicated hardware to remove host-contention noise; run the hard-kill variant; compare stock v0.55.0 against the counter-rate fix branch on the same timeline.

<!-- /run:smoke-2 -->
- smoke-2 (4:40 shortened timeline, fix build 0.55.0-173a4a3f): runner/collectors/report work end-to-end, 0 harness failures, cluster Ready after. Graceful primary kill → replica promoted in 3.8 s, shard Ready in 20 s; BetterDB node_failover 1.8 s after the delete.
- **memtier `--rate-limiting` in `--cluster-mode` is per shard connection**: 8 clients × 4 threads × 12 shards × 50 = ~19k req/s (memtier.json showed 14.9k ops/s), not the 1,600 assumed — memtier, not app-gen, dominated load. On this host tripling app-gen then *lowered* cluster ops (37k → 28.5k/s) by starving memtier, so the spike was invisible server-side. ratePerConn 50 → 4 (≈1.5k req/s).
- smoke-2 spike miss is also a harness artifact: load (re)start at T+20–30 s fired 37 ops_per_sec/connections events at T+36 s whose 60 s cooldown covered the spike at T+64 s. Full runs use a 360 s baseline.
- **BetterDB FP class: fragmentation_ratio** CRITICAL on 1.01 → 1.02 ("1.0% above normal, Z-score 7.68") — z-score on a near-constant gauge with no minimum relative-change floor. Fix branch's counter-rate change confirmed working: "keyspace_misses … Value: 2.10K/s, Baseline: 17/s".
- Report bug fixed: the "what BetterDB said" cell paired the first metric's label with a correlated group's diagnosis ("keyspace_misses: Memory fragmentation spike").
- **BetterDB UI reflects the stale gossip view:** Cluster page reads "Monitoring 13 master nodes and 23 replicas" for a 12-shard cluster — the seed's CLUSTER NODES still lists the demoted 5-1-0 as a slotless `master`. Displayed, not flagged (no ghost_membership / cluster_topology event). Candidate BetterDB improvement: count only slot owners as primaries and alert on cross-node view disagreement.
- Screenshot curation: the global /anomalies list is dominated by P99-regression cards for `cluster|shards` / `cluster|nodes` (monitoring traffic itself) — not useful for a reader; per-node `/anomalies?connection=<id>` (summary cards, replication divergence, timeline, by-metric) is the useful view.

<!-- run:2026-11-10T18-35-22-462-s42 -->
## Run 2026-11-10T18-35-22-462-s42 (2026-11-10T18:35:22.462Z)

> Tested on a 12-shard × 2-replica Valkey cluster on a single host (kind); synthetic workload; **not prod numbers**. Times are detection latencies on this rig, not SLAs.

**Setup.** 12 shards × (1 + 2) = 36 pods, cluster mode, valkey-operator 0.8.0, `valkey/valkey:9.1.2`, maxmemory 256mb/node, no persistence. kind v1.37.0 on 16 vCPU / 63 GiB, linux 6.6.144-3-MANJARO. BetterDB `betterdb/monitor:0.55.0-173a4a3f-no-ai`, headless-Service seed, 36 auto-registered node connections, 1 s anomaly poll. Load: app-gen 3000 rps (GLIDE, messaging mix) + memtier 128 req/s; 1,000,000 keys preloaded.

**Result: 6/6 injections detected on target; 957 unmatched detections (false positives) — cluster_topology ×676, slowlog_last_id ×54, memory_used ×45, cpu_utilization ×27.** Harness failures: rollingUpdate: Command failed with exit code 1: kubectl --context kind-bz-sim -n valkey exec valkey-bz-0-0-0 -c server -- env -u VALKEYCLI_AUTH valkey-cli cluster nodes  error: unable to upgrade connection: container not found ("server").

| phase | target | detected | inject→detect | onset→detect | what BetterDB said | ground truth |
|---|---|---|---|---|---|---|
| spike | cluster | yes (exact) | 4.2 s | 2.1 s | warning cpu_utilization @valkey-bz-0-1-0: WARNING: cpu_utilization spike detected. Value: 3, Baseline: 2 (62.5% above normal, Z-scor; group traffic_burst: High operations spike detected | ops/s 5737 → peak 14364 |
| hotShard | shard 7 | yes (same-shard) | 5.3 s | 3.5 s | critical ops_per_sec @valkey-bz-7-2-0: CRITICAL: ops_per_sec spike detected. Value: 2.23K, Baseline: 340 (556.5% above normal, Z-; group traffic_burst: High operations spike detected | ops/s 486 → peak 4607 |
| slowCommands | shard 3 | yes (exact) | 14.8 s | 14.0 s | critical slow_queries @valkey-bz-3-2-0: Slow query rate spike detected — elevated rate of new slow queries per interval | 40 slowlog entries, max 153 ms |
| memoryPressure | shard 5 | yes (exact) | 1.4 s | 0.6 s | critical evicted_keys @valkey-bz-5-2-0: CRITICAL: evicted_keys spike detected. Value: 34.72K/s, Baseline: 149/s (23148.6% above no | 236180 keys evicted; maxmemory seen 67108864/268435456 |
| replicaLag | shard 9 | yes (exact) | 7.9 s | -0.3 s | critical backlog_coverage_risk @valkey-bz-9-1-0: Replication backlog covers only 3.2s of writes at 3238291 bytes/s: a replica disconnected ; group replication_divergence: Sustained replication divergence alongside CPU saturation, write-rate  | max lag 253.5 MiB, link-down samples 4 |
| primaryKill | shard 2 | yes (exact) | 1.3 s | -3.5 s | warning node_failover @valkey-bz-2-0-0: Node failover detected — this instance transitioned role | valkey-bz-2-0-0 promoted after 4.8 s |

"onset→detect" measures from the first ground-truth signal (e.g. first eviction, first slowlog entry, replica promotion), which is the fairer number; negative = BetterDB flagged before our 1 s/5 s truth sampling saw it.

**Misses and false positives.** No misses. Unmatched detections by metric: cluster_state 14, cluster_topology 676, connections 14, cpu_utilization 27, evicted_keys 3, fragmentation_ratio 27, group:batch_job 1, group:connection_leak 9, group:memory_pressure 14, group:node_failover 14, group:slow_queries 7, group:traffic_burst 6, group:unknown 16, input_kbps 3, keyspace_misses 1, memory_used 45, ops_per_sec 3, output_kbps 14, replication_role 9, slowlog_last_id 54.

**Operator lifecycle observations.**
- Primary kill (shard 2): valkey-bz-2-0-0 promoted after 4.8 s; BetterDB flagged node_failover after 1.3 s.
- Rolling update not run.

**Next steps.** Repeat on dedicated hardware to remove host-contention noise; run the hard-kill variant; compare stock v0.55.0 against the counter-rate fix branch on the same timeline.

<!-- /run:2026-11-10T18-35-22-462-s42 -->
- **Full run 2026-11-10T18-35-22-462-s42**: 6/6 of spike…primaryKill detected on target (see its section). rollingUpdate's roll completed (cluster Ready 19:13) but the phase failed in the harness before its `start` event (topology() exec'd into a pod the roll was restarting) → the roll's ~740 detections (cluster_topology 676, node_failover groups 14, replication_role 9 …) are mis-filed as FPs in that run's report. Not patched after the fact; fixed (topology() tries each pod; snapshot before patch) and rollingUpdate re-run separately.
- BetterDB emitted **676 cluster_topology events in ~10 min** during the 36-pod roll (across 37 connections) — correct signal, but volume worth de-duplicating cluster-wide.
- Screenshots must be live: after a roll/reset every pod has a new IP, the old per-node connections are retired, and `/anomalies?connection=<retired id>` silently falls back to the seed (global list). Phase-end captures now use `/anomalies?connection=<live id>&start=<phase−30 s>&end=<now>` + `/cluster`, waiting for the page heading; the prospect pack reuses those.
- The /dashboard route rendered blank at 3 s settle in the first full run's captures — dropped in favour of the scoped anomalies view.

<!-- run:2026-11-10T19-26-16-778-s42 -->
## Run 2026-11-10T19-26-16-778-s42 (2026-11-10T19:26:16.778Z)

> Tested on a 12-shard × 2-replica Valkey cluster on a single host (kind); synthetic workload; **not prod numbers**. Times are detection latencies on this rig, not SLAs.

**Setup.** 12 shards × (1 + 2) = 36 pods, cluster mode, valkey-operator 0.8.0, `valkey/valkey:9.1.2`, maxmemory 256mb/node, no persistence. kind v1.37.0 on 16 vCPU / 63 GiB, linux 6.6.144-3-MANJARO. BetterDB `betterdb/monitor:0.55.0-173a4a3f-no-ai`, headless-Service seed, 36 auto-registered node connections, 1 s anomaly poll. Load: app-gen 3000 rps (GLIDE, messaging mix) + memtier 128 req/s; 1,000,000 keys preloaded.

**Result: 1/1 injections detected on target; 22 unmatched detections (false positives) — slowlog_last_id ×17, group:slow_queries ×5.**

| phase | target | detected | inject→detect | onset→detect | what BetterDB said | ground truth |
|---|---|---|---|---|---|---|
| rollingUpdate | cluster | yes (cluster-wide) | 35.5 s | -3.1 s | critical node_failover: Node failover detected with correlated slowlog spike — the slow queries are likely caused  | 12/12 shards promoted; 12 shards had a primary with 0 attached replicas |

"onset→detect" measures from the first ground-truth signal (e.g. first eviction, first slowlog entry, replica promotion), which is the fairer number; negative = BetterDB flagged before our 1 s/5 s truth sampling saw it.

**Misses and false positives.** No misses. Unmatched detections by metric: group:slow_queries 5, slowlog_last_id 17.

**Operator lifecycle observations.**
- Primary kill not run.
- Rolling update took 526.7 s; first/last shard promotion at 38.5 s / 508.4 s.
- Primary with zero attached replicas during the roll (1 s sampling of connected_slaves; cf. operator #563) in 12/12 shards — longest per shard: shard 0 9 s, shard 1 9 s, shard 2 8 s, shard 3 12 s, shard 4 6 s, shard 5 6 s, shard 6 13 s, shard 7 6 s, shard 8 8 s, shard 9 7 s, shard 10 7 s, shard 11 6 s.
- Spans with no replica reporting master_link_status:up (5 s sampling): shard 0: 5–20 s; shard 1: 50–65 s; shard 2: 95–110 s; shard 3: 130–150 s; shard 4: 175–190 s; shard 5: 220–230 s; shard 6: 260–285 s; shard 7: 310–325 s; shard 8: 350–370 s; shard 9: 395–410 s; shard 10: 440–455 s; shard 11: 480–495 s.

**Next steps.** Repeat on dedicated hardware to remove host-contention noise; run the hard-kill variant; compare stock v0.55.0 against the counter-rate fix branch on the same timeline.

<!-- /run:2026-11-10T19-26-16-778-s42 -->

### Operator roll: every shard briefly had no attached replica (run 2026-11-10T19-26-16-778-s42)

Operator v0.8.0 roll 9.1.2 → 9.1.3, 36 pods, 527 s end to end, one shard at a time: replicas first, then a failover onto a rolled replica, then the old primary. Failovers always landed on a synced replica. But from the primary's own `connected_slaves` (1 s sampling), **every shard's primary had zero attached replicas for 6–13 s** (longest run per shard: 9, 9, 8, 12, 6, 6, 13, 6, 8, 7, 7, 6 s; 124 s total), and up to ~20 s with no *synced* replica.

Mechanism, shard 3 (times from roll start): replica 3-0-0 restarted ~124 s; the new pod reports `role:master`, empty, until it is re-joined at 142.8 s — but Kubernetes marked it Ready at 133 s and the operator restarted the **second** replica 3-2-0 at ~130 s. Primary 3-1-0 shows `connected_slaves:0` from 130.8 s to 141.8 s; first replica back in sync at 150.8 s; failover to 3-2-0 at 160.9 s. Without persistence, losing the primary inside that window loses the shard. This is the situation operator issue #563 describes (fix PR #562 unmerged as of 2026-11-10). Evidence: `runs/2026-11-10T19-26-16-778-s42/groundtruth.jsonl` (`connected_slaves`, `master_link_status`, `role_change`) + `events.jsonl` (`pod rolled`, `primary moved`).

BetterDB during the roll: first node_failover (cluster-wide group, "with correlated slowlog spike") 35.5 s after the patch, 3.1 s before our first sampled promotion; no finding specifically for "primary with zero replicas" — a detector worth adding (state-based, from INFO replication).

<!-- run:2026-11-10T19-54-07-874-s42 -->
## Run 2026-11-10T19-54-07-874-s42 (2026-11-10T19:54:07.874Z)

> Tested on a 12-shard × 2-replica Valkey cluster on a single host (kind); synthetic workload; **not prod numbers**. Times are detection latencies on this rig, not SLAs.

**Setup.** 12 shards × (1 + 2) = 36 pods, cluster mode, valkey-operator 0.8.0, `valkey/valkey:9.1.2`, maxmemory 256mb/node, no persistence. kind v1.37.0 on 16 vCPU / 63 GiB, linux 6.6.144-3-MANJARO. BetterDB `betterdb/monitor:0.55.0-173a4a3f-no-ai`, headless-Service seed, 36 auto-registered node connections, 1 s anomaly poll. Load: app-gen 3000 rps (GLIDE, messaging mix) + memtier 128 req/s; 1,000,000 keys preloaded.

**Result: 7/7 injections detected on target; 59 unmatched detections (false positives) — slowlog_last_id ×49, group:slow_queries ×6, connections ×1, fragmentation_ratio ×1.**

| phase | target | detected | inject→detect | onset→detect | what BetterDB said | ground truth |
|---|---|---|---|---|---|---|
| spike | cluster | yes (exact) | 4.2 s | 2.6 s | warning cpu_utilization @valkey-bz-0-1-0: WARNING: cpu_utilization spike detected. Value: 2, Baseline: 2 (44.4% above normal, Z-scor; group traffic_burst: High operations spike detected | ops/s 5738 → peak 14287 |
| hotShard | shard 7 | yes (same-shard) | 5.1 s | 3.3 s | critical input_kbps @valkey-bz-7-2-0: CRITICAL: input_kbps spike detected. Value: 112, Baseline: 32 (245.2% above normal, Z-scor; group traffic_burst: High operations spike detected | ops/s 483 → peak 4562 |
| slowCommands | shard 3 | yes (exact) | 23.8 s | 22.7 s | critical slowlog_last_id @valkey-bz-3-0-0: CRITICAL: slowlog_last_id spike detected. Value: 28, Baseline: 0 (28865.5% above normal, Z; group slow_queries: Slow query rate spike detected — elevated rate of new slow queries per | 40 slowlog entries, max 293 ms |
| memoryPressure | shard 5 | yes (exact) | 3.6 s | 3.3 s | critical keyspace_misses @valkey-bz-5-2-0: CRITICAL: keyspace_misses spike detected. Value: 83/s, Baseline: 12/s (617.9% above normal | 236096 keys evicted; maxmemory seen 67108864/268435456 |
| replicaLag | shard 9 | yes (exact) | 6.7 s | 1.7 s | critical backlog_coverage_risk @valkey-bz-9-2-0: Replication backlog covers only 3.2s of writes at 3260439 bytes/s: a replica disconnected ; group replication_divergence: Sustained replication divergence alongside write-rate spike, memory gr | max lag 249.0 MiB, link-down samples 4 |
| primaryKill | shard 2 | yes (exact) | 1.8 s | -4.6 s | warning node_failover @valkey-bz-2-0-0: Node failover detected — this instance transitioned role | valkey-bz-2-0-0 promoted after 6.4 s |
| rollingUpdate | cluster | yes (cluster-wide) | 39.0 s | 0.6 s | critical replication_role: CRITICAL: Node role changed from master to replica — possible failover or split-brain dete; group node_failover: Node failover detected — this instance transitioned role | 12/12 shards promoted; 12 shards had a primary with 0 attached replicas |

"onset→detect" measures from the first ground-truth signal (e.g. first eviction, first slowlog entry, replica promotion), which is the fairer number; negative = BetterDB flagged before our 1 s/5 s truth sampling saw it.

**Misses and false positives.** No misses. Unmatched detections by metric: connections 1, fragmentation_ratio 1, group:connection_leak 1, group:memory_pressure 1, group:slow_queries 6, slowlog_last_id 49.

**Operator lifecycle observations.**
- Primary kill (shard 2): valkey-bz-2-0-0 promoted after 6.4 s; BetterDB flagged node_failover after 1.8 s.
- Rolling update took 489.3 s; first/last shard promotion at 38.4 s / 471.7 s.
- Primary with zero attached replicas during the roll (1 s sampling of connected_slaves; cf. operator #563) in 12/12 shards — longest per shard: shard 0 10 s, shard 1 9 s, shard 2 6 s, shard 3 25 s, shard 4 9 s, shard 5 20 s, shard 6 9 s, shard 7 7 s, shard 8 9 s, shard 9 9 s, shard 10 13 s, shard 11 13 s.
- Spans with no replica reporting master_link_status:up (5 s sampling): shard 0: 10–25 s; shard 1: 55–70 s; shard 2: 95–105 s; shard 3: 145–160 s; shard 4: 180–200 s; shard 5: 215–230 s, 235–265 s; shard 6: 250–265 s; shard 7: 280–295 s; shard 8: 325–335 s; shard 9: 355–370 s; shard 10: 395–420 s; shard 11: 445–465 s.

**Next steps.** Repeat on dedicated hardware to remove host-contention noise; run the hard-kill variant; compare stock v0.55.0 against the counter-rate fix branch on the same timeline.

<!-- /run:2026-11-10T19-54-07-874-s42 -->

### Corrections before sharing (2026-11-11)

- **Baseline slowlog noise is BetterDB alerting on its own polling, not host contention** (full run 19-54-07): all 55 slowlog-driven findings outside injection windows came in 6 waves ~60 s apart (30, 91, 151, 212, 302, 362 s), all inside the 6-min baseline, none after. Each is "Value: 1–2, Baseline: 0 → CRITICAL". On primaries (where ground truth samples SLOWLOG), 7 of the 9 baseline entries are BetterDB's own commands (`LATENCY HISTOGRAM`, `CLUSTER NODES`, `CLUSTER SHARDS`, 11–30 ms). Replica slowlog isn't sampled, so that part is inferred from the identical timing. Product fixes: ignore BetterDB's own client in slowlog-derived detection; minimum-count floor on near-zero baselines. The earlier "plain GETs at 10–23 ms" observation is from Phase 4 run 4 under heavy host contention (WoW running) and does not describe this run.
- **Zero-replica windows during rolls:** 12/12 shards in all three rolls (18-35-22: 7–37 s over an imprecise window because the phase lost its start event; 19-26-16: 6–13 s; 19-54-07: 6–25 s).
- **Ghost slotless master, harness check:** node IDs never changed IP and no IP was reused by another ID (no missing CLUSTER FORGET); the harness sends no membership commands. Transient slotless `master` entries (5–45 s) for every restarted pod in every roll = the pre-join empty-master state. Persistent entries (demoted primary still listed as slotless master by part of the cluster until run end; the node itself reports replica and its offset tracks the primary) in 3 of 4 rolls; none in the control roll (19-26-16, fresh reset, no prior fault phases). Minimal kubectl-only repro (no BetterDB, no load): `scripts/repro-ghost-master.sh`, results in runs/repro-ghost/.
- kind node containers were stopped externally (exit 137/130) ~4 h before 2026-11-11 14:53; cluster recreated with `make down && make up`.
- **Ghost slotless master — clean repro (2026-11-11, `scripts/repro-ghost-master.sh`, kind + operator v0.8.0 only: no BetterDB, no load, no injectors, 1M keys preloaded):** 3 image rolls (9.1.3 → 9.1.2 → 9.1.3). Rolls 1–2 clean; after roll 3, from Ready through the full 300 s observation, 7/36 nodes (all of shards 0 and 1 plus shard-mate 2-2-0) list `valkey-bz-2-1-0` (6758063…) as `master` with no slots and **config epoch 146**, while the node itself reports `myself,slave … 145` (`role:slave`, replicating). Its config epoch went *backwards* (146 → 145) — consistent with the pod restarting on a nodes.conf saved before it took epoch 146; peers then keep the higher-epoch master claim. Evidence: runs/repro-ghost/{ghost.log,evidence.txt}. Frequency: 1/3 rolls here, 3/4 earlier. Candidate for an operator (or Valkey) issue.

<!-- run:2026-11-11T14-01-50-665-s42 -->
## Run 2026-11-11T14-01-50-665-s42 (2026-11-11T14:01:50.665Z)

> Tested on a 12-shard × 2-replica Valkey cluster on a single host (kind); synthetic workload; **not prod numbers**. Times are detection latencies on this rig, not SLAs.

**Setup.** 12 shards × (1 + 2) = 36 pods, cluster mode, valkey-operator 0.8.0, `valkey/valkey:9.1.2`, maxmemory 256mb/node, no persistence. kind v1.37.0 on 16 vCPU / 63 GiB, linux 6.6.144-3-MANJARO. BetterDB `betterdb/monitor:0.55.0-173a4a3f-no-ai`, headless-Service seed, 36 auto-registered node connections, 1 s anomaly poll. Load: app-gen 3000 rps (GLIDE, messaging mix) + memtier 128 req/s; 1,000,000 keys preloaded.

**Result: 7/7 injections detected on target; 315 unmatched detections (false positives) — slowlog_last_id ×73, cpu_utilization ×48, fragmentation_ratio ×37, memory_used ×37.**

| phase | target | detected | inject→detect | onset→detect | what BetterDB said | ground truth |
|---|---|---|---|---|---|---|
| spike | cluster | yes (exact) | 3.3 s | 2.5 s | critical ops_per_sec @valkey-bz-5-0-0: CRITICAL: ops_per_sec spike detected. Value: 560, Baseline: 221 (153.3% above normal, Z-sc; group traffic_burst: High operations spike detected | ops/s 5633 → peak 14315 |
| hotShard | shard 7 | yes (same-shard) | 4.8 s | 2.7 s | critical input_kbps @valkey-bz-7-1-0: CRITICAL: input_kbps spike detected. Value: 105, Baseline: 33 (215.2% above normal, Z-scor; group traffic_burst: Traffic burst detected with increased connections and operations | ops/s 489 → peak 4565 |
| slowCommands | shard 3 | yes (cluster-wide) | 12.0 s | 10.8 s | critical slowlog_last_id: CRITICAL: slowlog_last_id spike detected. Value: 3, Baseline: 0 (12757.1% above normal, Z-; group slow_queries: Slow query rate spike detected — elevated rate of new slow queries per | 40 slowlog entries, max 385 ms |
| memoryPressure | shard 5 | yes (exact) | 3.1 s | 2.8 s | critical keyspace_misses @valkey-bz-5-2-0: CRITICAL: keyspace_misses spike detected. Value: 102/s, Baseline: 11/s (830.2% above norma; group memory_pressure: Memory fragmentation spike detected | 234921 keys evicted; maxmemory seen 67108864/268435456 |
| replicaLag | shard 9 | yes (exact) | 6.5 s | 0.8 s | critical backlog_coverage_risk @valkey-bz-9-2-0: Replication backlog covers only 3.3s of writes at 3201064 bytes/s: a replica disconnected  | max lag 248.6 MiB, link-down samples 4 |
| primaryKill | shard 2 | yes (exact) | 4.7 s | 1.9 s | warning replication_role @valkey-bz-2-0-0: WARNING: Node promoted from replica to master — failover completed; group node_failover: Node failover detected — this instance transitioned role | valkey-bz-2-0-0 promoted after 2.9 s |
| rollingUpdate | cluster | yes (cluster-wide) | 38.8 s | -2.8 s | critical node_failover: Node failover detected — this instance transitioned role | 12/12 shards promoted; 12 shards had a primary with 0 attached replicas |

"onset→detect" measures from the first ground-truth signal (e.g. first eviction, first slowlog entry, replica promotion), which is the fairer number; negative = BetterDB flagged before our 1 s/5 s truth sampling saw it.

**Misses and false positives.** No misses. Unmatched detections by metric: connections 24, cpu_utilization 48, fragmentation_ratio 37, group:batch_job 1, group:cache_thrashing 2, group:memory_pressure 8, group:slow_queries 5, group:traffic_burst 3, group:unknown 5, input_kbps 35, keyspace_misses 5, memory_used 37, ops_per_sec 32, slowlog_last_id 73.

**Operator lifecycle observations.**
- Primary kill (shard 2): valkey-bz-2-0-0 promoted after 2.9 s; BetterDB flagged replication_role after 4.7 s.
- Rolling update took 520.7 s; first/last shard promotion at 41.7 s / 495.7 s.
- Primary with zero attached replicas during the roll (1 s sampling of connected_slaves; cf. operator #563) in 12/12 shards — longest per shard: shard 0 8 s, shard 1 7 s, shard 2 27 s, shard 3 14 s, shard 4 9 s, shard 5 7 s, shard 6 14 s, shard 7 7 s, shard 8 14 s, shard 9 8 s, shard 10 9 s, shard 11 7 s.
- Spans with no replica reporting master_link_status:up (5 s sampling): shard 0: 10–30 s; shard 1: 55–70 s; shard 2: 100–115 s, 125–165 s; shard 3: 140–165 s; shard 4: 195–215 s; shard 5: 235–250 s; shard 6: 265–290 s; shard 7: 270–275 s, 315–325 s; shard 8: 270–275 s, 360–380 s; shard 9: 270–275 s, 400–415 s; shard 10: 270–275 s, 445–460 s; shard 11: 270–275 s, 475–490 s.

**Next steps.** Repeat on dedicated hardware to remove host-contention noise; run the hard-kill variant; compare stock v0.55.0 against the counter-rate fix branch on the same timeline.

<!-- /run:2026-11-11T14-01-50-665-s42 -->
- **Full run 2026-11-11T14-01-50-665-s42 (prospect source):** 7/7 detected; 315 findings outside fault windows, all inside the 6-min warm-up (BetterDB deployed 5.5 min earlier onto an idle cluster → load start lit every connection; 176 in minute 1), 0 in the 34 min after. Warm-up slowlog: 12/17 primary entries were BetterDB's own CLUSTER SLOT-STATS/NODES. Roll: 12/12 shards with 7–27 s zero attached replicas; ghost slotless master listed by 7/36 nodes at roll end. Harness bug: phase-end screenshots were taken after revert() (hot-shard panel showed no hot traffic) → now captured before revert.
- **Correction (2026-11-11):** pod replacement gives a *new* Valkey node id (no persistence → nodes.conf lost): 73 distinct ids for 73 pod incarnations in the final run, no id ever reused. So the earlier reading "config epoch went backwards across the pod replacement / operator keeps node ids" is unsupported; the ghost node in the clean repro was most likely a new node that held epoch 146 as primary and is now a replica (self 145). The observation (7/36 nodes list it as master @146 while it reports replica @145) stands; the mechanism is open. Side finding: `cluster.persistence` in sim.yaml isn't passed to the ValkeyCluster template.
- **Correction (2026-11-11):** operator #563 is closed as a duplicate of **#552** (open); fix PR **#562** (open) closes #552 and describes the same mechanism (replacement pod Ready on PING before it has joined and synced). Prospect PDF now references #552/#562.
- **Correction (2026-11-11):** slow-commands latency is NOT the 3-consecutive-samples rule (slowlog_last_id uses consecutiveRequired: 1, `apps/api/src/anomaly/anomaly.types.ts`); BetterDB reads SLOWLOG every 30 s (`slowlog-analytics.service.ts` DEFAULT_POLL_INTERVAL_MS = 30000). Final run's slowlog findings after injection landed at 12.0, 42.2, 72.1, 102.2, 131.8, 161.5 s — a 30 s grid. 10.8 s / 22.7 s = random wait for the next read. Prospect PDF corrected.
- **Pre-send validation (2026-11-11), final run:** removed "failovers always landed on a synced replica" — 7 of 13 promoted replicas' last sample (~5 s before promotion) showed link down / sync in progress; 5 s sampling can't settle it either way. **Open question worth investigating:** some promoted pods (e.g. valkey-bz-5-0-0) never showed an in-sync sample in their new incarnation before promotion. 31/36 restarted pods were marked Ready before their new incarnation's first in-sync sample (up to ~34 s) — matches operator PR #562. Warm-up slowlog alerts: 76 on replicas, 12 primaries, 5 cluster-wide; "own polling" evidence covers primaries only.
