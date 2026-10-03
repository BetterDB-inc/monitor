import { MemoryAdapter } from '../../storage/adapters/memory.adapter';
import { compareBaseline } from '../validation/baseline-comparator';
import type { DatabasePort } from '../../common/interfaces/database-port.interface';
import type { StoredMemorySnapshot } from '../../common/interfaces/storage-port.interface';

const MIGRATION_STARTED_AT = 1_000_000;

function snapshot(i: number, memFragmentationRatio: number | null): StoredMemorySnapshot {
  return {
    id: `snap-${i}`,
    timestamp: MIGRATION_STARTED_AT - (i + 1) * 60_000,
    usedMemory: 1000,
    usedMemoryRss: null,
    usedMemoryPeak: null,
    memFragmentationRatio,
    maxmemory: 0,
    allocatorFragRatio: null,
    opsPerSec: 100,
    cpuSys: 1,
    cpuUser: 1,
    ioThreadedReads: null,
    ioThreadedWrites: null,
  };
}

const target = {
  getInfoParsed: jest.fn().mockResolvedValue({
    stats: { instantaneous_ops_per_sec: '100' },
    memory: { used_memory: '1000', mem_fragmentation_ratio: '1.2' },
    cpu: { used_cpu_sys: '1' },
  }),
} as unknown as DatabasePort;

describe('compareBaseline with fragmentation ratios that were never pushed', () => {
  let storage: MemoryAdapter;

  beforeEach(async () => {
    storage = new MemoryAdapter();
    await storage.initialize();
  });

  it('marks the fragmentation metric unavailable when no source snapshot carries it', async () => {
    await storage.saveMemorySnapshots(
      Array.from({ length: 6 }, (_, i) => snapshot(i, null)),
      'source',
    );

    const result = await compareBaseline(storage, 'source', target, MIGRATION_STARTED_AT);

    expect(result.metrics.find((m) => m.name === 'memFragmentationRatio')).toEqual({
      name: 'memFragmentationRatio',
      sourceBaseline: null,
      targetCurrent: 1.2,
      percentDelta: null,
      status: 'unavailable',
    });
  });

  it('averages only the snapshots that carry a ratio', async () => {
    await storage.saveMemorySnapshots(
      Array.from({ length: 6 }, (_, i) => snapshot(i, i % 2 === 0 ? 1.5 : null)),
      'source',
    );

    const result = await compareBaseline(storage, 'source', target, MIGRATION_STARTED_AT);

    expect(result.metrics.find((m) => m.name === 'memFragmentationRatio')?.sourceBaseline).toBe(1.5);
  });
});
