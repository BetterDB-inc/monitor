import type { MetricKind, MetricForecastSettings } from '@betterdb/shared';
import type { StoredMemorySnapshot } from '../common/interfaces/storage-port.interface';

export type CeilingResolver = (
  settings: MetricForecastSettings,
  latestSnapshot?: StoredMemorySnapshot,
) => number | null;

export const CEILING_RESOLVERS: Record<MetricKind, CeilingResolver> = {
  opsPerSec: (s) => s.ceiling,

  usedMemory: (s, snapshot) => {
    if (s.ceiling !== null) {
      return s.ceiling;
    }
    if (snapshot && snapshot.maxmemory > 0) return snapshot.maxmemory;
    return null;
  },

  cpuTotal: (s) => s.ceiling ?? 100,

  memFragmentation: (s) => s.ceiling ?? 1.5,
};
