# BetterDB Monitor vs. a 12×2 Valkey cluster — run `2026-11-10T19-26-16-778-s42`

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

![timeline](timeline.svg)
