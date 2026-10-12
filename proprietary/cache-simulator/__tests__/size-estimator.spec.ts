import { estimate } from '../size-estimator';
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
    expect(result.ci95Bytes).toBeCloseTo(1.96 * Math.sqrt((1000 ** 2 / 2) * 200 * (1 - 2 / 1000)), 6);
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
    expect(result.ci95Bytes).toBeCloseTo(1.96 * Math.sqrt((100 ** 2 / 2) * 200 * (1 - 2 / 100) + 50 ** 2 * 200), 6);
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
    expect(result.ci95Bytes).toBeCloseTo(1.96 * Math.sqrt(expected), 6);
  });

  it('flags partial results', () => {
    expect(estimate([node([{ type: 'string', estimatedKeys: 1, exact: true, observed: 0, sizes: [1] }], true)], 0).partial).toBe(true);
  });

  it('handles empty input', () => {
    const result = estimate([node([])], 0);
    expect(result).toMatchObject({ totalBytes: 0, ci95Bytes: 0, avgKeyBytes: 0, stdKeyBytes: 0, sampleCount: 0, byType: [] });
  });
});
