# BetterDB Monitor vs. a 12×2 Valkey cluster — run `2026-11-10T19-54-07-874-s42`

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

![timeline](timeline.svg)
