# Add minimum-change and minimum-stddev floors to the z-score detectors

**Suggested labels:** `enhancement`, `anomaly-detection`, `false-positive`, `settings`  ·  **Area:** `proprietary/anomaly-detection/spike-detector.ts`, `apps/api/src/anomaly/anomaly.types.ts`, `apps/api/src/settings`, `apps/web/src/components/pages/settings/anomaly-detectors`  ·  **Severity:** medium. Nobody misses an incident because of this, but most of the per-node findings on a quiet or steady cluster are changes too small to matter, rated WARNING or CRITICAL. That buries the real findings and triggers webhooks.

> **Testing:** the harness used to find and reproduce this is on branch [`bench/operator-sim`](https://github.com/BetterDB-inc/monitor/tree/bench/operator-sim/benchmarks/operator-sim) (`benchmarks/operator-sim/`; start with its README). Raw run data (`runs/<id>/*.jsonl`) is not committed; re-run the commands in the test plan to regenerate it.

## Summary

The spike detectors used for INFO metrics, CPU and slowlog compare the newest sample with the mean of the last 300 samples, in units of standard deviations (a "z-score"). The size of the change does not matter, only how unusual it is. When a metric is almost constant, its standard deviation is tiny, so an operationally meaningless change gets a huge z-score. Examples: a fragmentation ratio at 1.00–1.01, CPU at 1–2 %, or a SLOWLOG count that is 0 almost every second. We saw `fragmentation_ratio` rated CRITICAL for 1.01 → 1.02, `cpu_utilization` rated WARNING for 1.7 % → 2.5 % of one core, and one SLOWLOG entry rated CRITICAL. This issue proposes per-metric floors, a minimum absolute change, a minimum relative change and a minimum standard deviation, that a z-score finding must clear. They come with sensible defaults and can be set through the existing detector settings API.

## How we found it

The findings come from a load-and-fault-injection harness that lives in this repo at [`benchmarks/operator-sim`](../../) (branch `bench/operator-sim`).

- **Cluster:** kind (Kubernetes v1.37.0) on one 16 vCPU host. valkey-operator v0.8.0, 12 shards × (1 primary + 2 replicas) = 36 Valkey 9.1.2 pods, 1M preloaded keys, a steady 3000 req/s application mix plus about 1.5k req/s from memtier.
- **BetterDB:** Monitor v0.55.0 (plus local commit `173a4a3f`, which only changes three counter metrics), `CLUSTER_AUTO_REGISTER_NODES=true` (37 connections: seed plus one per pod), `ANOMALY_POLL_INTERVAL_MS=1000`.
- **Scenario:** a 6-minute baseline, then seven injected faults (traffic spike, hot shard, slow commands, memory pressure, replica lag, primary kill, rolling update) over about 40 minutes.
- **Run:** `runs/2026-11-11T14-01-50-665-s42` (final full run). `betterdb.jsonl` holds every BetterDB event seen.

## Observed behaviour

Examples (exact messages from the run data):

```
CRITICAL: fragmentation_ratio spike detected. Value: 1.02, Baseline: 1.01 (1.0% above normal, Z-score: 7.68)
CRITICAL: fragmentation_ratio spike detected. Value: 1.01, Baseline: 1.00 (1.0% above normal, Z-score: 7.39)
WARNING: cpu_utilization spike detected. Value: 2, Baseline: 2 (44.4% above normal, Z-score: 2.50)
CRITICAL: cpu_utilization spike detected. Value: 1, Baseline: 1 (46.5% above normal, Z-score: 5.61)
CRITICAL: memory_used spike detected. Value: 155.20 MB, Baseline: 154.91 MB (0.2% above normal, Z-score: 3.64)
CRITICAL: slowlog_last_id spike detected. Value: 1, Baseline: 0 (14900.0% above normal, Z-score: 12.21)
```

Totals over the whole final run (about 40 minutes, 37 connections):

| metric | events | what the values were |
|---|---|---|
| `fragmentation_ratio` | 139 (133 CRITICAL) | every one between 1.01 and 1.07, never more than 1.4 % from its baseline, standard deviation ≤ 0.0054 |
| `cpu_utilization` | 332 | 329 had a value below 5 % of one core |
| `memory_used` | 142 | 132 were less than 5 % above baseline (typically 0.2 %) |
| `slowlog_last_id` | 338 | 307 had a per-poll count below 3 |

The message format adds to the confusion. `cpu_utilization` values are printed as whole numbers, so "Value: 2, Baseline: 2 (44.4% above normal)" looks like a contradiction. The real values were 2.47 % and 1.71 % (run `2026-11-10T19-54-07-874-s42`).

## Expected behaviour

A finding means "this changed by an amount an operator would care about". A fragmentation ratio moving by 0.01, CPU moving from 1.7 % to 2.5 % of a core, or memory moving by 0.2 % are not findings, whatever their z-score. Absolute thresholds, such as `fragmentation_ratio` ≥ 1.5, keep working as they do today.

## Root cause

All references are to `origin/master` (7b29d758); the code is identical in v0.55.0.

- `proprietary/anomaly-detection/metric-buffer.ts:36-51`: z = (value − mean) / stddev over the buffer, and 0 only when stddev is exactly 0. Nothing stops the standard deviation from being tiny.
- `proprietary/anomaly-detection/anomaly.service.ts:1487-1489` (and `:1555-1556` for slowlog): the current sample is added *before* `detect()`. So for a buffer of 299 zeros, one sample of 1 gives mean ≈ 0.0033, stddev ≈ 0.058 and z ≈ 17.3. That is exactly the "Z-score: 17.29" seen across many nodes for `slowlog_last_id`.
- `proprietary/anomaly-detection/spike-detector.ts:66-102`: the severity comes from `|z|` alone (`warningZScore` / `criticalZScore`). The only floor is `options.minValue` (`:12`, `:77-80`), and it is used by just one detector (`error_replies`, `anomaly.service.ts:4106`, 20/s).
- `spike-detector.ts:45`: `consecutiveRequired` defaults to 3. Per-metric values are in `apps/api/src/anomaly/anomaly.types.ts:98-156`: `fragmentation_ratio` needs 5 consecutive polls, `slowlog_last_id` needs 1. A run of near-constant samples easily keeps |z| high for 5 polls, so `consecutiveRequired` does not filter tiny changes.
- `anomaly.types.ts:225-227` and `anomaly.service.ts:1185-1186`: `cpu_utilization` uses the generic `DEFAULT_SPIKE_CONFIG` (z 2 / 3, 3 consecutive, 60 s, drops enabled) and is **not** configurable through the settings API (`packages/shared/src/types/anomaly-detector-settings.types.ts:15-28`).
- `spike-detector.ts:215-232`: `formatValue` uses `toFixed(0)` for everything except memory and fragmentation, so CPU percentages are rounded to whole numbers.

## Proposed change

### Detector semantics (`spike-detector.ts`)

Add three optional fields to `SpikeDetectorConfig` (`proprietary/anomaly-detection/types.ts`) and to the API `DetectorConfig` (`apps/api/src/anomaly/anomaly.types.ts`):

| field | meaning | unit |
|---|---|---|
| `minStdDev` | z is computed as `(value − mean) / max(stddev, minStdDev)` | metric unit |
| `minAbsoluteChange` | a z-score finding needs `|value − mean| ≥ minAbsoluteChange` | metric unit |
| `minRelativeChange` | a z-score finding needs `|value − mean| / |mean| ≥ minRelativeChange`; skipped when mean = 0 | fraction (0.05 = 5 %) |

Rules:
- The floors gate only the **z-score** severity (`zSeverity`). They never gate the absolute threshold path (`absSeverity`), so `fragmentation_ratio ≥ 1.5` still fires exactly as today.
- A sample that fails a floor counts as "not anomalous". It resets the consecutive counter, the same way `minValue` does today (`spike-detector.ts:77-80`).
- The existing `minValue` option stays. `error_replies` keeps its 20/s.
- The `stdDev` and `zScore` fields on the event report the values that were actually used, with the floor applied.

### Defaults

These are a starting point. Replaying them offline against the final run's events (table below) suppressed about 1,080 of 1,493 spike-detector events, and every injected fault was still detected at the same first-detection time.

| metric | `minAbsoluteChange` | `minRelativeChange` | `minStdDev` | notes |
|---|---|---|---|---|
| `fragmentation_ratio` | 0.1 | 0.05 | 0.02 | absolute 1.5 / 2.0 unchanged |
| `cpu_utilization` | 10 (percentage points of one core) | – | 1 | becomes API-configurable (see below) |
| `memory_used` | 16 MiB | 0.05 | – | |
| `connections` | 5 | 0.2 | 1 | |
| `ops_per_sec` | 100 | 0.5 | – | |
| `input_kbps`, `output_kbps` | 10 | 0.5 | – | |
| `slowlog_last_id` | 3 (new entries) | – | 0.5 | see the issue on sparse slow commands for the window this counts over |
| `keyspace_misses` (per s) | 50 | 0.5 | – | needs the counter-rate fix (see the issue on counter metrics scored as gauges) |
| `evicted_keys` (per s) | 10 | – | – | |
| `blocked_clients` | 2 | – | – | |
| `acl_denied`, `error_replies` | 0 | 0 | – | keep sensitive (security / already floored) |

Offline replay on `runs/2026-11-11T14-01-50-665-s42`, recomputed from each event's `value` and `baseline`. It ignores the effect on consecutive-run counting, so treat it as an estimate:

| metric | events | would be suppressed |
|---|---|---|
| fragmentation_ratio | 139 | 139 |
| cpu_utilization | 332 | 332 |
| memory_used | 142 | 132 |
| connections | 140 | 99 |
| ops_per_sec | 164 | 6 |
| input_kbps | 163 | 32 |
| output_kbps | 44 | 9 |
| slowlog_last_id | 338 | 307 |
| keyspace_misses | 30 | 24 |

First on-target detection per injected fault, before and after the floors: spike 3.3 s → 3.3 s (ops_per_sec), hotShard 4.8 s → 4.8 s, slowCommands 12.0 s → 12.0 s, memoryPressure 3.1 s → 3.1 s, and replicaLag, primaryKill and rollingUpdate unchanged (their detectors are not spike detectors).

### API / DTO / UI

- `DetectorConfig` and `AnomalyDetectorConfigEntry` (`packages/shared/src/types/anomaly-detector-settings.types.ts`) gain `minAbsoluteChange?`, `minRelativeChange?` and `minStdDev?`.
- `apps/api/src/settings/dto/update-anomaly-detectors.dto.ts`, `DetectorConfigDto`: `@IsOptionalNotNull() @IsNumber() @Min(0)` for all three, and `@Max(10)` for `minRelativeChange`. As with the absolute fields, `0` disables the floor.
- `anomaly.types.ts`: add the fields to `DETECTOR_DEFAULTS`, `FINITE_FIELDS`, `resolveDetectorConfig`, `toApiDetectorConfig` and `toSpikeDetectorConfig`. `GET /api/settings/anomaly/detectors` returns them in `defaults`, `overrides` and `resolved`, and `PATCH` accepts them.
- Add `cpu_utilization` to `ANOMALY_DETECTOR_METRICS` and to the API `MetricType` enum (the compile-time sync check in `anomaly.types.ts:31-35` enforces this), with the current hard-coded values as defaults. `detectDrops: true` stays fixed at construction, as it is today.
- `DetectorPanel.tsx`: a "Noise floors" sub-section with the three inputs and the metric's unit (`METRIC_UNITS`).
- `spike-detector.ts` `formatValue`: print `cpu_utilization` with one decimal and a `%` unit (e.g. `Value: 2.5%, Baseline: 1.7%`). Print any value below 10 with up to 2 decimals.

### Back-compat

There are no stored-data changes. Existing overrides keep working, and the new fields are absent from them, so the new defaults apply. This is a **behaviour change**: users get fewer z-score findings on near-constant metrics. Mention it in the release notes, and note that setting a floor to `0` restores the old behaviour per metric.

## Acceptance criteria

- [ ] `fragmentation_ratio`: buffer of 300 samples alternating 1.000 / 1.001, then 5 polls at 1.02 → no finding (today: CRITICAL). The same buffer, then 5 polls at 1.6 → WARNING via the absolute threshold, message `above threshold`.
- [ ] `fragmentation_ratio` with `PATCH {"fragmentation_ratio":{"minAbsoluteChange":0,"minRelativeChange":0,"minStdDev":0}}` → the 1.02 case fires again (old behaviour).
- [ ] `slowlog_last_id`: 299 zeros, then value 1 → no finding. 299 zeros, then 5 → CRITICAL, and the reported z equals `(5 − mean) / max(stddev, 0.5)`.
- [ ] `cpu_utilization`: buffer around 1.5 ± 0.1, value 2.2 → no finding. Value 40 → CRITICAL. The message prints `Value: 40.0%`.
- [ ] A floor failure in the middle of a consecutive run resets it: with `consecutiveRequired = 3`, the sequence above-floor, below-floor, above-floor, above-floor gives no finding until the fourth above-floor sample.
- [ ] `GET /api/settings/anomaly/detectors` lists the three fields for every metric, including `cpu_utilization`. `PATCH` rejects negative values with 400.
- [ ] Harness: a full run (see below) shows `fragmentation_ratio` and `cpu_utilization` with 0 unmatched detections, and all 7 injections detected.

## Test plan

**Unit tests** (`proprietary/anomaly-detection/__tests__/spike-detector.spec.ts`):

```ts
const buf = new MetricBuffer(MetricType.FRAGMENTATION_RATIO, 300, 30);
for (let i = 0; i < 300; i++) buf.addSample(i % 2 ? 1.001 : 1.0, i * 1000);
const det = new SpikeDetector(MetricType.FRAGMENTATION_RATIO, {
  ...toSpikeDetectorConfig(DETECTOR_DEFAULTS.fragmentation_ratio), // includes the new floors
});
for (let t = 0; t < 5; t++) { buf.addSample(1.02, 300_000 + t * 1000); expect(det.detect(buf, 1.02, 300_000 + t * 1000)).toBeNull(); }
```

Plus the slowlog, CPU and reset-on-floor cases from the acceptance criteria. `apps/api/src/anomaly/__tests__/anomaly.types.spec.ts` should cover defaults, merging and `0` disabling a floor. `apps/api/src/settings/settings-anomaly-detectors.spec.ts` should cover DTO validation. `DetectorPanel.test.tsx` should check that the new inputs save.

**Harness reproduction** (Docker, kind, Helm, `BETTERDB_LICENSE_KEY` in `benchmarks/operator-sim/.env`):

```bash
cd benchmarks/operator-sim
SIM_OVERRIDES='{"betterdb":{"buildRef":"<your-branch>"}}' make up betterdb warm
make scenario      # full timeline, ~40 min
make report
```

In `runs/<id>/SUMMARY.md`, the result line should read `7/7 injections detected`, and the "Unmatched detections by metric" list should no longer include `fragmentation_ratio` or `cpu_utilization`. In `runs/<id>/findings.jsonl`, each phase's `firstDetectionMs` should be within ±1 s of the baseline run's (final v0.55.0-based run: spike 3341, hotShard 4752, slowCommands 12017, memoryPressure 3113, replicaLag 6474, primaryKill 4730, rollingUpdate 38806). For a cheaper check, `PHASES=spike,memoryPressure make scenario` covers the gauge metrics.

## Out of scope / open questions

- **Robust statistics.** Using a median and MAD (median absolute deviation) in place of mean and standard deviation would also help with heavy-tailed metrics. That is a larger change to `MetricBuffer`. The floors here are a smaller step and the two can coexist.
- **Should the current sample be excluded from its own baseline?** Today the sample is added before scoring (`anomaly.service.ts:1487-1489`). Excluding it would make z larger (for slowlog, z = ∞ against a zero standard deviation), so the stddev floor becomes *required* if this ever changes.
- **Defaults per deployment size.** Absolute floors such as 100 ops/s or 16 MiB suit the per-node scale in our test. They may be too coarse for tiny instances. Relative floors scale on their own, so maybe use relative floors only for throughput metrics?
- The warm-up storm and the counting of BetterDB's own SLOWLOG entries are tracked separately (see the related issues). They overlap with this issue but need their own fixes.

## References

- `proprietary/anomaly-detection/spike-detector.ts:11-15, :40-48, :55-176, :215-232`
- `proprietary/anomaly-detection/metric-buffer.ts:30-51`
- `proprietary/anomaly-detection/anomaly.service.ts:1185-1186, :1478-1494, :1534-1562, :4097-4110`
- `apps/api/src/anomaly/anomaly.types.ts:98-156, :211-227`
- `apps/api/src/settings/dto/update-anomaly-detectors.dto.ts:60-116`, `apps/api/src/settings/settings.controller.ts:67-114`
- `packages/shared/src/types/anomaly-detector-settings.types.ts`
- `docs/anomaly-detection.md` (thresholds table)
- Harness: `benchmarks/operator-sim/FINDINGS.md` ("BetterDB FP class: fragmentation_ratio"), run `2026-11-11T14-01-50-665-s42`
