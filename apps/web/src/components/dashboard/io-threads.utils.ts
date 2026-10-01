import type { StoredMemorySnapshot } from '../../types/metrics';

export interface IoThreadPoint {
  time: string;
  reads: number | null;
  writes: number | null;
}

/** Decide whether to show the chart vs the single-threaded info card. */
export function shouldShowIoChart(
  isMultiThreaded: boolean,
  hasEverSeenActivity: boolean,
  data: IoThreadPoint[],
): boolean {
  const dataHasActivity = data.some(d => (d.reads ?? 0) > 0 || (d.writes ?? 0) > 0);
  return isMultiThreaded || hasEverSeenActivity || dataHasActivity;
}

function ratePerSec(current: number | null, previous: number | null, dtSec: number): number | null {
  if (current == null || previous == null) return null;
  return parseFloat((Math.max(0, current - previous) / dtSec).toFixed(1));
}

/**
 * Derive per-second rate history from cumulative stored counters.
 * The first snapshot is consumed as the baseline and omitted from output.
 */
export function deriveStoredIoDeltas(
  snapshots: StoredMemorySnapshot[],
  formatTime: (ts: number) => string,
): IoThreadPoint[] {
  if (snapshots.length < 2) return [];

  return snapshots.slice(1).map((s, i) => {
    const prev = snapshots[i]; // i is offset by 1 due to slice
    const dtSec = (s.timestamp - prev.timestamp) / 1000;
    if (dtSec <= 0) return { time: formatTime(s.timestamp), reads: 0, writes: 0 };
    return {
      time: formatTime(s.timestamp),
      reads: ratePerSec(s.ioThreadedReads, prev.ioThreadedReads, dtSec),
      writes: ratePerSec(s.ioThreadedWrites, prev.ioThreadedWrites, dtSec),
    };
  });
}
