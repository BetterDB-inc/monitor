# Ignore BetterDB's own commands in slowlog-based anomaly detection

**Suggested labels:** `bug`, `anomaly-detection`, `false-positive`, `cluster`  ·  **Area:** `apps/api/src/slowlog-analytics`, `proprietary/anomaly-detection`, `apps/api/src/prometheus`  ·  **Severity:** medium-high. BetterDB raises CRITICAL "slow query" findings, and sends webhooks for them, about its own monitoring commands. On a busy cluster this happens on many nodes at once, roughly every minute.

> **Testing:** the harness used to find and reproduce this is on branch [`bench/operator-sim`](https://github.com/BetterDB-inc/monitor/tree/bench/operator-sim/benchmarks/operator-sim) (`benchmarks/operator-sim/`; start with its README). Raw run data (`runs/<id>/*.jsonl`) is not committed; re-run the commands in the test plan to regenerate it.

## Summary

BetterDB's monitoring commands (`CLUSTER SLOT-STATS`, `CLUSTER NODES`, `CLUSTER SHARDS`, `LATENCY HISTOGRAM`, `INFO …`) sometimes take longer than the server's `slowlog-log-slower-than`, so Valkey records them in its SLOWLOG. The `slowlog_last_id` detector counts every new SLOWLOG entry, whoever issued it, and scores that count with a z-score against a baseline of almost always 0. One entry is enough to give "Value: 1, Baseline: 0 → CRITICAL". The correlator then also creates a `slow_queries` group. In our test, on the primaries (where our sampler read SLOWLOG; replica slowlogs were not sampled), most of the SLOWLOG entries recorded during an idle-ish warm-up came from BetterDB's own connections, which identify themselves with `CLIENT SETNAME BetterDB-Monitor…`. This issue proposes ignoring entries from BetterDB's own clients when counting slow entries for anomaly detection, optionally ignoring a configurable list of clients or commands, and lowering how often BetterDB runs the most expensive of these commands.

## How we found it

The findings come from a load-and-fault-injection harness that lives in this repo at [`benchmarks/operator-sim`](../../) (branch `bench/operator-sim`). It runs an independent ground-truth sampler next to BetterDB, so we can see which client actually issued each SLOWLOG entry.

- **Cluster:** kind (Kubernetes v1.37.0) on one 16 vCPU / 62 GiB host. valkey-operator v0.8.0, 12 shards × (1 primary + 2 replicas) = 36 pods, Valkey 9.1.2, `slowlog-log-slower-than 10000` (10 ms), `cluster-slot-stats-enabled yes`. The host is oversubscribed, so admin commands that are normally sub-millisecond sometimes take 10–45 ms.
- **BetterDB:** Monitor v0.55.0 (plus local commit `173a4a3f`, which does not touch slowlog code), `CLUSTER_AUTO_REGISTER_NODES=true` (seed plus 36 per-pod child connections), `ANOMALY_POLL_INTERVAL_MS=1000`, connected as a minimal-ACL user (`docs/minimum-acl.md`).
- **Ground truth:** a separate sampler reads `SLOWLOG GET` deltas on every primary, keeping client name and arguments (`groundtruth.jsonl`, metric `slowlog`).
- **Runs:** `runs/2026-11-11T14-01-50-665-s42` (final full run) and `runs/2026-11-10T19-54-07-874-s42` (previous full run). Both start with a 6-minute baseline with no injected faults.

## Observed behaviour

**Findings (final run, 6-minute baseline with no injected faults):** 78 slowlog-driven findings outside any fault window, made up of 73 `slowlog_last_id` events and 5 `slow_queries` groups. They came in waves about 60 s apart, at 80, 140, 200, 260 and 320 s after the run started, and each wave hit many nodes at once. Typical message:

```
CRITICAL: slowlog_last_id spike detected. Value: 1, Baseline: 0 (14900.0% above normal, Z-score: 12.21)
```

Raw values in the baseline: 1 (46 events), 2 (23), 3 (9), 4–7 (15). The previous full run had 55 slowlog-driven findings in 6 waves (30, 91, 151, 212, 302, 362 s), all inside the baseline and none after it.

**What was in the SLOWLOG (ground truth, primaries only):**

| run | baseline entries on primaries | issued by BetterDB |
|---|---|---|
| final (`2026-11-11T14-01-50-665-s42`) | 17 | **12** |
| previous (`2026-11-10T19-54-07-874-s42`) | 9 | **7** |

Over the whole final run (40 min, including an injected slow-command phase), BetterDB issued 64 of the 159 SLOWLOG entries recorded on primaries. Breakdown by client name and command:

| client name | command | entries | duration |
|---|---|---|---|
| `BetterDB-Monitor` | `CLUSTER SLOT-STATS ORDERBY key-count …` | 14 | 10–45 ms |
| `BetterDB-Monitor` | `LATENCY HISTOGRAM` | 12 | 10–25 ms |
| `BetterDB-Monitor-Node-<id>` | `CLUSTER SLOT-STATS SLOTSRANGE …` | 23 | 10–100 ms |
| `BetterDB-Monitor-Node-<id>` | `CLUSTER NODES` | 6 | 10–23 ms |
| `BetterDB-Monitor` | `CLUSTER NODES` | 4 | 10–15 ms |
| `BetterDB-Monitor` | `CLUSTER SHARDS`, `CLIENT LIST`, `INFO server/commandstats/latencystats` | 5 | 13–38 ms |

Excerpt from the first minutes of the final run (seconds after the baseline started):

```
  0.4 valkey-bz-2-0-0 BetterDB-Monitor-Node-aafa23fc CLUSTER NODES                       10.9 ms
  2.4 valkey-bz-0-2-0 BetterDB-Monitor               CLUSTER SLOT-STATS ORDERBY key-count 24.2 ms
  2.4 valkey-bz-2-1-0 BetterDB-Monitor               CLUSTER SLOT-STATS ORDERBY key-count 43.9 ms
  2.4 valkey-bz-5-2-0 BetterDB-Monitor               CLUSTER SLOT-STATS ORDERBY key-count 45.1 ms
 64.4 valkey-bz-10-0-0 BetterDB-Monitor              CLUSTER NODES                       15.6 ms
188.4 valkey-bz-11-2-0 BetterDB-Monitor              CLUSTER NODES                       14.5 ms
```

Replica SLOWLOGs were not sampled. Replicas showed the same wave timing in BetterDB's findings, so we infer they had the same cause.

## Expected behaviour

SLOWLOG entries that BetterDB caused by monitoring the server do not produce slowlog anomalies or `slow_queries` groups. They stay visible in the Slow Log page, where an existing toggle can hide them. An application command that crosses the slowlog threshold is still detected.

## Root cause

All references are to `origin/master` (7b29d758); the code is identical in v0.55.0.

1. **BetterDB names its connections, but nothing filters on the name.** The names come from:
   - `apps/api/src/database/adapters/unified.adapter.ts:350`, `createValkeyClient(this.config.connectionName ?? 'BetterDB-Monitor')`, used for the seed and for every auto-registered child connection
   - `apps/api/src/cluster/cluster-discovery.service.ts:117` (`BetterDB-Monitor-Discovery`) and `:356` (`` `BetterDB-Monitor-Node-${node.id.substring(0, 8)}` ``, the per-node fan-out pool)
   - `apps/api/src/session-explorer/primary-nodes.ts:47` (`BetterDB-Monitor-SessionExplorer`) and `apps/api/src/topology/sentinel-topology.source.ts:45` (`BetterDB-Monitor-Sentinel-Discovery`)
   - `unified.adapter.ts:1272` (`…-keyscan`)
2. **Slow entries are collected without regard to who issued them.** `apps/api/src/slowlog-analytics/slowlog-analytics.service.ts:88` fetches `SLOWLOG GET 128` every 30 s (`:37`, `DEFAULT_POLL_INTERVAL_MS = 30000`). It stores every new entry, including `clientName` (`:126-138`), and advances `lastSeenIds` to the highest id (`:143-147`). `getLastSeenId()` (`:227-237`) returns that id.
3. **The detector counts ids.** `proprietary/anomaly-detection/anomaly.service.ts:1534-1562` runs on every 1 s anomaly poll:
   ```ts
   const currentSlowlogId = this.slowLogAnalytics.getLastSeenId(ctx.connectionId);
   const delta = Math.max(0, currentSlowlogId - (lastId ?? currentSlowlogId));
   ...
   slowlogBuffer.addSample(delta, timestamp);
   const anomaly = slowlogDetector.detect(slowlogBuffer, delta, timestamp);
   ```
   The delta is in SLOWLOG ids, so every entry counts, BetterDB's own included. The id only moves when the 30 s slowlog poll runs, so the buffer is 29 zeros followed by the count of entries in the last 30 s.
4. **There is no floor.** `apps/api/src/anomaly/anomaly.types.ts:118-124` sets `slowlog_last_id` to warning z 1.5, critical z 2.5, `consecutiveRequired: 1`, cooldown 30 s. With 300 samples that are almost all 0, the mean is about 0.003 and the standard deviation about 0.06, so a single entry scores z ≈ 12–17. The waves fall about 60 s apart because the 30 s slowlog poll and the 30 s cooldown are in phase: the poll right after a firing usually arrives a few ms inside the cooldown and is skipped.
5. **`slow_queries` groups follow automatically.** `proprietary/anomaly-detection/correlator.ts:206-207` maps any `slowlog_last_id` anomaly to `AnomalyPattern.SLOW_QUERIES`.
6. **The "exclude monitor" filter misses most own clients.** `unified.adapter.ts:836-838` filters with an exact match (`entry.clientName !== excludeClientName`), and `apps/api/src/metrics/metrics.controller.ts:109` passes `'BetterDB-Monitor'`. Entries from `BetterDB-Monitor-Node-<id>`, the largest group in the table above, are not hidden. A correct prefix rule already exists in `proprietary/anomaly-detection/retry-amplification-attribution.ts:43-47` (`OWN_CLIENT_NAMES` and `isMonitorClientName`, which match `BetterDB-Monitor`, `BetterDB-Agent` and `BetterDB-CLI`, plus any `-…` suffix), but it is file-private.

Where the most frequent expensive commands come from:

- `CLUSTER SLOT-STATS ORDERBY key-count LIMIT N`, followed by `ORDERBY cpu-usec` when `cluster-slot-stats-enabled` is on: `apps/api/src/prometheus/prometheus.service.ts:2947-2953` (`readOwnTopSlots`). It runs on every child connection every `PROMETHEUS_POLL_INTERVAL_MS` (default 5000, `:519-521`).
- `CLUSTER SLOT-STATS SLOTSRANGE …` fan-out through the `-Node-` pool: `prometheus.service.ts:2856-2884` (`updateSlotStatsMetrics`, `:2820`) → `apps/api/src/cluster/cluster-metrics.service.ts:655`. This is the seed's cluster-wide view, chosen by `usesClusterWideSlotStats` (`cluster-metrics.service.ts:551`).
- `LATENCY HISTOGRAM` (no arguments, so every command): `apps/api/src/latency-analytics/latency-analytics.service.ts:72`, every 60 s per connection.

## Proposed change

### 1. One shared "own client" rule

Move `OWN_CLIENT_NAMES` and `isMonitorClientName` from `retry-amplification-attribution.ts` to `apps/api/src/common/utils/own-clients.ts` as `isBetterDbClientName(name: string | undefined): boolean`. Keep the current semantics: an exact match or a `-` suffix on `BetterDB-Monitor`, `BetterDB-Agent` or `BetterDB-CLI`, with `BetterDB-Migration-*` deliberately left visible. Retry-amplification attribution should import it from there.

### 2. Count only external slow entries for anomaly detection

In `SlowLogAnalyticsService.pollConnection`, while `newEntries` is being processed, also keep a cumulative per-connection counter of new entries that are **not** ignored:

```ts
private externalEntryCounts = new Map<string, number>(); // reset when the log source moves (same place lastSeenIds is deleted)
getExternalEntryCount(connectionId: string): number | null
```

In `AnomalyService` (`anomaly.service.ts:1534-1562`), take the per-poll delta of `getExternalEntryCount()` in place of the delta of `getLastSeenId()`. Everything else stays the same: the same buffer, the same detector, and the same `MetricType.SLOWLOG_LAST_ID`, so stored settings, UI and API are unaffected. `getLastSeenId()` stays as it is for the Prometheus exporter (`prometheus.service.ts:3676`).

An entry is ignored when either of these holds:
- `isBetterDbClientName(entry.clientName)`, controlled by `ANOMALY_SLOWLOG_IGNORE_OWN_CLIENTS` (default `true`);
- its client name starts with one of `ANOMALY_SLOWLOG_IGNORE_CLIENT_PREFIXES` (default empty; comma-separated). For example, `valkey-operator`, whose `CLUSTER …` calls also showed up in our SLOWLOG (8 entries).

Optional, for clients that set no name: `ANOMALY_SLOWLOG_IGNORE_COMMANDS` (default empty; comma-separated, lower-case `cmd|subcmd`, e.g. `cluster|slot-stats,latency|histogram`), matched against the first one or two arguments of the entry.

Add the variables to `apps/api/src/config/env.schema.ts` and `docs/configuration.md`. Read them once at startup. A per-workspace setting can come later if someone asks for it.

### 3. Slow Log page

The page keeps showing every entry, because a slow monitoring command is still useful to know about. Fix the existing `excludeMonitor=true` filter (`unified.adapter.ts:836-838`) so it uses `isBetterDbClientName` instead of an exact match. Then the web default (`apps/web/src/api/metrics.ts:77`, `excludeMonitor = true`) also hides `BetterDB-Monitor-Node-*`. The API shape does not change.

### 4. Make the offenders cheaper (separate PR is fine)

- Give the per-child `readOwnTopSlots` its own interval, `METRICS_SLOT_STATS_INTERVAL_MS` (default `30000`), and cache its result between Prometheus polls. Slot key counts do not need 5 s freshness. On a 36-node cluster this goes from 2 × 36 `CLUSTER SLOT-STATS` calls every 5 s to the same number every 30 s.
- Check whether the seed's cluster-wide `SLOTSRANGE` fan-out and the per-child `ORDERBY key-count` / `ORDERBY cpu-usec` reads both need to run when the children are auto-registered. Today both run every Prometheus poll (`prometheus.service.ts:2856-2890`), and on our cluster they are the largest source of BetterDB entries in SLOWLOG (37 of 64).
- `LATENCY HISTOGRAM` with no arguments walks every command with recorded latency. Consider passing only the commands we chart.

## Acceptance criteria

- [ ] `isBetterDbClientName` returns true for `BetterDB-Monitor`, `BetterDB-Monitor-Node-aafa23fc`, `BetterDB-Monitor-keyscan`, `BetterDB-Agent`, `BetterDB-CLI`, and false for `''`, `undefined`, `operator-sim`, `BetterDB-Migration-Source`, `BetterDB-Monitorx`.
- [ ] Given a SLOWLOG batch with 3 new entries from `BetterDB-Monitor-Node-1234abcd` and 0 from other clients, the slowlog detector receives a delta of 0 and raises no finding.
- [ ] Given 3 new entries from `BetterDB-Monitor` and 2 from `app`, the delta is 2.
- [ ] With `ANOMALY_SLOWLOG_IGNORE_OWN_CLIENTS=false`, the delta for the first case is 3, as it is today.
- [ ] `ANOMALY_SLOWLOG_IGNORE_CLIENT_PREFIXES=valkey-operator` ignores entries named `valkey-operator`.
- [ ] `GET /metrics/slowlog?excludeMonitor=true` no longer returns entries whose client name is `BetterDB-Monitor-Node-*`.
- [ ] Harness: in a fresh full run, the number of `slowlog_last_id` plus `group:slow_queries` findings during the 6-minute baseline drops from 78 to the number of baseline SLOWLOG entries from non-BetterDB clients, plus or minus the cooldown effect. In the final run that was 5 of 17 entries on primaries.
- [ ] The `slowCommands` injection is still detected on the target shard.

## Test plan

**Unit tests**

- `own-clients.spec.ts`: the table in the first acceptance criterion.
- `slowlog-analytics.service.spec.ts`: mock `getSlowLog(128)` to return ids 11–15 with client names `[BetterDB-Monitor, BetterDB-Monitor-Node-ab, app, BetterDB-Monitor, app]`, and set the previous `lastSeenId` to 10. Expect `getLastSeenId = 15` (unchanged behaviour), `getExternalEntryCount` to go up by 2, and all 5 entries to be saved to storage.
- `anomaly.service.spec.ts`: with a mocked `slowLogAnalytics.getExternalEntryCount` returning 0, 0, … (30 polls), then 0 while `getLastSeenId` goes up by 3, expect no `slowlog_last_id` anomaly. Repeat with the external count going up by 2 and expect one CRITICAL anomaly whose `value` is 2.
- `unified.adapter` or `metrics.service` spec: `excludeClientName` prefix behaviour.

**Harness reproduction** (Docker, kind, Helm, `BETTERDB_LICENSE_KEY` in `benchmarks/operator-sim/.env`):

```bash
cd benchmarks/operator-sim
SIM_OVERRIDES='{"betterdb":{"buildRef":"<your-branch>"}}' make up betterdb warm
PHASES=slowCommands make scenario     # 6-min baseline + one slowCommands phase
make report
```

What to check, with `runs/<id>` being the new run directory:

- `runs/<id>/SUMMARY.md`, "Unmatched detections by metric": `slowlog_last_id` and `group:slow_queries` should be near 0 (the final v0.55.0-based run had 73 and 5).
- `runs/<id>/findings.jsonl`: the `slowCommands` phase is still `"detected": true`.
- Cross-check with ground truth. Every SLOWLOG entry in the baseline, with its client:
  ```bash
  grep '"metric":"slowlog"' runs/<id>/groundtruth.jsonl | python3 -c "import sys,json,collections; \
    print(collections.Counter(json.loads(l)['value']['client'] for l in sys.stdin))"
  ```
  Every remaining slowlog finding should line up with a non-BetterDB entry on that pod.

## Out of scope / open questions

- **Detection cadence and the near-zero baseline are separate problems.** Even with own entries excluded, one external 10 ms command still scores "Value: 1, Baseline: 0 → CRITICAL" (see the issue on z-score floors). The 30 s slowlog poll also delays detection of real slow commands by 0–30 s (see the issue on sparse slow commands). This issue changes only *which* entries are counted.
- Should excluded entries still count toward a separate, low-severity "monitoring overhead" signal, such as "BetterDB's own commands were slow N times in the last hour"? That would be useful when the monitor itself is adding load.
- The same rule probably applies to COMMANDLOG-based detectors (`large-reply-pressure-detector.ts`) and to `INFO latencystats`-based latency regression (see the issue on latency regression and monitoring commands).

## References

- `apps/api/src/slowlog-analytics/slowlog-analytics.service.ts:37, :88, :126-147, :227-237`
- `proprietary/anomaly-detection/anomaly.service.ts:1534-1562`
- `proprietary/anomaly-detection/correlator.ts:206-207`
- `apps/api/src/anomaly/anomaly.types.ts:118-124`
- `proprietary/anomaly-detection/retry-amplification-attribution.ts:40-47`
- `apps/api/src/database/adapters/unified.adapter.ts:350, :824-841`; `apps/api/src/metrics/metrics.controller.ts:95-113`
- `apps/api/src/cluster/cluster-discovery.service.ts:117, :356`
- `apps/api/src/prometheus/prometheus.service.ts:519-521, :2820-2884, :2947-2953`; `apps/api/src/latency-analytics/latency-analytics.service.ts:17, :72`
- `packages/mcp/skills/betterdb-triage/SKILL.md:46`, which already tells agents not to treat `BetterDB-Monitor` as application traffic
- Harness: `benchmarks/operator-sim/FINDINGS.md` ("Baseline slowlog noise is BetterDB alerting on its own polling"), runs `2026-11-11T14-01-50-665-s42` and `2026-11-10T19-54-07-874-s42`
