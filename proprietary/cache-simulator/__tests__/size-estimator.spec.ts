import { estimate, keyMemoryCeiling, likelyMissed } from '../size-estimator';
import type { NodeSample } from '../sample-types';

const node = (strata: NodeSample['strata'], timedOut = false): NodeSample => ({
  node: 'n',
  dbSize: strata.reduce((sum, s) => sum + s.estimatedKeys, 0),
  strata,
  exhausted: false,
  timedOut,
});

describe('estimate', () => {
  it('is exact when a stratum is fully enumerated', () => {
    const result = estimate([node([{ type: 'string', estimatedKeys: 3, exact: true, observed: 0, sizes: [10, 20, 30] }])], 5);
    expect(result.totalBytes).toBe(60);
    expect(result.ci95Bytes).toBe(0);
    expect(result.avgKeyBytes).toBe(20);
    expect(result.stdKeyBytes).toBeCloseTo(10, 6);
    expect(result.sampleCount).toBe(3);
    expect(result.sampledAt).toBe(5);
    expect(result.partial).toBe(false);
  });

  it('combines strata with finite population correction', () => {
    const result = estimate(
      [
        node([
          { type: 'string', estimatedKeys: 1000, exact: true, observed: 0, sizes: [90, 110] },
          { type: 'hash', estimatedKeys: 100, exact: true, observed: 0, sizes: [1000, 1000, 1000] },
        ]),
      ],
      0,
    );
    expect(result.totalBytes).toBe(200_000);
    expect(result.ci95Bytes).toBeCloseTo(1.96 * Math.sqrt((1000 ** 2 / 2) * 200 * (1 - 2 / 1000)) + 165_000, 6);
    expect(result.byType[0]).toMatchObject({ type: 'string', keys: 1000, avgBytes: 100, sampled: 2 });
  });

  it('merges the same type across nodes in the by-type view', () => {
    const result = estimate(
      [node([{ type: 'string', estimatedKeys: 100, exact: true, observed: 0, sizes: [50, 50] }]), node([{ type: 'string', estimatedKeys: 300, exact: true, observed: 0, sizes: [150, 150] }])],
      0,
    );
    expect(result.totalBytes).toBe(50_000);
    expect(result.byType).toHaveLength(1);
    expect(result.byType[0]).toMatchObject({ type: 'string', keys: 400, avgBytes: 125, sampled: 4 });
  });

  it('uses the pooled mean for strata without samples', () => {
    const result = estimate(
      [
        node([
          { type: 'string', estimatedKeys: 100, exact: true, observed: 0, sizes: [10, 30] },
          { type: 'hash', estimatedKeys: 50, exact: true, observed: 0, sizes: [] },
        ]),
      ],
      0,
    );
    expect(result.totalBytes).toBe(3000);
    expect(result.ci95Bytes).toBeCloseTo(1.96 * Math.sqrt((100 ** 2 / 2) * 200 * (1 - 2 / 100) + 50 ** 2 * 200) + 4500, 6);
  });

  it('adds count uncertainty for non-exact strata with different means', () => {
    const result = estimate(
      [
        node([
          { type: 'string', estimatedKeys: 600, exact: false, observed: 60, sizes: [100, 100] },
          { type: 'hash', estimatedKeys: 400, exact: false, observed: 40, sizes: [300, 300] },
        ]),
      ],
      0,
    );
    expect(result.totalBytes).toBe(180_000);
    expect(result.ci95Bytes).toBeCloseTo(1.96 * Math.sqrt(10_000 * 9600 * 0.9), 6);
  });

  it('adds no count uncertainty when every stratum is exact', () => {
    const result = estimate(
      [
        node([
          { type: 'string', estimatedKeys: 600, exact: true, observed: 60, sizes: [100, 100] },
          { type: 'hash', estimatedKeys: 400, exact: true, observed: 40, sizes: [300, 300] },
        ]),
      ],
      0,
    );
    expect(result.ci95Bytes).toBe(0);
  });

  it('uses the pooled variance for a single-sample stratum', () => {
    const result = estimate(
      [
        node([
          { type: 'string', estimatedKeys: 100, exact: true, observed: 0, sizes: [10, 30] },
          { type: 'hash', estimatedKeys: 50, exact: true, observed: 0, sizes: [20] },
        ]),
      ],
      0,
    );
    const pooledVariance = 100;
    const expected = (100 ** 2 / 2) * 200 * (1 - 2 / 100) + 50 ** 2 * pooledVariance * (1 - 1 / 50);
    expect(result.ci95Bytes).toBeCloseTo(1.96 * Math.sqrt(expected) + 4500, 6);
  });

  it('adds the rule-of-three allowance for a heavy-tailed stratum', () => {
    const result = estimate([node([{ type: 'string', estimatedKeys: 100, exact: true, observed: 0, sizes: [10, 30] }])], 0);
    expect(result.ci95Bytes).toBeCloseTo(1.96 * Math.sqrt((100 ** 2 / 2) * 200 * (1 - 2 / 100)) + 100 * (3 / 2) * 30, 6);
  });

  it('adds no allowance to a non-skewed stratum', () => {
    const result = estimate([node([{ type: 'string', estimatedKeys: 1000, exact: true, observed: 0, sizes: [90, 100, 110] }])], 0);
    expect(result.ci95Bytes).toBeCloseTo(1.96 * Math.sqrt((1000 ** 2 / 3) * 100 * (1 - 3 / 1000)), 6);
  });

  it('adds no allowance when the stratum is fully sampled', () => {
    const result = estimate([node([{ type: 'string', estimatedKeys: 2, exact: true, observed: 0, sizes: [10, 30] }])], 0);
    expect(result.ci95Bytes).toBe(0);
  });

  it('widens the interval to the memory the sample cannot explain', () => {
    const result = estimate([{ ...node([{ type: 'string', estimatedKeys: 100, exact: true, observed: 0, sizes: [10, 10] }]), ceiling: 5000 }], 0);
    expect(result.totalBytes).toBe(1000);
    expect(result.ci95Bytes).toBe(4000);
  });

  it('widens the interval when the estimate exceeds the memory ceiling', () => {
    const result = estimate([{ ...node([{ type: 'string', estimatedKeys: 100, exact: true, observed: 0, sizes: [1000, 1000] }]), ceiling: 5000 }], 0);
    expect(result.totalBytes).toBe(100_000);
    expect(result.ci95Bytes).toBe(95_000);
  });

  it('treats a nonempty node without measured strata as unsampled', () => {
    const result = estimate([{ node: 'n', dbSize: 100, strata: [], exhausted: false, timedOut: true, ceiling: 5000 }], 0);
    expect(result.totalBytes).toBe(0);
    expect(result.ci95Bytes).toBe(5000);
  });

  it('ignores the memory ceiling when every key was sampled', () => {
    const result = estimate([{ ...node([{ type: 'string', estimatedKeys: 2, exact: true, observed: 0, sizes: [10, 10] }]), ceiling: 5000 }], 0);
    expect(result.ci95Bytes).toBe(0);
  });

  it('keeps the statistical interval when it is wider than the unexplained memory', () => {
    const withoutCeiling = estimate([node([{ type: 'string', estimatedKeys: 1000, exact: true, observed: 0, sizes: [90, 100, 110] }])], 0);
    const withCeiling = estimate([{ ...node([{ type: 'string', estimatedKeys: 1000, exact: true, observed: 0, sizes: [90, 100, 110] }]), ceiling: 100_001 }], 0);
    expect(withCeiling.ci95Bytes).toBe(withoutCeiling.ci95Bytes);
  });

  describe('likely missed large keys', () => {
    const strings = (sizes: number[], ceiling?: number, estimatedKeys = 1000): NodeSample => ({
      ...node([{ type: 'string', estimatedKeys, exact: true, observed: 0, sizes }]),
      ceiling,
    });

    it('flags a sample that falls well below the memory ceiling', () => {
      expect(estimate([strings([100, 100, 100], 2_000_000)], 0).likelyMissedLargeKeys).toBe(true);
    });

    it('does not flag a sample within the ceiling margin', () => {
      expect(estimate([strings([100, 100, 100], 110_000)], 0).likelyMissedLargeKeys).toBe(false);
    });

    it('does not flag an estimate above the ceiling', () => {
      expect(estimate([strings([100, 100, 100], 50_000)], 0).likelyMissedLargeKeys).toBe(false);
    });

    it('does not flag a gap the statistical interval already covers', () => {
      const { ci95Bytes, totalBytes } = estimate([strings([10, 100, 10_000])], 0);
      expect(estimate([strings([10, 100, 10_000], totalBytes + ci95Bytes * 0.9)], 0).likelyMissedLargeKeys).toBe(false);
    });

    it('does not flag without a ceiling or when every key was sampled', () => {
      expect(estimate([strings([100, 100, 100])], 0).likelyMissedLargeKeys).toBe(false);
      expect(estimate([strings([100, 100], 200_000, 2)], 0).likelyMissedLargeKeys).toBe(false);
    });

    it('flags a node that misses large keys even when another node covers the gap', () => {
      const over = strings([1000, 1000, 1000], 100_000);
      const under = strings([100, 100, 100], 2_000_000);
      expect(likelyMissed(estimate([over, under], 0).totalBytes, 0, 2_100_000, 2000)).toBe(false);
      expect(estimate([over, under], 0).likelyMissedLargeKeys).toBe(true);
    });

    it('does not blame large keys for a node with no measurements, but still widens the range', () => {
      const unmeasured: NodeSample = { node: 'n', dbSize: 100, strata: [], exhausted: false, timedOut: true, ceiling: 5000 };
      const result = estimate([unmeasured], 0);
      expect(result.likelyMissedLargeKeys).toBe(false);
      expect(result.ci95Bytes).toBe(5000);
    });

    it('does not flag a node whose ceiling also covers keys in other databases, but still widens the range', () => {
      const result = estimate([{ ...strings([100, 100, 100], 2_000_000), otherDbKeys: true }], 0);
      expect(result.likelyMissedLargeKeys).toBe(false);
      expect(result.ci95Bytes).toBe(1_900_000);
    });

    it('widens the range by the nodes with a known ceiling when another node has none', () => {
      const result = estimate([strings([100, 100, 100], 2_000_000), strings([100, 100, 100])], 0);
      expect(result.likelyMissedLargeKeys).toBe(true);
      expect(result.ci95Bytes).toBe(1_900_000);
    });
  });

  describe('likelyMissed', () => {
    it('needs the gap to exceed both the interval and the margin share of the ceiling', () => {
      expect(likelyMissed(10_000_000, 1000, 20_000_000, 1000)).toBe(true);
      expect(likelyMissed(10_000_000, 15_000_000, 20_000_000, 1000)).toBe(false);
      expect(likelyMissed(10_000_000, 1000, 11_000_000, 1000)).toBe(false);
      expect(likelyMissed(30_000_000, 0, 20_000_000, 1000)).toBe(false);
    });

    it('allows the per-key table overhead a small-value keyspace leaves outside MEMORY USAGE', () => {
      expect(likelyMissed(32_000_000, 0, 40_240_528, 1_000_000)).toBe(false);
      expect(likelyMissed(312_000, 0, 678_032, 10_000)).toBe(false);
      expect(likelyMissed(43_888_890, 0, 62_024_064, 1_000_000)).toBe(false);
    });

    it('still flags a few megabyte-sized keys missing from a small-value keyspace', () => {
      expect(likelyMissed(6_392_000, 0, 8_240_528 + 5 * 2 * 1024 * 1024, 200_000)).toBe(true);
    });
  });

  it('adds the per-key dict entry to the dataset memory for the ceiling', () => {
    expect(keyMemoryCeiling(1000, 10)).toBe(1240);
  });

  it('flags partial results', () => {
    expect(estimate([node([{ type: 'string', estimatedKeys: 1, exact: true, observed: 0, sizes: [1] }], true)], 0).partial).toBe(true);
  });

  it('handles empty input', () => {
    const result = estimate([node([])], 0);
    expect(result).toMatchObject({ totalBytes: 0, ci95Bytes: 0, avgKeyBytes: 0, stdKeyBytes: 0, sampleCount: 0, byType: [] });
  });
});
