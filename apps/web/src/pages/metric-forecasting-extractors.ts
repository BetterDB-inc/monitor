import type { MetricKind } from '@betterdb/shared';
import type { StoredMemorySnapshot } from '../types/metrics';

type Extractor = (snapshot: StoredMemorySnapshot) => number;

export const METRIC_EXTRACTORS: Record<MetricKind, Extractor> = {
  opsPerSec: (s) => s.opsPerSec,
  usedMemory: (s) => s.usedMemory,
  cpuTotal: (s) => (s.cpuSys ?? 0) + (s.cpuUser ?? 0),
  memFragmentation: (s) => s.memFragmentationRatio,
};
