# Exclude admin and monitoring commands from P99 latency-regression findings, and stop their banners dominating the Anomalies page

**Suggested labels:** `enhancement`, `anomaly-detection`, `latency-regression`, `ui`, `false-positive`  ·  **Area:** `proprietary/latency-regression`, `apps/web/src/components/anomalies/LatencyRegressionBanner.tsx`, `apps/web/src/pages/AnomalyDashboard.tsx`  ·  **Severity:** medium. The findings are technically true, because these commands did get slower, but nobody can act on them. They take the most prominent spot on the Anomalies page and push real findings below the fold.

> **Testing:** the harness used to find and reproduce this is on branch [`bench/operator-sim`](https://github.com/BetterDB-inc/monitor/tree/bench/operator-sim/benchmarks/operator-sim) (`benchmarks/operator-sim/`; start with its README). Raw run data (`runs/<id>/*.jsonl`) is not committed; re-run the commands in the test plan to regenerate it.

## Summary

The P99 latency-regression guard (`proprietary/latency-regression`) tracks per-command P99 from `INFO latencystats` and raises `command_p99` findings when a command's P99 stays at least 2× its rolling baseline. Commands qualify by volume alone (≥ 60 calls/min). On a cluster, the commands that easily reach that volume are the ones BetterDB and other cluster-aware tooling issue all the time: `info`, `cluster|nodes`, `cluster|shards`. Their latency tracks cluster size and host load, not the application's data path. In our test, the Anomalies page for the seed connection opened with full-width "P99 latency regression detected" banners for `cluster|shards` and `cluster|nodes`, each with a 5-step runbook about prefetch batching and pipelines that does not apply to these commands. This issue proposes a configurable list of admin and monitoring commands that the guard ignores by default, and a more compact banner that orders data-path commands first.

## How we found it

The findings come from a load-and-fault-injection harness that lives in this repo at [`benchmarks/operator-sim`](../../) (branch `bench/operator-sim`).

- **Cluster:** kind (Kubernetes v1.37.0) on one 16 vCPU host. valkey-operator v0.8.0, 12 shards × (1 primary + 2 replicas) = 36 Valkey 9.1.2 pods, latency tracking on (the default).
- **BetterDB:** Monitor v0.55.0 with an Enterprise license (the latency-regression guard is a Pro feature), `CLUSTER_AUTO_REGISTER_NODES=true`, seed connection = the operator's headless Service.
- **Who calls the cluster commands:** BetterDB itself (discovery, topology, slot stats, Prometheus exporter, anomaly detectors), the harness's ground-truth sampler (`INFO` every 1 s, `CLUSTER NODES` every 5 s, `CLUSTER SHARDS` every 5 s), the operator, and the application's cluster client (topology refresh).
- **Runs:** steady-state run `runs/load-2026-11-10T16-34-28-286Z` (`steady-betterdb.json`) and the full scenario runs. The page screenshots were taken from `/anomalies` on the seed ("Default") connection.

## Observed behaviour

Top of the Anomalies page (seed connection, full run), two banners for monitoring commands:

```
P99 latency regression detected
Sustained P99 latency degradation: cluster|shards p99 2.1ms (baseline 0.5ms, 4.6x).
Remediation runbook
 1. Compare per-command P99 before/after the change via the latencystats history API.
 2. On Valkey 9+, tune prefetch-batch-max-size (default 16): try 4, or 0 to disable batched prefetching (valkey PR #2092).
 3. Split multi-thousand-command pipelines into smaller batches on the client side.
 4. If P99 spikes recur hourly, check the client cluster topology refresh interval.
 5. After an upgrade, consider holding the rollout; track valkey/valkey#3527 and #3451 for upstream fixes.
[Mark resolved]
```

…followed by a second banner of the same size for `cluster|nodes`. Over the 5-minute steady window with no faults, the only two `command_p99` events were both about monitoring commands:

```
WARNING  Sustained P99 latency degradation: cluster|nodes p99 2.9ms (baseline 1.5ms, 2.0x).
WARNING  Sustained P99 latency degradation: info p99 1.5ms (baseline 0.5ms, 3.2x).
```

None of the application's data commands (HGET, INCR, SADD, ZADD, …) had a regression finding in those windows. The full-run event capture (`betterdb.jsonl`, which queries `/anomaly/events` from the run's start time) has no *new* `command_p99` events, so the banners on the page were raised earlier and were still marked active. The banner feed ignores the date picker (see Root cause), so they stay at the top of the page until someone resolves them by hand.

## Expected behaviour

By default, the regression guard reports commands that serve application traffic. Introspection and cluster-management commands (`INFO`, `CLUSTER NODES|SHARDS|SLOTS|SLOT-STATS`, `CLIENT LIST`, `CONFIG GET`, `SLOWLOG`/`LATENCY`/`COMMANDLOG`, …) are ignored unless the operator opts in. When regressions are active, the Anomalies page shows one compact banner that lists the affected commands, data-path first. It does not show one full runbook per command.

## Root cause

All references are to `origin/master` (7b29d758); `proprietary/latency-regression` is identical in v0.55.0.

- `proprietary/latency-regression/latency-regression.service.ts:70-105` reads 24 h of stored latencystats for the connection, then computes `callsPerMin` from commandstats deltas for every recently seen command. The samples come from `apps/api/src/metrics/latencystats-poller.service.ts` (`INFO server latencystats` every 60 s), and they cover every client of that node, BetterDB included.
- `proprietary/latency-regression/regression-detector.ts:324-331`: `eligibleCommands` keeps every command with `callsPerMin ≥ MIN_CALLS_PER_MIN` (60, `:42`), ranked by volume and capped at `TOP_K_COMMANDS` (20, `:43`). Nothing is filtered by command type. On a 36-node cluster, `info`, `cluster|nodes` and `cluster|shards` pass 60 calls/min easily: BetterDB alone polls `INFO` every second on each connection.
- `regression-detector.ts:416-523` (`evaluateSustained`) fires per command at ≥ 2× the 24 h median, if the difference is ≥ 1 ms, for 5 consecutive samples. It is CRITICAL at ≥ 4× (`CRITICAL_SUSTAINED_FACTOR`, `:48`), so `cluster|shards` at 4.6× is CRITICAL. The output of `CLUSTER NODES`/`SHARDS` grows with node count, and its latency grows with host load, so 0.5 ms → 2 ms on a loaded 36-node cluster is expected.
- The guard already treats `cluster|slots` and `cluster|shards` as a *cause* signal for topology-refresh correlation (`latency-regression.service.ts:27`, `regression-detector.ts:79-93`). Reporting the same commands as *victims* contradicts that.
- `apps/web/src/pages/AnomalyDashboard.tsx:201-207` polls `command_p99` events with `activeOnly: true` every 5 s, deliberately ignoring the date picker. `:326` renders `<LatencyRegressionBanner>` above the summary cards.
- `apps/web/src/components/anomalies/LatencyRegressionBanner.tsx:54-81` renders one full `Alert` per active event, each with the same hard-coded 5-step `RUNBOOK` (`:16-22`). The banners stay until someone clicks "Mark resolved", so two monitoring-command regressions take up the first screen.

## Proposed change

### API (`proprietary/latency-regression`)

1. Add `ADMIN_COMMANDS` in `regression-detector.ts`. These are lower-case latencystats names, and a `|*` suffix matches every subcommand. The default list mirrors the read-only monitoring ACL in `docs/minimum-acl.md`, plus common cluster-client commands:
   ```
   info, ping, select, hello, auth, role, dbsize, lastsave, time,
   client|*, config|get, slowlog|*, commandlog|*, latency|*, memory|stats, memory|doctor,
   acl|whoami, acl|log, command|*, module|list,
   cluster|info, cluster|nodes, cluster|shards, cluster|slots, cluster|slot-stats,
   cluster|myid, cluster|getslotmigrations, cluster|links, readonly, readwrite
   ```
2. `eligibleCommands` (`regression-detector.ts:325`) drops commands in the ignore set **before** ranking, so admin commands do not use up the top-20 slots. Topology correlation (`clusterRefreshDeltas`) is unchanged.
3. Configuration: `LATENCY_REGRESSION_IGNORE_COMMANDS` replaces the default list, and `LATENCY_REGRESSION_EXTRA_IGNORE_COMMANDS` appends to it, both comma-separated. `LATENCY_REGRESSION_IGNORE_COMMANDS=` (empty) turns the filter off and restores today's behaviour. Validate the variables in `apps/api/src/config/env.schema.ts` and document them in `docs/configuration.md`. Pass the parsed set into `new RegressionDetector({ ignoreCommands })` (constructor option, default = built-in list).
4. Back-compat: there are no storage changes. Already-stored `command_p99` events for admin commands stay until resolved, and the new code simply stops creating them.

### UI

5. `LatencyRegressionBanner`: render **one** banner for all active `command_p99` events. Its title says "P99 latency regression on N commands". Below the title, list one line per event using its `commands` field (already on the event, `latency-regression.service.ts:162`), sorted critical first, then by `threshold` (the degradation factor) descending. Collapse the runbook behind "Show remediation steps". "Mark resolved" stays per line.
6. If admin commands are opted back in, show those lines after the data commands with a muted "monitoring/admin command" tag.

## Acceptance criteria

- [ ] `RegressionDetector` with the default options: a sustained 4.6× regression on `cluster|shards` with 100 calls/min produces **no** finding. The same series on `hget` produces a CRITICAL `sustained_degradation` finding.
- [ ] With `ignoreCommands: new Set()`, the `cluster|shards` case fires again (old behaviour).
- [ ] `client|*` matches `client|list` and `client|setname` but not `clientx`. `info` does not match `info|foo` (latencystats has no INFO subcommands, but the matcher must be exact without `|*`).
- [ ] When 25 commands have ≥ 60 calls/min and 6 of them are admin commands, the 19 data commands are all eligible (top-20 not consumed).
- [ ] Topology correlation still sees `cluster|shards` call bursts: an `hget` regression next to a `cluster|shards` burst still has `topologyRefreshCorrelated: true`.
- [ ] Web: three active `command_p99` events render one `Alert` with three lines, critical first, and the runbook is collapsed by default.
- [ ] Harness: after a full run, `GET /api/anomaly/events?metricType=command_p99` on any connection returns no events whose `commands` are all admin commands.

## Test plan

**Unit tests**
- `proprietary/latency-regression/__tests__/regression-detector.spec.ts`: reuse the existing sustained-degradation fixture (baseline samples over `[now-24h, now-5m]`, then 5 consecutive degraded samples). Parametrise the command over `['hget', 'cluster|shards', 'cluster|nodes', 'info', 'client|list']`. Expect findings only for `hget` with the default options, and for all five with `ignoreCommands: new Set()`.
- A matcher table test for the wildcard rules.
- `apps/web/src/components/anomalies/LatencyRegressionBanner.test.tsx`: render with three events (`cluster|nodes` warning 2.0×, `hget` critical 5×, `zadd` warning 2.5×). Expect a single alert and the line order `hget`, `zadd`, `cluster|nodes`.

**Harness reproduction** (Docker, kind, Helm, `BETTERDB_LICENSE_KEY` in `benchmarks/operator-sim/.env`; a sustained finding needs at least 30 latencystats samples older than 5 minutes (`SUSTAINED_MIN_BASELINE_SAMPLES`, `SUSTAINED_BASELINE_EXCLUDE_MS`) at one sample per 60 s, plus 5 consecutive degraded samples, so about 40 minutes after BetterDB first sees the cluster; a full run covers that):

```bash
cd benchmarks/operator-sim
SIM_OVERRIDES='{"betterdb":{"buildRef":"<your-branch>"}}' make up betterdb warm
make scenario && make report        # ~40 min
# list command_p99 events from the run's BetterDB capture
grep '"metricType":"command_p99"' runs/<id>/betterdb.jsonl | python3 -c "import sys,json; \
  [print(json.loads(l)['payload'].get('commands'), json.loads(l)['payload']['message']) for l in sys.stdin]"
```

Expect no lines whose commands are only `info` or `cluster|*`. Also open `http://localhost:3001/anomalies` on the Default connection and check that any regression banner is a single compact card. The harness writes a screenshot per phase to `runs/<id>/screenshots/*-anomalies.png`.

## Out of scope / open questions

- **Should BetterDB's own share of the volume count toward eligibility at all?** `callsPerMin` comes from `INFO commandstats`, which cannot tell clients apart. Excluding by command name is the practical approximation. A data command that only BetterDB issues does not exist today.
- **Is a P99 regression on `cluster|*` ever actionable?** It can be a symptom of a very large cluster or of gossip pressure. If maintainers want to keep it, an alternative is to keep evaluating admin commands but cap them at `warning`, exclude them from webhooks, and show them in a "control plane" section instead of the banner.
- **Banner policy.** Should only `upgrade_regression` (the valkey#3527 case the guard was built for) get the top-of-page banner, with `sustained_degradation` going to the normal list?
- The SLOWLOG side of the same problem (BetterDB's own commands appearing as slow queries) is covered in the issue on slowlog alerts from BetterDB's own polling.

## References

- `proprietary/latency-regression/latency-regression.service.ts:20-27, :67-134, :147-171`
- `proprietary/latency-regression/regression-detector.ts:29-52, :66-93, :324-331, :416-523`
- `apps/api/src/metrics/latencystats-poller.service.ts:35`
- `apps/web/src/pages/AnomalyDashboard.tsx:201-207, :326`
- `apps/web/src/components/anomalies/LatencyRegressionBanner.tsx:16-83`
- `docs/minimum-acl.md:28` (the read-only monitoring command set)
- valkey/valkey#3527 (the hourly-spike regression the guard targets)
- Harness: `benchmarks/operator-sim/FINDINGS.md` ("Screenshot curation: the global /anomalies list is dominated by P99-regression cards…"), `runs/load-2026-11-10T16-34-28-286Z/steady-betterdb.json`
