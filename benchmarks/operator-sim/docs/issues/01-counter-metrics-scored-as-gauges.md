# Score keyspace_misses, evicted_keys and acl_denied as per-second rates, not lifetime totals

**Suggested labels:** `bug`, `anomaly-detection`, `false-positive`  ·  **Area:** `proprietary/anomaly-detection`, `apps/web/src/components/pages/settings/anomaly-detectors`, `docs/anomaly-detection.md`  ·  **Severity:** high. On any instance with steady read misses, the detector raises a CRITICAL `keyspace_misses` finding every cooldown (60 s) on every connection with a steady stream of read misses, for as long as the misses continue. Once `acl_denied` passes its absolute threshold it fires every 30 s until the server restarts.

> **Testing:** the harness used to find and reproduce this is on branch [`bench/operator-sim`](https://github.com/BetterDB-inc/monitor/tree/bench/operator-sim/benchmarks/operator-sim) (`benchmarks/operator-sim/`; start with its README). Raw run data (`runs/<id>/*.jsonl`) is not committed; re-run the commands in the test plan to regenerate it.

## Summary

Three of the INFO-based z-score detectors read lifetime counters from `INFO stats`: `keyspace_misses`, `evicted_keys` and `acl_access_denied_auth` (metric `acl_denied`). A z-score detector expects a gauge, a value that goes up and down around a stable mean. A counter that only grows always sits above its own trailing mean, so on steady load the z-score passes the threshold every poll and the detector fires at every cooldown. The settings page on `master` already warns that these metrics are lifetime totals, which shows the behaviour is known but has not been fixed. The fix is on local branch `fix/anomaly-cumulative-counter-deltas` (commit `173a4a3f`, not yet pushed). It feeds the three detectors the per-second rate since the previous poll. This issue describes the problem and gives reviewers what they need to check that commit.

## How we found it

The behaviour showed up in a load-and-fault-injection harness that lives in this repo at [`benchmarks/operator-sim`](../../) (branch `bench/operator-sim`). Raw run data is gitignored, but each run's `SUMMARY.md` and `findings.jsonl` are committed.

- **Cluster:** kind (Kubernetes v1.37.0) on one 16 vCPU host, valkey-operator v0.8.0, one `ValkeyCluster` of 12 shards × (1 primary + 2 replicas) = 36 pods, Valkey 9.1.2, `maxmemory 256mb`, `allkeys-lru`.
- **BetterDB:** Monitor v0.55.0 (image `betterdb/monitor:0.55.0-no-ai`), Postgres storage, `CLUSTER_AUTO_REGISTER_NODES=true` (36 per-pod child connections plus the seed connection), `ANOMALY_POLL_INTERVAL_MS=1000`, Enterprise license.
- **Load:** a steady 3000 req/s application mix (HGET / INCR / INCRBY+EXPIRE / SADD+SISMEMBER / ZADD+ZRANGE) plus about 1.5k req/s from memtier over 1M preloaded keys. Some of those reads miss, so `keyspace_misses` grows steadily. No faults were injected.
- **Run:** `make load` (360 s settle, then a 300 s steady window). The steady-window BetterDB events are in `runs/load-2026-11-10T16-34-28-286Z/steady-betterdb.json`.
- **Fix verification:** the full scenario runs `runs/2026-11-10T19-54-07-874-s42` and `runs/2026-11-11T14-01-50-665-s42` used a build of `173a4a3f`.

## Observed behaviour

v0.55.0, steady uninjected load, 300 s window (`steady-betterdb.json`):

| metric | events in 5 min | connections |
|---|---|---|
| `keyspace_misses` | **53** | 12 |

The first and last events in the window:

```
CRITICAL: keyspace_misses spike detected. Value: 31.93K, Baseline: 31.92K (0.0% above normal, Z-score: 11.27)
CRITICAL: keyspace_misses spike detected. Value: 33.20K, Baseline: 33.04K (0.5% above normal, Z-score: 3.39)
```

A value 0.0–0.5% above its baseline is rated CRITICAL. The same mechanism applies to `evicted_keys` once the instance has evicted anything. It also applies to `acl_denied`, whose absolute thresholds (10 / 50) are compared with the lifetime total: after the 50th denial since restart, it fires every 30 s.

With `173a4a3f`, same harness, final full run (`runs/2026-11-11T14-01-50-665-s42`):

- The `memoryPressure` injection (maxmemory lowered to 64 MB plus a write flood) is detected through the rate. Example: `CRITICAL: keyspace_misses spike detected. Value: 2.10K/s, Baseline: 17/s (11930.2% above normal, Z-score: 12.75)`. Elsewhere in the run: `Value: 102/s, Baseline: 11/s`.
- `keyspace_misses` findings outside fault windows: 5. All of them came in the 6-minute warm-up, when application load started on an idle cluster, which is a real step change in the rate (see #712). There were 0 in the 34 minutes after that. The previous full run had 1.

## Expected behaviour

A counter that grows at a steady rate produces no findings. A change in the rate (for example misses going from 17/s to 2.1K/s) produces one. Absolute thresholds on these metrics mean "events per second". A server restart or `CONFIG RESETSTAT` (the counter goes backwards) does not produce a spike or a drop.

## Root cause

`origin/master` (7b29d758; the same code as v0.55.0 for `proprietary/anomaly-detection`):

- `proprietary/anomaly-detection/anomaly.service.ts:1147-1150`: the extractors return the raw counters:
  ```ts
  [MetricType.ACL_DENIED, (info) => this.parseNumber(info.acl_access_denied_auth)],
  [MetricType.EVICTED_KEYS, (info) => this.parseNumber(info.evicted_keys)],
  ...
  [MetricType.KEYSPACE_MISSES, (info) => this.parseNumber(info.keyspace_misses)],
  ```
- `anomaly.service.ts:1478-1489`: the poll loop adds each reading to the buffer unchanged (`buffer.addSample(value, timestamp)`) and calls `detector.detect(buffer, value, timestamp)`.
- `proprietary/anomaly-detection/metric-buffer.ts:30-51`: z = (value − mean) / stddev over the last 300 samples. For a monotonically increasing series the newest sample is always the largest, so z stays high for as long as the counter keeps growing.
- `apps/api/src/anomaly/anomaly.types.ts:125-140`: `acl_denied` has `warningAbsolute: 10`, `criticalAbsolute: 50`, and `spike-detector.ts:106-112` compares them with the raw value.
- The problem was already flagged in the UI: `apps/web/src/components/pages/settings/anomaly-detectors/DetectorPanel.tsx:238-241` shows "This metric is a lifetime total since the server's last restart. Once it passes an absolute threshold it alerts every cooldown until the server restarts." (`LIFETIME_COUNTER_METRICS`, `detector-form.ts:20`).
- `docs/anomaly-detection.md:603` still describes `acl_denied` as "Sum of rejected connections and ACL auth denials". The code has counted only auth denials since `rejected_connections` moved to its own detector.

Other counters already go through a delta step: CPU utilization (`anomaly.service.ts:1498-1532`, rate), `error_replies` (rate, elapsed time floored at the poll interval), and `rejected_connections` and `slowlog_last_id` (per-poll deltas). These three were missed.

## Proposed change (as implemented in `173a4a3f`)

Reviewers can check each point against `git show 173a4a3f`:

1. **`types.ts`**: new `COUNTER_RATE_METRICS = {ACL_DENIED, EVICTED_KEYS, KEYSPACE_MISSES}`.
2. **`anomaly.service.ts`**: new per-connection map `lastCounterReadings: Map<connectionId, Map<MetricType, {value, timestamp}>>` and a helper `counterRate(connectionId, metric, value, timestamp)`:
   - It returns `null` on a connection's first poll, and also when `value < last.value` (restart / `CONFIG RESETSTAT`). In both cases the reading becomes the new baseline.
   - Otherwise it returns `(value − last.value) * 1000 / max(elapsedMs, pollIntervalMs)`, so the elapsed time is floored at the poll interval, the same way `error_replies` does it.
   - In the extractor loop, a `null` rate adds no sample and calls `detector.resetRun()`, so a reset cannot finish a consecutive run.
   - `onConnectionRemoved` deletes `lastCounterReadings` for the connection.
3. **`spike-detector.ts`**: messages for these metrics carry a `/s` unit. A value below 10 prints with up to 2 decimals, so `0.3/s` does not show as `0/s`. The threshold message also prints units, e.g. `Value: 60/s, Threshold: 50/s`.
4. **Web settings**: units become `denials/s`, `evicted keys/s` and `misses/s`, and the lifetime-total warning and `LIFETIME_COUNTER_METRICS` are removed.
5. **Docs**: the thresholds table reads `acl_denied | 10/s | 50/s`, and a paragraph explains the rate, first-poll and reset semantics. The metric descriptions are corrected.

Why a per-second rate and not a per-poll delta like `rejected_connections`: these three metrics have API-configurable absolute thresholds. With a rate, a stored threshold means the same thing whatever `ANOMALY_POLL_INTERVAL_MS` is set to.

**Back-compat:** there is no schema or API shape change. Existing stored overrides for `acl_denied`, `evicted_keys` and `keyspace_misses` keep their numbers but are now read as per-second values. See the open questions.

## Acceptance criteria

- [ ] A connection whose `keyspace_misses` grows by about 100–104 per second for 120 polls produces 0 `keyspace_misses` findings. The buffer holds 120 samples with a maximum of 104 (the first poll adds none).
- [ ] A step from about 102/s to 1000/s for 3 polls produces exactly 1 finding with `value === 1000` and a message containing `Value: 1.00K/s`.
- [ ] A 2 s gap with +200 records 100. A poll 500 ms after the previous one with +50 records 50, not 100, because of the interval floor.
- [ ] A counter that drops from about 1,004,000 to 5 adds no sample and raises no finding. The next poll at 105 records 100, and the buffer minimum stays ≥ 0.
- [ ] `evicted_keys` 5000 → 5030 and `acl_access_denied_auth` 70 → 72 over 1 s record 30 and 2. No `acl_denied` finding fires, because 2/s is below 10/s (the old code compared the total of 72 with 50).
- [ ] Removing a connection deletes its `lastCounterReadings` entry.
- [ ] The settings page shows `Unit: denials/s` and no longer shows the lifetime-total warning.
- [ ] Harness: with this build, `make load` gives 0 `keyspace_misses` events in `steady-betterdb.json` (v0.55.0: 53).

## Test plan

**Unit tests** (all in `173a4a3f`, `proprietary/anomaly-detection/__tests__/anomaly.service.spec.ts`, block `lifetime counter rates (keyspace_misses, evicted_keys, acl_denied)`):

| test | input | expected |
|---|---|---|
| first poll | one poll at 33,000 | buffer sample count 0 |
| steady growth | 121 polls, +100/+104 alternating, 1 s apart | 120 samples, max 104, 0 findings |
| step change | 41 polls steady, then 3 polls of +1000 | 1 finding, value 1000, `Value: 1.00K/s` |
| interval floor | 0 → 200 after 2 s, then +50 after 0.5 s | latest 100, then 50 |
| reset | counter drops to 5 | sample count unchanged, next = 100, no finding |
| other counters | evicted 5000→5030, denied 70→72 | 30 and 2, no `acl_denied` finding |
| cleanup | `onConnectionRemoved('conn-1')` | `lastCounterReadings` no longer has `conn-1` |

`spike-detector.spec.ts` checks the threshold message (`Value: 60/s, Threshold: 50/s (Baseline: 1.05K/s, …)`) and the fractional baseline format (`Value: 50/s, Baseline: 0.3/s`). The existing `rejected_connections` routing test now expects `ACL_DENIED` latest = 3 (auth denials 7 → 10), not the raw 7.

Run: `pnpm --filter api test -- anomaly.service.spec spike-detector.spec` (the api Jest config also picks up tests under `proprietary/`) and `pnpm --filter web test -- detector-form DetectorPanel`.

**Harness reproduction** (needs Docker, kind, Helm and `BETTERDB_LICENSE_KEY` in `benchmarks/operator-sim/.env`):

```bash
cd benchmarks/operator-sim
# Before: build the v0.55.0 tag locally
SIM_OVERRIDES='{"betterdb":{"buildRef":"v0.55.0"}}' make up betterdb warm
make load      # 360 s settle + 300 s steady window
python3 -c "import json,glob,collections; f=sorted(glob.glob('runs/load-*/steady-betterdb.json'))[-1]; \
  print(collections.Counter(e['metricType'] for e in json.load(open(f))['events']))"
# expect keyspace_misses in the tens

# After: the fix
SIM_OVERRIDES='{"betterdb":{"buildRef":"fix/anomaly-cumulative-counter-deltas"}}' make betterdb
make load      # expect no keyspace_misses entries
PHASES=memoryPressure make scenario && make report
# runs/<id>/findings.jsonl: memoryPressure detected, matched text like "keyspace_misses ... Value: <n>/s, Baseline: <m>/s"
```

## Out of scope / open questions

1. **Stored overrides change meaning.** An override saved before this change, such as `acl_denied.criticalAbsolute = 100` meaning "100 denials since restart", is now read as 100/s. The commit does not migrate anything. Options: (a) leave it, since the old meaning alerted forever and is unlikely to be what anyone wants; (b) log a one-time warning at startup when overrides exist for these three metrics; (c) clear their absolute fields in a migration. Maintainers should choose. Related: are the defaults of 10/s and 50/s for `acl_denied` still right as rates? 10 denials per second for 2 consecutive polls is a lot. A slow brute force at 1–5/s is now caught only by the z-score.
2. **Skip the reset poll or use `max(0, delta)`?** On a reset the commit skips the sample and calls `resetRun()`. The alternative is to feed `max(0, value − last)`, which is 0. That adds a sample and keeps the buffer cadence, but puts an artificial 0 into the baseline. Skipping seemed safer. A gap: the code detects a reset only when the counter goes backwards. A connection that silently starts pointing at a different server process with a higher counter will produce one bogus large positive rate. This can happen after a failover behind a Service, or when a child connection is re-pointed after an IP change. A fix would compare `INFO server.run_id` between polls (available as `info.run_id`, already read at `anomaly.service.ts:4310`) and treat a change as a reset.
3. **Interval floor.** The elapsed time is floored at `getIntervalMs()`, which comes from the runtime setting `anomalyPollIntervalMs`. Right after that setting is raised (e.g. 1 s → 5 s), the first rate is divided by the new, larger interval and under-reports once. That is conservative and harmless. CPU utilization (`anomaly.service.ts:1504-1508`) uses the actual `dt` with no floor, so the two derived rates are not consistent. It would be worth making them consistent in a follow-up.
4. **Units differ between detectors.** `rejected_connections` and `slowlog_last_id` are per-poll deltas, while these three and `error_replies` are per-second rates. That is not a bug, but it is confusing in the settings UI.
5. Near-constant baselines and the warm-up storm are separate issues (see #711 and #712).

## References

- Fix: commit `173a4a3f` on branch `fix/anomaly-cumulative-counter-deltas` (parent `ee9d1735`; `proprietary/anomaly-detection`, the settings UI and `docs/anomaly-detection.md` have no differences between `ee9d1735` and `origin/master` 7b29d758, so it applies cleanly).
- `proprietary/anomaly-detection/anomaly.service.ts:1136-1160` (extractors), `:1478-1494` (poll loop)
- `proprietary/anomaly-detection/metric-buffer.ts`, `proprietary/anomaly-detection/spike-detector.ts`
- `apps/api/src/anomaly/anomaly.types.ts:108-156` (`DETECTOR_DEFAULTS`)
- `apps/web/src/components/pages/settings/anomaly-detectors/DetectorPanel.tsx:238`, `detector-form.ts:20`
- `docs/anomaly-detection.md:552`, `:603-626`
- Harness: `benchmarks/operator-sim` (`FINDINGS.md`, `runs/load-2026-11-10T16-34-28-286Z`, `runs/2026-11-11T14-01-50-665-s42`)
