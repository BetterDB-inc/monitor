import type { MetricKind } from '@betterdb/shared';
import type { StoredMemorySnapshot } from '../common/interfaces/storage-port.interface';

export type MetricExtractor = (snapshot: StoredMemorySnapshot) => number;

export const METRIC_EXTRACTORS: Record<MetricKind, MetricExtractor> = {
  opsPerSec: (s) => s.opsPerSec,
  usedMemory: (s) => s.usedMemory,
  cpuTotal: (s) => s.cpuSys + s.cpuUser,
  memFragmentation: (s) => s.memFragmentationRatio,
};
