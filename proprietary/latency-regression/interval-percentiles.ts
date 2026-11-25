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

/** Interval P99 for one command, or null when the interval is unusable. */
export function intervalP99(
  before: { calls: number; histogram: Record<string, number> } | undefined,
  after: { calls: number; histogram: Record<string, number> },
): { p99Us: number; calls: number } | null {
  if (!before) return null;
  const calls = after.calls - before.calls;
  if (!(calls >= MIN_INTERVAL_CALLS)) return null;

  const prev = cumulative(before.histogram);
  const next = cumulative(after.histogram);
  const buckets = [...new Set([...prev.map(([b]) => b), ...next.map(([b]) => b)])].sort(
    (a, b) => a - b,
  );
  const target = PERCENTILE * calls;
  let lowerBound = 0;
  let lowerCount = 0;
  for (const bucket of buckets) {
    const delta = countAt(next, bucket) - countAt(prev, bucket);
    if (delta < 0) return null; // counters went backwards: reset
    if (delta >= target) {
      const span = delta - lowerCount;
      const fraction = span > 0 ? (target - lowerCount) / span : 1;
      const low = lowerBound > 0 ? lowerBound : bucket / 2;
      return {
        p99Us: low * Math.pow(bucket / low, Math.min(1, Math.max(0, fraction))),
        calls,
      };
    }
    lowerBound = bucket;
    lowerCount = delta;
  }
  return null; // buckets don't reach 99%: malformed snapshot
}

/** All commands between two consecutive snapshots of one connection. */
export function intervalPoints(
  before: StoredLatencyHistogram,
  after: StoredLatencyHistogram,
): IntervalPoint[] {
  if (after.timestamp <= before.timestamp) return [];
  const points: IntervalPoint[] = [];
  for (const [command, data] of Object.entries(after.data)) {
    const prior = before.data[command];
    if (prior && data.calls < prior.calls) continue; // reset for this command
    const result = intervalP99(prior, data);
    if (!result) continue;
    points.push({
      command: command.toLowerCase(),
      p99Us: result.p99Us,
      calls: result.calls,
      startedAt: before.timestamp,
      capturedAt: after.timestamp,
    });
  }
  return points;
}

/** Calls per minute per command over the points inside [from, to]. */
export function callsPerMinute(
  points: readonly IntervalPoint[],
  from: number,
  to: number,
): Map<string, number> {
  const calls = new Map<string, number>();
  const minutes = new Map<string, number>();
  for (const p of points) {
    if (p.capturedAt < from || p.capturedAt > to) continue;
    calls.set(p.command, (calls.get(p.command) ?? 0) + p.calls);
    minutes.set(p.command, (minutes.get(p.command) ?? 0) + (p.capturedAt - p.startedAt) / 60_000);
  }
  return new Map([...calls].map(([c, n]) => [c, n / Math.max(minutes.get(c) ?? 1, 1e-9)]));
}

/**
 * Server version for an interval ending at `capturedAt`: the latest row at or before it, else
 * the earliest row's version, else ''. `rows` need not be sorted.
 */
export function versionAt(
  rows: ReadonlyArray<{ capturedAt: number; serverVersion: string }>,
  capturedAt: number,
): string {
  let best: { capturedAt: number; serverVersion: string } | undefined;
  let earliest: { capturedAt: number; serverVersion: string } | undefined;
  for (const row of rows) {
    if (!earliest || row.capturedAt < earliest.capturedAt) earliest = row;
    if (row.capturedAt <= capturedAt && (!best || row.capturedAt >= best.capturedAt)) best = row;
  }
  return (best ?? earliest)?.serverVersion ?? '';
}
