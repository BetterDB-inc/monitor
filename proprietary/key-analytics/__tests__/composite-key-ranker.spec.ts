import {
  rankCompositeKeys,
  COMPOSITE_MIN_DIMENSIONS,
  type CompositeCandidate,
} from '../composite-key-ranker';

function candidate(over: Partial<CompositeCandidate> & { keyName: string }): CompositeCandidate {
  return {
    keyType: 'string',
    freqScore: null,
    memoryBytes: null,
    cardinality: null,
    ttl: null,
    ...over,
  };
}

describe('rankCompositeKeys', () => {
  it('emits only keys extreme on at least two dimensions', () => {
    const candidates: CompositeCandidate[] = [
      // top of frequency AND cardinality, but not memory -> composite (2 dims)
      candidate({ keyName: 'hot-big', freqScore: 250, memoryBytes: 100, cardinality: 5000 }),
      // top of memory only -> not composite
      candidate({ keyName: 'mem-hog', freqScore: 1, memoryBytes: 9000, cardinality: 1 }),
      // extreme on nothing
      candidate({ keyName: 'filler', freqScore: 10, memoryBytes: 50, cardinality: 10 }),
    ];

    const ranked = rankCompositeKeys(candidates, 1);

    // Per-dimension top-1: frequency -> hot-big, memory -> mem-hog, cardinality -> hot-big.
    expect(ranked.map((r) => r.keyName)).toEqual(['hot-big']);
    expect(ranked[0].dimensions.length).toBeGreaterThanOrEqual(COMPOSITE_MIN_DIMENSIONS);
    expect(new Set(ranked[0].dimensions)).toEqual(new Set(['frequency', 'cardinality']));
  });

  it('populates a value only for the dimensions the key placed in', () => {
    const candidates: CompositeCandidate[] = [
      candidate({ keyName: 'a', freqScore: 200, memoryBytes: 5000, cardinality: 10 }),
      candidate({ keyName: 'b', freqScore: 199, memoryBytes: 4999, cardinality: 900 }),
    ];

    // Per-dimension top-1: frequency -> a, memory -> a, cardinality -> b.
    // Only 'a' places in >= 2 dimensions (frequency + memory).
    const ranked = rankCompositeKeys(candidates, 1);

    expect(ranked.map((r) => r.keyName)).toEqual(['a']);
    const a = ranked[0];
    expect(a.freqScore).toBe(200);
    expect(a.memoryBytes).toBe(5000);
    // 'a' did not place in cardinality, so it is left null (not its raw value 10).
    expect(a.cardinality).toBeNull();
  });

  it('ranks by dimension count first, then by normalized score', () => {
    const candidates: CompositeCandidate[] = [
      // all three dimensions
      candidate({ keyName: 'triple', freqScore: 255, memoryBytes: 10000, cardinality: 10000 }),
      // frequency + memory, more extreme
      candidate({ keyName: 'pair-hi', freqScore: 254, memoryBytes: 9999, cardinality: 1 }),
      // frequency + memory, less extreme
      candidate({ keyName: 'pair-lo', freqScore: 253, memoryBytes: 9998, cardinality: 2 }),
      // big cardinality, pushes the pair keys out of the cardinality top-3
      candidate({ keyName: 'card-1', freqScore: 1, memoryBytes: 1, cardinality: 9000 }),
      candidate({ keyName: 'card-2', freqScore: 2, memoryBytes: 2, cardinality: 8000 }),
    ];

    const ranked = rankCompositeKeys(candidates, 3);

    // triple (3 dims) outranks any 2-dim key; among the 2-dim keys the more
    // extreme (higher normalized score) comes first. card-* place in one
    // dimension only and are excluded.
    expect(ranked[0].keyName).toBe('triple');
    expect(ranked[0].dimensions.length).toBe(3);
    expect(ranked.slice(1).map((r) => r.keyName)).toEqual(['pair-hi', 'pair-lo']);
  });

  it('treats non-positive, null, and non-finite values as absent on a dimension', () => {
    const candidates: CompositeCandidate[] = [
      candidate({ keyName: 'zeros', freqScore: 0, memoryBytes: 0, cardinality: 0 }),
      candidate({ keyName: 'nan', freqScore: Number.NaN, memoryBytes: 100, cardinality: 100 }),
      candidate({ keyName: 'real', freqScore: 50, memoryBytes: 100, cardinality: 100 }),
    ];

    const ranked = rankCompositeKeys(candidates, 5);

    // 'zeros' contributes to no dimension; 'nan' places in memory + cardinality
    // only (NaN frequency dropped); 'real' places in all three.
    expect(ranked.map((r) => r.keyName)).toEqual(['real', 'nan']);
    expect(ranked.find((r) => r.keyName === 'nan')?.freqScore).toBeNull();
  });

  it('returns nothing for empty input or a non-positive cutoff', () => {
    expect(rankCompositeKeys([], 5)).toEqual([]);
    expect(
      rankCompositeKeys(
        [candidate({ keyName: 'x', freqScore: 1, memoryBytes: 1, cardinality: 1 })],
        0,
      ),
    ).toEqual([]);
  });
});
