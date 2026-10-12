import { neymanAllocation, splitBudget, STRATUM_FLOOR } from '../allocation';
import { mean, sampleVariance } from '../sample-stats';

describe('sample stats', () => {
  it('computes mean and n-1 variance', () => {
    expect(mean([90, 110])).toBe(100);
    expect(sampleVariance([90, 110])).toBe(200);
  });

  it('returns zero for too few values', () => {
    expect(mean([])).toBe(0);
    expect(sampleVariance([5])).toBe(0);
  });
});

describe('splitBudget', () => {
  it('splits in proportion to key counts', () => {
    expect(splitBudget(4000, [100, 300, 0])).toEqual([1000, 3000, 0]);
  });

  it('gives every non-empty node at least one sample', () => {
    expect(splitBudget(10, [1, 100_000])).toEqual([1, 10]);
  });

  it('returns zeros for an empty keyspace', () => {
    expect(splitBudget(4000, [0, 0])).toEqual([0, 0]);
  });
});

describe('neymanAllocation', () => {
  it('weights by count times spread', () => {
    const result = neymanAllocation(300, [
      { type: 'a', estimatedKeys: 1000, std: 10, sampled: 50 },
      { type: 'b', estimatedKeys: 1000, std: 20, sampled: 50 },
    ]);
    expect(result.get('a')).toBe(100);
    expect(result.get('b')).toBe(200);
  });

  it('falls back to counts when every stratum has zero spread', () => {
    const result = neymanAllocation(100, [
      { type: 'a', estimatedKeys: 300, std: 0, sampled: 0 },
      { type: 'b', estimatedKeys: 100, std: 0, sampled: 0 },
    ]);
    expect(result.get('a')).toBe(75);
    expect(result.get('b')).toBe(30);
  });

  it('applies the floor to zero-spread strata', () => {
    const result = neymanAllocation(100, [
      { type: 'a', estimatedKeys: 1000, std: 100, sampled: 10 },
      { type: 'b', estimatedKeys: 50, std: 0, sampled: 5 },
    ]);
    expect(result.get('a')).toBe(100);
    expect(result.get('b')).toBe(STRATUM_FLOOR - 5);
  });

  it('never asks for more keys than a stratum holds', () => {
    expect(neymanAllocation(100, [{ type: 'a', estimatedKeys: 10, std: 5, sampled: 4 }]).get('a')).toBe(6);
  });
});
