# BetterDB Monitor vs. a 12×2 Valkey cluster — run `2026-11-10T18-35-22-462-s42`

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

![timeline](timeline.svg)
