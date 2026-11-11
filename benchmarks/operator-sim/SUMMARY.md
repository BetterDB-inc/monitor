# BetterDB Monitor vs. a 12×2 Valkey cluster — run `2026-11-11T14-01-50-665-s42`

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

![timeline](runs/2026-11-11T14-01-50-665-s42/timeline.svg)
