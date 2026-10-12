import { EVICTION_POLICIES, UNKNOWN_EVICTION_COPY, evictionConsequence } from '@betterdb/shared';

describe('eviction copy', () => {
  it('describes every known policy', () => {
    expect([...EVICTION_POLICIES].sort()).toEqual(
      [
        'allkeys-lfu',
        'allkeys-lrm',
        'allkeys-lru',
        'allkeys-random',
        'noeviction',
        'volatile-lfu',
        'volatile-lrm',
        'volatile-lru',
        'volatile-random',
        'volatile-ttl',
      ].sort(),
    );
    for (const policy of EVICTION_POLICIES) expect(evictionConsequence(policy)).not.toBe(UNKNOWN_EVICTION_COPY);
  });

  it('explains noeviction as failing writes', () => {
    expect(evictionConsequence('noeviction')).toBe('Writes start failing with OOM errors once memory is full; reads keep working.');
  });

  it('is case-insensitive and falls back for unknown policies', () => {
    expect(evictionConsequence('ALLKEYS-LRU')).toBe(evictionConsequence('allkeys-lru'));
    expect(evictionConsequence('something-new')).toBe(UNKNOWN_EVICTION_COPY);
  });
});
