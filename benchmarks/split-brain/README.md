# Split-brain detection benchmark

Measures how often the topology divergence detector raises an event for real
cluster faults and for healthy operations, depending on how many nodes it asks
(`nodesPerZone`, `randomNodes`) and how many rounds a disagreement must last
(`minRounds`). Results are in [RESULTS.md](RESULTS.md).

## How it works

1. **Record.** Each trial builds a fresh Valkey cluster in Docker, injects one
   fault or runs one healthy operation, and asks every node once a second for
   `CLUSTER NODES`, `CLUSTER INFO` and `CLUSTER GETSLOTMIGRATIONS`. The answers
   are saved as one gzipped trace per trial under `runs/`.
2. **Replay.** Every trace is fed to the detector code of this repository
   (imported by path, not copied) once per sampling setting, seed node, round
   phase and random draw. One recording therefore answers every setting on
   exactly the same cluster behaviour.
3. **Report.** Per-trial outcomes are turned into rates with 95% intervals,
   times to the first event, cost per round and paired comparisons.

The detector modules are imported as they are. The small piece of
`anomaly.service.ts` that turns a detector round into raised and closed events
cannot be imported without the whole service, so it is restated in
`src/judge.ts`. `test/judge.test.ts` replays the service's own test cases
through it. `product-pin.json` holds the hashes of the imported files and of
the service files the glue was restated from; replay and report refuse to run
when any of them differs.

## Scenarios

| scenario | kind | what happens |
| --- | --- | --- |
| zone-partition | fault | one zone is cut off from the other two for 60 s |
| minority-partition | fault | two nodes from different zones are cut off for 60 s |
| killed-primary | fault | a primary is killed and stays down |
| paused-node | fault | a primary is frozen for 3 × node timeout, then resumed |
| flapping-node | fault | a primary is cut off and reconnected 5 times, 1.5 × node timeout each way |
| partial-join | fault | a new node meets the cluster but cannot reach half of it for 150 s |
| idle | control | nothing happens |
| manual-failover | control | `CLUSTER FAILOVER` on a replica |
| slot-migration-atomic | control | `CLUSTER MIGRATESLOTS` of 1000 slots (about 49k keys) from each primary in turn, with the primaries' links limited to 20 Mbit/s so a move takes 6–7 s; a move that does not end as `success` drops the attempt |
| slot-migration-legacy | control | `valkey-cli --cluster reshard` of 3000 slots (about 140k keys), about 9 s |
| rolling-restart | control | every node restarted, one at a time |
| slow-node | control | 800 ms ± 200 ms of network delay on one node for 60 s |
| clean-join | control | a new node meets the cluster with nothing blocked |

## Running it

Needs Docker, Node 22 and pnpm 9. The package is standalone; install inside
this directory.

```bash
pnpm install
pnpm bench build
pnpm bench record --out stage1 --lanes 1,2,3,4 --trials 30
pnpm bench replay --runs stage1
pnpm bench report --results stage1
pnpm test
```

- `record` is resumable: trials that already have a trace are skipped. Each
  lane is one cluster on its own Docker network (`sbb-l<lane>`, subnet
  `172.30.<100+lane>.0/24`, host ports `73<lane>1`–`73<lane>7`). Options:
  `--scenarios a,b`, `--node-timeout 5000`, `--size 6`, `--seed 697`.
- Everything it creates is named `sbb-*` and labelled `sbb.bench=697`. It never
  touches other containers. `pnpm bench down` removes what is left after an
  interrupted run.
- Do not run it next to other heavy work. `record` refuses to start when the
  1-minute host load is over `--max-load` (default: three quarters of the CPU
  count) or fewer than `--min-free-ports` local ports are free (default 8000).
  It checks again before every trial and waits up to `--max-wait-minutes`
  (default 30) for the host to calm down, then stops; run the same command
  again to continue. Both numbers are sampled every five seconds while a
  trial records. An attempt that crosses a limit, or fails for any other
  reason, is dropped and the trial is recorded again, up to three times per
  run. Dropped attempts are listed with their reason in `dropped.jsonl` next to
  the traces. The kept trials carry the attempt number, the reasons of their
  dropped attempts, the tick lateness with a flag for a p99 over 250 ms, the
  load, the free ports and the Docker VM load in their first line, so a noisy
  trial can still be thrown out later. The report counts them per scenario.
  `pnpm bench host` prints the current numbers.
- `pnpm bench inspect <trace>` prints one line per second of a recording.
- After a change to a pinned product file: check `src/judge.ts` against the
  service, run `pnpm test`, then `pnpm bench pin <commit>` (it refuses when
  the working tree differs from that commit in a pinned file), then `replay`
  and `report` again. The recordings stay valid.

## Layout

| path | what |
| --- | --- |
| `src/cluster.ts`, `src/docker.ts`, `src/resp.ts` | build clusters and talk to nodes |
| `src/scenarios.ts` | the faults and the healthy operations |
| `src/recorder.ts`, `src/trial.ts`, `src/run.ts` | record one trial, run many |
| `src/product.ts` | the detector imports and the pin check |
| `src/judge.ts` | the restated service glue |
| `src/replay.ts`, `src/collect.ts` | replay one trace, aggregate one trial |
| `src/stats.ts`, `src/report.ts` | intervals and the report tables |
| `results/<stage>/trials.jsonl.gz` | per-trial outcomes the report is built from |
| `results/<stage>/findings.md`, `limitations.md` | the hand-written parts of the report |
