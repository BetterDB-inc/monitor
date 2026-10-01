import { describe, expect, it } from 'vitest';
import { extractMetricPoints } from './metric-forecasting-extractors';
import type { StoredMemorySnapshot } from '../types/metrics';

const stub = (overrides: Partial<StoredMemorySnapshot> = {}): StoredMemorySnapshot => ({
  id: '1',
  timestamp: 0,
  usedMemory: 100,
  usedMemoryRss: 200,
  usedMemoryPeak: 300,
  memFragmentationRatio: 1.2,
  maxmemory: 0,
  allocatorFragRatio: 1.0,
  opsPerSec: 10,
  cpuSys: 1,
  cpuUser: 2,
  ioThreadedReads: 0,
  ioThreadedWrites: 0,
  ...overrides,
});

describe('extractMetricPoints', () => {
  it('sorts snapshots ascending and extracts the metric', () => {
    const points = extractMetricPoints(
      [stub({ timestamp: 2000, opsPerSec: 20 }), stub({ timestamp: 1000, opsPerSec: 10 })],
      'opsPerSec',
    );

    expect(points).toEqual([
      { time: 1000, value: 10 },
      { time: 2000, value: 20 },
    ]);
  });

  it('drops samples whose fragmentation ratio was not pushed instead of plotting zero', () => {
    const points = extractMetricPoints(
      [
        stub({ timestamp: 1000, memFragmentationRatio: 1.4 }),
        stub({ timestamp: 2000, memFragmentationRatio: null }),
        stub({ timestamp: 3000, memFragmentationRatio: 1.5 }),
      ],
      'memFragmentation',
    );

    expect(points).toEqual([
      { time: 1000, value: 1.4 },
      { time: 3000, value: 1.5 },
    ]);
  });
});
