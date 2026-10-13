import { readInstantStats } from '../instant-stats';

describe('readInstantStats', () => {
  it('parses memory figures', () => {
    const info: any = {
      memory: { used_memory: '1024', maxmemory: '4096', maxmemory_policy: 'allkeys-lru', used_memory_dataset: '900' },
    };
    expect(readInstantStats(info)).toEqual({
      usedMemory: 1024,
      maxmemory: 4096,
      maxmemoryPolicy: 'allkeys-lru',
      datasetMemory: 900,
    });
  });

  it('defaults missing sections to zero and unknown policy', () => {
    expect(readInstantStats({})).toEqual({
      usedMemory: 0,
      maxmemory: 0,
      maxmemoryPolicy: 'unknown',
      datasetMemory: null,
    });
  });

  it('treats non-numeric values as zero', () => {
    const info: any = {
      memory: { used_memory: 'abc', maxmemory: '', maxmemory_policy: '', used_memory_dataset: 'NaN' },
    };
    expect(readInstantStats(info)).toEqual({
      usedMemory: 0,
      maxmemory: 0,
      maxmemoryPolicy: 'unknown',
      datasetMemory: 0,
    });
  });
});
