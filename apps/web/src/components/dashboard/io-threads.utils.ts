import type { StoredMemorySnapshot } from '../../types/metrics';

export interface IoThreadPoint {
  time: string;
  reads: number;
  writes: number;
}

/** Decide whether to show the chart vs the single-threaded info card. */
export function shouldShowIoChart(
  isMultiThreaded: boolean,
  hasEverSeenActivity: boolean,
  data: IoThreadPoint[],
): boolean {
  const dataHasActivity = data.some(d => d.reads > 0 || d.writes > 0);
  return isMultiThreaded || hasEverSeenActivity || dataHasActivity;
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
      reads: parseFloat((Math.max(0, (s.ioThreadedReads ?? 0) - (prev.ioThreadedReads ?? 0)) / dtSec).toFixed(1)),
      writes: parseFloat((Math.max(0, (s.ioThreadedWrites ?? 0) - (prev.ioThreadedWrites ?? 0)) / dtSec).toFixed(1)),
    };
  });
}
