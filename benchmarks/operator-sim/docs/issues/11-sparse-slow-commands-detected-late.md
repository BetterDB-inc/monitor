# Detect slow commands within seconds, not on the 30 s SLOWLOG poll

**Suggested labels:** `enhancement`, `anomaly-detection`, `latency`  ·  **Area:** `apps/api/src/slowlog-analytics`, `proprietary/anomaly-detection/anomaly.service.ts`  ·  **Severity:** medium. Slow commands are the slowest fault class BetterDB detects: 10.8–22.7 s after the first slow entry, against 0.6–3.3 s for every other fault in the same test. The delay is random between 0 and 30 s, depending on when the injection lands relative to the poll.

> **Testing:** the harness used to find and reproduce this is on branch [`bench/operator-sim`](https://github.com/BetterDB-inc/monitor/tree/bench/operator-sim/benchmarks/operator-sim) (`benchmarks/operator-sim/`; start with its README). Raw run data (`runs/<id>/*.jsonl`) is not committed; re-run the commands in the test plan to regenerate it.

## Summary

The `slowlog_last_id` anomaly detector runs on the 1 s anomaly poll, but its input only changes every 30 s. It reads the highest SLOWLOG id seen by `SlowLogAnalyticsService`, and that service fetches `SLOWLOG GET 128` only every 30 s. So a burst of slow commands goes unnoticed until the next 30 s SLOWLOG poll, then appears as one large delta. In our test, a client issuing one 80–385 ms (median ≈95 ms) `SMEMBERS` every 2.25 s was detected 10.8 s and 22.7 s after the first slow call in two runs. Every other injected fault was detected in 0.6–3.3 s. This issue proposes (1) a cheap O(1) probe of the SLOWLOG head on the anomaly poll, which triggers an immediate fetch when new entries exist, and (2) scoring a sliding-window count of new external slow entries with a minimum-count floor, in place of a per-poll delta.

> **Correction to an earlier explanation:** our harness report attributed the delay to `slowlog_last_id` needing three consecutive 1 s polls. That is not what the code does. The detector's default is `consecutiveRequired: 1` (`apps/api/src/anomaly/anomaly.types.ts:122`). The run data shows the cause is the 30 s cadence described below.

## How we found it

The findings come from a load-and-fault-injection harness that lives in this repo at [`benchmarks/operator-sim`](../../) (branch `bench/operator-sim`). It runs an independent ground-truth sampler next to BetterDB.

- **Cluster:** kind (Kubernetes v1.37.0) on one 16 vCPU host. valkey-operator v0.8.0, 12 shards × (1 primary + 2 replicas) = 36 Valkey 9.1.2 pods, `slowlog-log-slower-than 10000` (10 ms).
- **BetterDB:** Monitor v0.55.0 (plus local commit `173a4a3f`, which does not touch slowlog code), `CLUSTER_AUTO_REGISTER_NODES=true` (37 connections), `ANOMALY_POLL_INTERVAL_MS=1000`.
- **Injected fault (`slowCommands`):** on shard 3, `SMEMBERS` on a 1M-member set, 40 calls over 90 s (one every 2.25 s), each 90–385 ms. The ground-truth sampler reads `SLOWLOG GET` deltas on every primary each second.
- **Runs:** `runs/2026-11-11T14-01-50-665-s42` (final) and `runs/2026-11-10T19-54-07-874-s42` (previous). `findings.jsonl` holds per-phase detection timings.

## Observed behaviour

Time from the first ground-truth signal of each fault to BetterDB's first on-target finding (`onsetToDetectionMs` in `findings.jsonl`):

| fault | final run | previous run |
|---|---|---|
| **slowCommands** (first SLOWLOG entry on target shard) | **10.8 s** | **22.7 s** |
| spike (cluster ops/s > 1.5× baseline) | 2.5 s | 2.6 s |
| hotShard | 2.7 s | 3.3 s |
| memoryPressure (first eviction) | 2.8 s | 3.3 s |
| replicaLag (offset lag > 1 MiB) | 0.8 s | 1.7 s |
| primaryKill (replica promoted) | 1.9 s | −4.6 s |

The timing in the final run shows the 30 s cadence. Times are seconds after the `slowCommands` phase started:

```
ground truth   1.2 s  valkey-bz-3-0-0  SMEMBERS  128.7 ms   (first slow entry)
ground truth   3.2 s  valkey-bz-3-0-0  SMEMBERS  109.0 ms
ground truth   5.2 s  valkey-bz-3-0-0  SMEMBERS   93.5 ms
ground truth   7.2 s  valkey-bz-3-0-0  SMEMBERS   91.0 ms
BetterDB      12.0 s  23 slowlog_last_id findings on 23 connections within 0.2 s, e.g.
                      valkey-bz-3-0-0: CRITICAL ... Value: 23, Baseline: 0 (28650.0% above normal, Z-score: 17.28)
BetterDB      42.2 s  valkey-bz-3-0-0: CRITICAL ... Value: 13, Baseline: 0
BetterDB      72.1 s  1 finding;  102.2 s  8 findings (incl. valkey-bz-3-0-0 Value: 8);  131.8 s  1 finding
```

Every `slowlog_last_id` finding lands on a 30 s grid (12.0, 42.2, 72.1, 102.2, 131.8 s), across every connection at once, whatever the slow calls' own timing (every 2.25 s). Values arrive in batches (23, then 13, then 8), as if the 30 s backlog were delivered at once, which it is. In the previous run detection took 22.7 s, with a first value of `Value: 28`. That fits a first slow entry that landed shortly after a SLOWLOG poll and waited almost a full 30 s cycle.

## Expected behaviour

A sustained stream of slow commands from an application client is detected within a few seconds, comparable to the other fault classes (≤ 3–4 s at 1 s polling). One isolated slow entry does not raise a CRITICAL finding (see the issue on z-score floors).

## Root cause

All references are to `origin/master` (7b29d758); the code is identical in v0.55.0.

- `apps/api/src/slowlog-analytics/slowlog-analytics.service.ts:36-37`, `:49-51`: `DEFAULT_POLL_INTERVAL_MS = 30000`, hard-coded, with no environment override.
- `slowlog-analytics.service.ts:88`, `:143-147`: each poll fetches `SLOWLOG GET 128` and advances `lastSeenIds` to the highest new id. `getLastSeenId()` (`:227-237`) only changes when that poll runs.
- `proprietary/anomaly-detection/anomaly.service.ts:1534-1562`: on every 1 s anomaly poll, `delta = currentSlowlogId − lastId` is added to the buffer and scored. For 29 of 30 polls the delta is 0. On the poll after a SLOWLOG fetch it is the whole 30 s backlog.
- `apps/api/src/anomaly/anomaly.types.ts:118-124`: `slowlog_last_id` uses warning z 1.5, critical z 2.5, `consecutiveRequired: 1`, cooldown 30 s. One poll is enough to fire, so the consecutive rule is not the delay. The delay is the uniform 0–30 s wait for the next SLOWLOG fetch (expected value 15 s; observed 10.8 s and 22.7 s).
- Side effect: because the input is a 30 s batch, and the 30 s cooldown is in phase with the 30 s poll, repeated findings come about 60 s apart. The same mechanism produces the warm-up waves described in the issue on slowlog alerts from BetterDB's own polling.

## Proposed change

### 1. Probe the SLOWLOG head on the anomaly poll; fetch when it moves

- Add `getSlowLogHeadId(): Promise<number | null>` to the database port. In `apps/api/src/database/adapters/unified.adapter.ts` it calls `SLOWLOG GET 1` and returns the newest entry's id, or `null` when the log is empty. This is O(1) on the server and needs only `+slowlog|get`, which is already in `docs/minimum-acl.md`.
- In `AnomalyService.pollConnection`, every `ANOMALY_SLOWLOG_PROBE_INTERVAL_MS` (default **1000**, i.e. every anomaly poll; `0` disables the probe and keeps the 30 s behaviour), call the probe for connections where `canSlowLog` is available (`RuntimeCapabilityTracker`). The `SLOWLOG GET 1` can be pipelined with the `INFO` call already made each poll.
- When the head id is above `SlowLogAnalyticsService.getLastSeenId(connectionId)`, call a new `SlowLogAnalyticsService.pollNow(connectionId)`. It runs the existing `pollConnection(ctx)` for that one connection, is deduplicated so that only one is in flight per connection, and is rate-limited to once per probe interval. Entries are stored and `lastSeenIds` advanced right away, so the Slow Log page and the Prometheus exporter benefit too.
- The 30 s scheduled poll stays as a backstop, for example for connections where the probe failed.

Cost on a 37-connection cluster: 37 × `SLOWLOG GET 1` per second, a trivial reply each, plus a `SLOWLOG GET 128` only when new entries exist.

### 2. Score a windowed count of external slow entries, with a floor

The per-poll delta becomes, under the same `MetricType.SLOWLOG_LAST_ID` so that settings, UI and API keep working:

> **new external slow entries first seen in the last `W` seconds**, sampled on every anomaly poll.

- `W` = `ANOMALY_SLOWLOG_WINDOW_MS`, default **10 000**. Use the time BetterDB first saw each entry, not the entry's server timestamp, to avoid clock skew. "External" means "not issued by BetterDB's own clients", as proposed in the issue on slowlog alerts from BetterDB's own polling.
- Detector defaults for `slowlog_last_id`: `consecutiveRequired: 1` (unchanged), `cooldownMs: 30000` (unchanged). Add a minimum-count floor `minAbsoluteChange: 2`, meaning at least 2 external slow entries in the window, and `minStdDev: 0.5`, both from the issue on z-score floors. With those floors, a lone slow command (window count 1) does not alert, and a stream of 1 every 2.25 s alerts at the second entry.
- Rename the UI unit in `detector-form.ts` (`METRIC_UNITS.slowlog_last_id`) from "new slowlog entries per poll" to "slow entries in the last 10 s". Update `docs/anomaly-detection.md` (thresholds table and the `slowlog_last_id` section) to match.

Expected detection for the injected fault: the first entry at t₀, the second at t₀ + 2.25 s, and the probe sees it within ≤ 1 s, so detection lands at t₀ + 2.3–3.3 s (today 10.8–22.7 s).

### Back-compat

There is no storage or API shape change. Stored overrides for `slowlog_last_id` keep their z-score and cooldown values. Absolute thresholds, if a user set any, now apply to the windowed count, which in practice means the same or a slightly larger number. Note this in the release notes.

## Acceptance criteria

- [ ] Unit (`anomaly.service.spec.ts`, mocked clock and client): external slow entries appear at t = 1.2, 3.45, 5.7, 7.95 s, the probe runs every 1 s, the buffer is pre-filled with 300 zeros, and the defaults above apply → exactly one `slowlog_last_id` finding, at the t = 4 s poll (2.8 s after the first entry), with `value` 2.
- [ ] Unit: a single external entry at t = 1.2 s and none after → no finding. The windowed count is 1 from t = 2 s to t = 11 s and 0 afterwards.
- [ ] Unit: 3 entries from `BetterDB-Monitor-Node-1234abcd` and none external → no finding.
- [ ] Unit: the probe returns a head id above `lastSeenId` → `pollNow` is called once. Two probes in the same interval → still once. A head id equal to `lastSeenId` → not called.
- [ ] Unit: `ANOMALY_SLOWLOG_PROBE_INTERVAL_MS=0` → no `SLOWLOG GET 1` calls, and behaviour matches today.
- [ ] Unit: the probe fails with a `NOPERM` error → `canSlowLog` is recorded as unavailable (existing `RuntimeCapabilityTracker` path) and the anomaly poll continues.
- [ ] Harness: `slowCommands` `onsetToDetectionMs` ≤ 4 000 in two consecutive runs (today 10 801 and 22 728). No new unmatched `slowlog_last_id` findings in the baseline compared with the same build without this change.

## Test plan

**Unit tests**

- `apps/api/src/slowlog-analytics/__tests__/slowlog-analytics.service.spec.ts`: `pollNow` deduplication and rate limit, and `lastSeenIds` advancing immediately.
- `proprietary/anomaly-detection/__tests__/anomaly.service.spec.ts`: the timing cases above, using `jest.spyOn(Date, 'now')` and a mocked `getSlowLogHeadId` / `getSlowLog` (see the existing "lifetime counter rates" block for the clock pattern).
- `apps/api/src/database/adapters` spec: `getSlowLogHeadId` parses `SLOWLOG GET 1`, returning the id for one entry and `null` for an empty reply.

**Harness reproduction** (Docker, kind, Helm, `BETTERDB_LICENSE_KEY` in `benchmarks/operator-sim/.env`):

```bash
cd benchmarks/operator-sim
SIM_OVERRIDES='{"betterdb":{"buildRef":"<your-branch>"}}' make up betterdb warm
PHASES=slowCommands make scenario
make report
python3 -c "import json; [print(d['phase'], d['onsetToDetectionMs'], d['matched'][:1]) \
  for d in map(json.loads, open('runs/$(ls -t runs | head -1)/findings.jsonl')) if 'phase' in d]"
```

Expect `slowCommands` with `onsetToDetectionMs` ≤ 4000, and a first match on a shard-3 pod (`valkey-bz-3-*`). To see the cadence directly, list the `slowlog_last_id` event times from `runs/<id>/betterdb.jsonl`. They should no longer fall on a 30 s grid.

## Out of scope / open questions

- **Window size and floor.** With `W` = 10 s and a floor of 2, a client that issues one slow command every 6 s or more never alerts through this detector. Is that the right default? An alternative is `W` = 30 s with a floor of 3. That keeps the 2.25 s stream at roughly the same detection time but catches sparser streams later.
- **Should this be threshold-based instead of z-score?** `slowlog-log-slower-than` is already a threshold the operator chose. "≥ N external slow entries in W seconds" could be a plain absolute rule (`warningAbsolute` / `criticalAbsolute` on the windowed count), with the z-score kept only for instances that are always slow.
- **COMMANDLOG.** On Valkey 8.1+, `SLOWLOG` is backed by `COMMANDLOG` (type `slow`). The same probe could also cover the `large-request` / `large-reply` types used by other detectors.
- Excluding BetterDB's own entries and adding z-score floors are prerequisites for the floor to make sense. They are tracked in their own issues.

## References

- `apps/api/src/slowlog-analytics/slowlog-analytics.service.ts:36-51, :58-158, :227-237`
- `proprietary/anomaly-detection/anomaly.service.ts:650, :1534-1562`
- `apps/api/src/anomaly/anomaly.types.ts:118-124`
- `apps/web/src/components/pages/settings/anomaly-detectors/detector-form.ts` (`METRIC_UNITS.slowlog_last_id`)
- `docs/anomaly-detection.md` (thresholds table, `slowlog_last_id` section), `docs/minimum-acl.md:28`
- Harness: `benchmarks/operator-sim/FINDINGS.md` (slowCommands rows for both runs), runs `2026-11-11T14-01-50-665-s42` and `2026-11-10T19-54-07-874-s42`
