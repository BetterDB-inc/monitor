import { METRIC_EXTRACTORS } from '../metric-extractors';
import type { StoredMemorySnapshot } from '../../common/interfaces/storage-port.interface';

const snapshot: StoredMemorySnapshot = {
  id: 'snap-1',
  timestamp: Date.now(),
  usedMemory: 50_000_000,
  usedMemoryRss: 60_000_000,
  usedMemoryPeak: 70_000_000,
  memFragmentationRatio: 1.35,
  maxmemory: 100_000_000,
  allocatorFragRatio: 1.1,
  opsPerSec: 12_345,
  cpuSys: 3.5,
  cpuUser: 7.2,
  ioThreadedReads: 100,
  ioThreadedWrites: 50,
  connectionId: 'conn-1',
};

describe('METRIC_EXTRACTORS', () => {
  it('opsPerSec extracts opsPerSec', () => {
    expect(METRIC_EXTRACTORS.opsPerSec(snapshot)).toBe(12_345);
  });

  it('usedMemory extracts usedMemory', () => {
    expect(METRIC_EXTRACTORS.usedMemory(snapshot)).toBe(50_000_000);
  });

  it('cpuTotal sums cpuSys + cpuUser', () => {
    expect(METRIC_EXTRACTORS.cpuTotal(snapshot)).toBeCloseTo(10.7);
  });

  it('memFragmentation extracts memFragmentationRatio', () => {
    expect(METRIC_EXTRACTORS.memFragmentation(snapshot)).toBe(1.35);
  });
});
