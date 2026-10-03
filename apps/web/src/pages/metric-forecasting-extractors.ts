import type { MetricKind } from '@betterdb/shared';
import type { StoredMemorySnapshot } from '../types/metrics';

type Extractor = (snapshot: StoredMemorySnapshot) => number | null;

export const METRIC_EXTRACTORS: Record<MetricKind, Extractor> = {
  opsPerSec: (s) => s.opsPerSec,
  usedMemory: (s) => s.usedMemory,
  cpuTotal: (s) => (s.cpuSys ?? 0) + (s.cpuUser ?? 0),
  memFragmentation: (s) => s.memFragmentationRatio,
};

export function extractMetricPoints(
  snapshots: StoredMemorySnapshot[],
  metricKind: MetricKind,
): Array<{ time: number; value: number }> {
  const extractor = METRIC_EXTRACTORS[metricKind];
  return [...snapshots]
    .sort((a, b) => a.timestamp - b.timestamp)
    .flatMap((s) => {
      const value = extractor(s);
      return value === null ? [] : [{ time: s.timestamp, value }];
    });
}
