import { readInstantStats } from '../instant-stats';

describe('readInstantStats', () => {
  it('parses memory and eviction figures', () => {
    const info: any = {
      memory: { used_memory: '1024', maxmemory: '4096', maxmemory_policy: 'allkeys-lru' },
      stats: { evicted_keys: '7' },
    };
    expect(readInstantStats(info)).toEqual({
      usedMemory: 1024,
      maxmemory: 4096,
      maxmemoryPolicy: 'allkeys-lru',
      evictedKeys: 7,
    });
  });

  it('defaults missing sections to zero and unknown policy', () => {
    expect(readInstantStats({})).toEqual({
      usedMemory: 0,
      maxmemory: 0,
      maxmemoryPolicy: 'unknown',
      evictedKeys: 0,
    });
  });

  it('treats non-numeric values as zero', () => {
    const info: any = {
      memory: { used_memory: 'abc', maxmemory: '', maxmemory_policy: '' },
      stats: { evicted_keys: 'NaN' },
    };
    expect(readInstantStats(info)).toEqual({
      usedMemory: 0,
      maxmemory: 0,
      maxmemoryPolicy: 'unknown',
      evictedKeys: 0,
    });
  });
});
