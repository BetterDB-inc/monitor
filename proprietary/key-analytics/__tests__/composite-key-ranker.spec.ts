import {
  rankCompositeKeys,
  COMPOSITE_MIN_DIMENSIONS,
  type CompositeCandidate,
} from '../composite-key-ranker';

function candidate(over: Partial<CompositeCandidate> & { keyName: string }): CompositeCandidate {
  return {
    keyType: 'string',
    freqScore: null,
    idleSeconds: null,
    memoryBytes: null,
    cardinality: null,
    ttl: null,
    ...over,
  };
}

describe('rankCompositeKeys', () => {
  it('emits only keys extreme on both hotness and cardinality', () => {
    const candidates: CompositeCandidate[] = [
      // top of hotness AND cardinality -> composite
      candidate({ keyName: 'hot-big', freqScore: 250, cardinality: 5000, memoryBytes: 100 }),
      // hot but not big -> not composite
      candidate({ keyName: 'only-hot', freqScore: 240, cardinality: 1 }),
      // big but not hot -> not composite
      candidate({ keyName: 'only-big', freqScore: 1, cardinality: 4000 }),
    ];

    const ranked = rankCompositeKeys(candidates, 1);

    // Per-dimension top-1: hotness -> hot-big, cardinality -> hot-big.
    expect(ranked.map((r) => r.keyName)).toEqual(['hot-big']);
    expect(ranked[0].dimensions.length).toBeGreaterThanOrEqual(COMPOSITE_MIN_DIMENSIONS);
    expect(new Set(ranked[0].dimensions)).toEqual(new Set(['hotness', 'cardinality']));
    expect(ranked[0].freqScore).toBe(250);
    expect(ranked[0].cardinality).toBe(5000);
    // Memory is reported as context even though it is not a ranking dimension.
    expect(ranked[0].memoryBytes).toBe(100);
  });

  it('falls back to idle recency for hotness when LFU frequency is unavailable', () => {
    // Default (non-LFU) policy: OBJECT FREQ is null for every key, so hotness
    // must come from idle time (lower idle = hotter).
    const candidates: CompositeCandidate[] = [
      candidate({ keyName: 'hot-big', freqScore: null, idleSeconds: 1, cardinality: 5000 }),
      candidate({ keyName: 'cold-big', freqScore: null, idleSeconds: 100000, cardinality: 4000 }),
    ];

    const ranked = rankCompositeKeys(candidates, 1);

    // hotness top-1 -> hot-big (idle 1), cardinality top-1 -> hot-big.
    expect(ranked.map((r) => r.keyName)).toEqual(['hot-big']);
    const hb = ranked[0];
    expect(hb.dimensions).toContain('hotness');
    // Hotness placement came from idle, so idleSeconds is reported and freqScore stays null.
    expect(hb.idleSeconds).toBe(1);
    expect(hb.freqScore).toBeNull();
  });

  it('treats a present zero freqScore as LFU-cold, not a missing signal', () => {
    // Under an LFU policy freqScore is present; a decayed 0 counter means the key
    // is cold and must NOT fall back to idle recency, even if it was just accessed.
    const candidates: CompositeCandidate[] = [
      // cold by LFU (freq 0) but idle 0 and the biggest key
      candidate({ keyName: 'cold-lfu-big', freqScore: 0, idleSeconds: 0, cardinality: 10000 }),
      // genuinely hot (freq) and big
      candidate({ keyName: 'hot-big', freqScore: 255, cardinality: 9000 }),
      candidate({ keyName: 'filler', freqScore: 10, cardinality: 1 }),
    ];

    const ranked = rankCompositeKeys(candidates, 2);

    // cold-lfu-big has no hotness (freq 0 dropped, no idle fallback under LFU), so
    // it is big-only -> not composite, despite idle 0 that would top the idle path.
    expect(ranked.map((r) => r.keyName)).toEqual(['hot-big']);
    expect(ranked.find((r) => r.keyName === 'cold-lfu-big')).toBeUndefined();
  });

  it('ranks composites by their normalized score', () => {
    const candidates: CompositeCandidate[] = [
      candidate({ keyName: 'most', freqScore: 255, cardinality: 10000 }),
      candidate({ keyName: 'less', freqScore: 254, cardinality: 9999 }),
      candidate({ keyName: 'least', freqScore: 200, cardinality: 5000 }),
    ];

    const ranked = rankCompositeKeys(candidates, 3);

    // All three are in both top-3 sets, so all are composite; order is by score.
    expect(ranked.map((r) => r.keyName)).toEqual(['most', 'less', 'least']);
  });

  it('does not emit a key that is extreme on only one dimension', () => {
    // Idle recency gives every key *some* hotness magnitude, so discrimination
    // comes from the per-dimension cutoff: a cold key must be pushed out of the
    // hotness top-N by hotter keys. top-1 here isolates that.
    const candidates: CompositeCandidate[] = [
      // biggest, but the coldest -> only cardinality
      candidate({ keyName: 'big-cold', idleSeconds: 999999, cardinality: 100000 }),
      // hottest, but tiny -> only hotness
      candidate({ keyName: 'hot-tiny', idleSeconds: 1, cardinality: 50 }),
      candidate({ keyName: 'filler', idleSeconds: 500, cardinality: 500 }),
    ];

    // top-1: hotness -> hot-tiny, cardinality -> big-cold. Neither is in both.
    expect(rankCompositeKeys(candidates, 1)).toEqual([]);
  });

  it('treats non-positive, null, and non-finite values as absent on a dimension', () => {
    const candidates: CompositeCandidate[] = [
      candidate({ keyName: 'zeros', freqScore: 0, cardinality: 0 }),
      candidate({ keyName: 'nan-hot', freqScore: Number.NaN, cardinality: 100 }),
      candidate({ keyName: 'real', freqScore: 50, cardinality: 100 }),
    ];

    const ranked = rankCompositeKeys(candidates, 5);

    // 'zeros' contributes to no dimension; 'nan-hot' places in cardinality only
    // (NaN frequency dropped, no idle fallback) -> one dimension, excluded;
    // 'real' places in both.
    expect(ranked.map((r) => r.keyName)).toEqual(['real']);
  });

  it('returns nothing for empty input or a non-positive cutoff', () => {
    expect(rankCompositeKeys([], 5)).toEqual([]);
    expect(
      rankCompositeKeys([candidate({ keyName: 'x', freqScore: 1, cardinality: 1 })], 0),
    ).toEqual([]);
  });
});
