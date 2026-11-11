# BetterDB Monitor vs. a 12×2 Valkey cluster — run `smoke-2`

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

![timeline](timeline.svg)
