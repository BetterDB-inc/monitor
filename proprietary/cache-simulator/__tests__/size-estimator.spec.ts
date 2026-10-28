import { estimate, keyMemoryCeiling } from '../size-estimator';
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
    const result = estimate([node([{ type: 'string', estimatedKeys: 100, exact: true, observed: 0, sizes: [10, 10] }])], 0, 5000);
    expect(result.totalBytes).toBe(1000);
    expect(result.ci95Bytes).toBe(4000);
  });

  it('widens the interval when the estimate exceeds the memory ceiling', () => {
    const result = estimate([node([{ type: 'string', estimatedKeys: 100, exact: true, observed: 0, sizes: [1000, 1000] }])], 0, 5000);
    expect(result.totalBytes).toBe(100_000);
    expect(result.ci95Bytes).toBe(95_000);
  });

  it('treats a nonempty node without measured strata as unsampled', () => {
    const result = estimate([{ node: 'n', dbSize: 100, strata: [], exhausted: false, timedOut: true }], 0, 5000);
    expect(result.totalBytes).toBe(0);
    expect(result.ci95Bytes).toBe(5000);
  });

  it('ignores the memory ceiling when every key was sampled', () => {
    const result = estimate([node([{ type: 'string', estimatedKeys: 2, exact: true, observed: 0, sizes: [10, 10] }])], 0, 5000);
    expect(result.ci95Bytes).toBe(0);
  });

  it('keeps the statistical interval when it is wider than the unexplained memory', () => {
    const withoutCeiling = estimate([node([{ type: 'string', estimatedKeys: 1000, exact: true, observed: 0, sizes: [90, 100, 110] }])], 0);
    const withCeiling = estimate([node([{ type: 'string', estimatedKeys: 1000, exact: true, observed: 0, sizes: [90, 100, 110] }])], 0, 100_001);
    expect(withCeiling.ci95Bytes).toBe(withoutCeiling.ci95Bytes);
  });

  describe('likely missed large keys', () => {
    const strings = (sizes: number[], estimatedKeys = 1000) =>
      node([{ type: 'string', estimatedKeys, exact: true, observed: 0, sizes }]);

    it('flags a sample that falls well below the memory ceiling', () => {
      expect(estimate([strings([100, 100, 100])], 0, 200_000).likelyMissedLargeKeys).toBe(true);
    });

    it('does not flag a sample within the ceiling margin', () => {
      expect(estimate([strings([100, 100, 100])], 0, 110_000).likelyMissedLargeKeys).toBe(false);
    });

    it('does not flag an estimate above the ceiling', () => {
      expect(estimate([strings([100, 100, 100])], 0, 50_000).likelyMissedLargeKeys).toBe(false);
    });

    it('does not flag a gap the statistical interval already covers', () => {
      const wide = strings([10, 100, 10_000]);
      const { ci95Bytes, totalBytes } = estimate([wide], 0);
      expect(estimate([wide], 0, totalBytes + ci95Bytes * 0.9).likelyMissedLargeKeys).toBe(false);
    });

    it('does not flag without a ceiling or when every key was sampled', () => {
      expect(estimate([strings([100, 100, 100])], 0).likelyMissedLargeKeys).toBe(false);
      expect(estimate([strings([100, 100], 2)], 0, 200_000).likelyMissedLargeKeys).toBe(false);
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
