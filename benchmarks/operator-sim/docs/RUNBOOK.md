# RUNBOOK — recording a take

Tested on a 12-shard × 2-replica Valkey cluster on a single host (kind); synthetic workload; not prod numbers.

## Before the first take

- Close heavy apps (games, browser tabs with video). The slowCommands phase is the most
  sensitive to host CPU contention: with load avg ≳ 2× cores, plain GETs land in SLOWLOG
  (FINDINGS, Phase 4 run 4) and the injected slow queries stop standing out.
- `make preflight` — must print `HOST: local kind OK`.
- `benchmarks/operator-sim/.env` holds `BETTERDB_LICENSE_KEY` (gitignored).

## Take sequence

| situation | command | time |
|---|---|---|
| clean machine / after `make down` | `make all` | ~15 min setup + ~45 min scenario |
| cluster up, previous take finished | `make reset && make scenario && make report` | ~10 min reset (includes the 9.1.3 → 9.1.2 roll) + scenario |
| re-shoot one segment | `make reset && PHASES=hotShard,slowCommands make scenario` | baseline 6 min + phases |
| check the plan without touching anything | `DRY_RUN=1 make scenario` | instant |
| abort mid-take | Ctrl-C once (reverts the active phase, collects files); twice force-quits | — |

`make reset` restores image, config, maxmemory and data (FLUSHALL + warm) without recreating kind.
The rolling-update phase leaves the cluster on 9.1.3, so a reset before the next full take
always includes one operator roll (~8 min).

## Browser tabs (open before `make scenario`)

1. `http://localhost:3001/anomalies` — the main on-camera view.
2. `http://localhost:3001/cluster` — topology + slot heatmap (hotShard, primaryKill, rollingUpdate).
3. `http://localhost:3001/dashboard?connection=<id>` for the hotShard target's primary — get the id from
   `curl -s localhost:3001/api/connections | jq '.connections[] | select(.host=="<pod ip>") | .id'`
   (pod IP: `kubectl --context kind-bz-sim -n valkey get pod <pod> -o wide`).
4. Terminal with `make scenario` — the phase banners and countdown are the on-screen annotation
   (BetterDB v0.55.0 has no user annotations API).

## What to expect on screen (default timeline, T = scenario start)

| T+ | phase | look for |
|---|---|---|
| 0:00–6:00 | baseline | anomaly list quiet; any events here are baseline FPs (they're in the report) |
| 6:00 | spike (3× app RPS, 90 s) | traffic_burst / ops_per_sec on many nodes within seconds |
| 9:30 | hotShard (shard 7, 120 s) | ops/cpu anomaly on one primary only; slot heatmap shows the hot slot |
| 13:30 | slowCommands (shard 3) | preload note, then slow_queries / slowlog_last_id on shard 3 |
| 17:00 | memoryPressure (shard 5) | evicted_keys / keyspace_misses rates, memory_pressure group |
| 21:00 | replicaLag (shard 9) | replication backlog / divergence on the primary and the shaped replica |
| 25:00 | primaryKill (shard 2) | node_failover within ~2 s; cluster view shows the new primary |
| 28:00 | rollingUpdate | a node_failover per shard over ~8–10 min; watch for shards with no synced replica |

Exact times of every action are in `runs/<id>/events.jsonl`; the report's table has detection latencies.

## 6-minute narration outline

- **0:00–0:45 Shape.** 12 shards × 2 replicas, 36 pods, official valkey-operator on kind, 3 fake zones. BetterDB seeded with the operator's headless Service, 36 nodes auto-registered. Say the caveat line.
- **0:45–1:15 Baseline.** Mixed messaging load; what "quiet" looks like; mention baseline false positives honestly.
- **1:15–2:45 Hot shard + slow commands.** One primary lights up; slot heatmap; slow queries attributed to the right shard.
- **2:45–3:45 Memory / replica lag.** Evictions on one node; replication backlog coverage on the shaped replica.
- **3:45–5:15 Primary kill + rolling update.** Failover latency; per-shard failovers during the roll; any no-synced-replica windows (operator #563).
- **5:15–6:00 Findings table.** `runs/<id>/SUMMARY.pdf`: hits, misses, FPs, latencies — relative numbers only.
