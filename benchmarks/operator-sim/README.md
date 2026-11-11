# operator-sim

Reproducible test harness: a 12-shard × 2-replica Valkey cluster managed by the official
[valkey-operator](https://github.com/valkey-io/valkey-operator) on a single-host kind cluster,
BetterDB Monitor deployed against it, mixed load, a deterministic fault timeline, independent
per-node ground truth, and a report that scores BetterDB's findings against that ground truth.
Synthetic workload on one machine: compare relative timings, not production numbers.

## Requirements

Linux host with ≥ 12 CPUs and ≥ 48 GiB RAM, Docker, kubectl, helm, Node 22, pnpm.
`make preflight` checks them. kind v0.33.0 is expected in `.bin/` (see `docs/VERSIONS.md`).
`BETTERDB_LICENSE_KEY` in `.env` (gitignored) — anomaly detection is a Pro feature.

## Commands

| command | what it does |
|---|---|
| `make up` | kind (1 CP + 6 workers, 3 fake zones), metrics-server, Chaos Mesh, valkey-operator, `ValkeyCluster` + checks |
| `make betterdb` | Postgres + BetterDB (image from `betterdb.imageTag`, or built from `betterdb.buildRef`) + checks |
| `make warm` | preload 1M keys (idempotent) |
| `make load` | 5-min steady-state check (balance, errors, p99, baseline anomalies) |
| `make scenario` | full fault timeline (~40 min). `PHASES=spike,primaryKill` for a subset, `DRY_RUN=1` to print the plan |
| `make report RUN=<id>` | `runs/<id>/{findings.jsonl,SUMMARY.md,SUMMARY.pdf,timeline.svg}` (pure function of the run files) |
| `make reset` | restore image/config/data to the baseline between takes |
| `make down` | delete the kind cluster (`KEEP_CLUSTER=1` removes only workloads) |

All parameters are in `config/sim.yaml` (validated by `src/config.ts`). Override any of them per run
with `SIM_OVERRIDES='{"scenario":{"baselineSec":60}}'`; e.g. test a BetterDB branch with
`SIM_OVERRIDES='{"betterdb":{"buildRef":"<branch>"}}' make betterdb`.

## Faults (`src/scenario/phases/`)

spike (3× app RPS) · hotShard (one hash tag) · slowCommands (O(N) reads of a 1M-member set) ·
memoryPressure (maxmemory → 64 MB + new-key flood) · replicaLag (Chaos Mesh delay + bandwidth on one
primary→replica link) · primaryKill (graceful pod delete) · rollingUpdate (operator image roll).

## Outputs per run (`runs/<id>/`, raw files gitignored)

`events.jsonl` (every injection, ms timestamps) · `groundtruth.jsonl` (per-node INFO, CLUSTER NODES view,
SLOWLOG, CLUSTER SHARDS, slot stats) · `betterdb.jsonl` (every BetterDB event/group, attributed to pod
and shard) · `findings.jsonl` · `SUMMARY.md`.

## Standalone repro

`scripts/repro-ghost-master.sh` — kubectl + valkey-cli only (no BetterDB, no load): rolls the
cluster image N times and reports nodes that peers list as a slotless `master` while they report
themselves as a replica. Captured output: `runs/repro-ghost/`.

`FINDINGS.md` is the running log; `docs/DECISIONS.md` and `docs/VERSIONS.md` record every deviation
and verified version.
