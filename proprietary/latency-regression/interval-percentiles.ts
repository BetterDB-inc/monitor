import type { StoredLatencyHistogram } from '@app/common/interfaces/storage-port.interface';

/**
 * Per-interval latency percentiles from consecutive LATENCY HISTOGRAM snapshots.
 *
 * `histogram_usec` buckets (powers of two, in microseconds) hold CUMULATIVE call counts since
 * server start (or the last CONFIG RESETSTAT), so subtracting two consecutive snapshots gives the
 * real distribution of the calls made in between. Pure functions, no I/O.
 */

export const MIN_INTERVAL_CALLS = 20;
export const PERCENTILE = 0.99;

export interface IntervalPoint {
  command: string;
  p99Us: number;
  calls: number;
  startedAt: number;
  /** End of the interval = the later snapshot's timestamp. */
  capturedAt: number;
}

/**
 * Call volume of one command over one interval, recorded whether or not the interval had enough
 * calls for a P99. Volume gating must see idle and quiet minutes too, or the rate is inflated.
 */
export interface IntervalVolume {
  command: string;
  calls: number;
  startedAt: number;
  capturedAt: number;
}

type CommandHistogram = { calls: number; histogram: Record<string, number> };

/** Ascending by bucket upper bound. */
type Cumulative = Array<[bucketUs: number, count: number]>;

function cumulative(histogram: Record<string, number>): Cumulative {
  return Object.entries(histogram)
    .map(([bucket, count]) => [Number(bucket), Number(count)] as [number, number])
    .filter(([b, c]) => Number.isFinite(b) && b > 0 && Number.isFinite(c) && c >= 0)
    .sort((a, b) => a[0] - b[0]);
}

/** Cumulative count at or below `bucket`, carrying the nearest lower bucket forward. */
function countAt(series: Cumulative, bucket: number): number {
  let count = 0;
  for (const [b, c] of series) {
    if (b > bucket) break;
    count = c;
  }
  return count;
}

/**
 * Cumulative distribution of the calls made between two snapshots of one command, or null when
 * the counters show a reset (restart, CONFIG RESETSTAT). Every bucket is checked before any
 * percentile is read, so a reset is caught even when the bad bucket sits above the one that
 * reaches the target.
 */
function intervalDistribution(
  before: CommandHistogram,
  after: CommandHistogram,
): { calls: number; series: Cumulative } | null {
  const calls = after.calls - before.calls;
  if (!Number.isFinite(calls) || calls < 0) return null;
  const prev = cumulative(before.histogram);
  const next = cumulative(after.histogram);
  const buckets = [...new Set([...prev.map(([b]) => b), ...next.map(([b]) => b)])].sort(
    (a, b) => a - b,
  );
  const series: Cumulative = [];
  let prevDelta = 0;
  for (const bucket of buckets) {
    const delta = countAt(next, bucket) - countAt(prev, bucket);
    // A real interval distribution is cumulative: never negative, never decreasing across
    // buckets, never above the interval's calls. Anything else means a reset hid in between.
    if (delta < 0 || delta < prevDelta || delta > calls) return null;
    series.push([bucket, delta]);
    prevDelta = delta;
  }
  return { calls, series };
}

/**
 * P99 of an interval distribution. Bucket `b` holds the calls in (b/2, b], so the estimate is
 * interpolated geometrically between b/2 and b. It must not start from the previous *emitted*
 * bucket: Valkey only emits buckets whose count ever grew, and a new regression usually lands
 * several octaves above the node's historical maximum with nothing emitted in between.
 * `lowerCount` stays correct across such gaps: no calls fall between the previous emitted bucket
 * and b/2, so the cumulative count at b/2 equals the previous emitted bucket's count.
 */
function p99Of(dist: { calls: number; series: Cumulative }): number | null {
  const target = PERCENTILE * dist.calls;
  let lowerCount = 0;
  for (const [bucket, count] of dist.series) {
    if (count >= target) {
      const span = count - lowerCount;
      const fraction = span > 0 ? (target - lowerCount) / span : 1;
      const low = bucket / 2;
      return low * Math.pow(2, Math.min(1, Math.max(0, fraction)));
    }
    lowerCount = count;
  }
  return null; // buckets don't reach 99%: malformed snapshot
}

/** Interval P99 for one command, or null when the interval is unusable. */
export function intervalP99(
  before: CommandHistogram | undefined,
  after: CommandHistogram,
): { p99Us: number; calls: number } | null {
  if (!before) return null;
  const dist = intervalDistribution(before, after);
  if (!dist || dist.calls < MIN_INTERVAL_CALLS) return null;
  const p99Us = p99Of(dist);
  return p99Us === null ? null : { p99Us, calls: dist.calls };
}

/**
 * All commands between two consecutive snapshots of one connection: P99 points for intervals
 * with at least MIN_INTERVAL_CALLS calls, and a volume entry for every interval without a
 * detected reset.
 */
export function diffSnapshots(
  before: StoredLatencyHistogram,
  after: StoredLatencyHistogram,
): { points: IntervalPoint[]; volumes: IntervalVolume[] } {
  const points: IntervalPoint[] = [];
  const volumes: IntervalVolume[] = [];
  if (after.timestamp <= before.timestamp) return { points, volumes };
  for (const [command, data] of Object.entries(after.data)) {
    const prior = before.data[command];
    if (!prior) continue; // new command: no baseline yet
    const dist = intervalDistribution(prior, data);
    if (!dist) continue; // reset for this command
    const name = command.toLowerCase();
    volumes.push({
      command: name,
      calls: dist.calls,
      startedAt: before.timestamp,
      capturedAt: after.timestamp,
    });
    if (dist.calls < MIN_INTERVAL_CALLS) continue;
    const p99Us = p99Of(dist);
    if (p99Us === null) continue;
    points.push({
      command: name,
      p99Us,
      calls: dist.calls,
      startedAt: before.timestamp,
      capturedAt: after.timestamp,
    });
  }
  return { points, volumes };
}

/** P99 points only. Kept for callers and specs that don't need volumes. */
export function intervalPoints(
  before: StoredLatencyHistogram,
  after: StoredLatencyHistogram,
): IntervalPoint[] {
  return diffSnapshots(before, after).points;
}

/**
 * Calls per minute per command over the observations inside [from, to]. Pass IntervalVolume[]
 * (every interval), not IntervalPoint[]: points skip quiet minutes and inflate the rate.
 */
export function callsPerMinute(
  observations: ReadonlyArray<{
    command: string;
    calls: number;
    startedAt: number;
    capturedAt: number;
  }>,
  from: number,
  to: number,
): Map<string, number> {
  const calls = new Map<string, number>();
  const minutes = new Map<string, number>();
  for (const o of observations) {
    if (o.capturedAt < from || o.capturedAt > to) continue;
    calls.set(o.command, (calls.get(o.command) ?? 0) + o.calls);
    minutes.set(o.command, (minutes.get(o.command) ?? 0) + (o.capturedAt - o.startedAt) / 60_000);
  }
  return new Map([...calls].map(([c, n]) => [c, n / Math.max(minutes.get(c) ?? 1, 1e-9)]));
}

type VersionRow = { capturedAt: number; serverVersion: string };

/**
 * Builds a version lookup once: rows sorted by time, collapsed to the points where the version
 * changes, then binary-searched. O(n log n) to build, O(log n) per lookup. Same answers as a
 * linear scan: the latest row at or before `capturedAt`, else the earliest row, else ''.
 * Among rows tied on capturedAt, the later input row wins a match and the first input row is the
 * "earliest" fallback.
 */
export function versionTimeline(rows: ReadonlyArray<VersionRow>): (capturedAt: number) => string {
  const sorted = rows
    .filter((r) => Number.isFinite(r.capturedAt))
    .sort((a, b) => a.capturedAt - b.capturedAt); // stable: ties keep input order
  const earliest = sorted[0]?.serverVersion ?? '';
  const at: number[] = [];
  const version: string[] = [];
  for (const row of sorted) {
    const lastIdx = version.length - 1;
    if (lastIdx >= 0 && at[lastIdx] === row.capturedAt) {
      version[lastIdx] = row.serverVersion; // tie: later input row wins
      continue;
    }
    if (lastIdx >= 0 && version[lastIdx] === row.serverVersion) continue;
    at.push(row.capturedAt);
    version.push(row.serverVersion);
  }
  return (capturedAt: number): string => {
    let lo = 0;
    let hi = at.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (at[mid] <= capturedAt) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found === -1 ? earliest : version[found];
  };
}

/**
 * Server version for an interval ending at `capturedAt`. Convenience wrapper; for many lookups
 * build the timeline once with versionTimeline().
 */
export function versionAt(rows: ReadonlyArray<VersionRow>, capturedAt: number): string {
  return versionTimeline(rows)(capturedAt);
}
