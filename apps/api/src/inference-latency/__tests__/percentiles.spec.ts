import { computePercentiles } from '../percentiles';

describe('computePercentiles', () => {
  it('returns zeros and count=0 for empty input', () => {
    expect(computePercentiles([])).toEqual({ p50: 0, p95: 0, p99: 0, count: 0 });
  });

  it('returns the sole value for every percentile on a single sample', () => {
    expect(computePercentiles([500])).toEqual({ p50: 500, p95: 500, p99: 500, count: 1 });
  });

  it('uses nearest-rank on five sorted samples', () => {
    expect(computePercentiles([100, 200, 300, 400, 500])).toEqual({
      p50: 300,
      p95: 500,
      p99: 500,
      count: 5,
    });
  });

  it('sorts unsorted input before ranking', () => {
    expect(computePercentiles([500, 100, 400, 200, 300])).toEqual({
      p50: 300,
      p95: 500,
      p99: 500,
      count: 5,
    });
  });

  it('applies ceil(p * n) - 1 rank on 20 samples', () => {
    const samples = Array.from({ length: 20 }, (_, i) => (i + 1) * 10);
    expect(computePercentiles(samples)).toEqual({
      p50: 100,
      p95: 190,
      p99: 200,
      count: 20,
    });
  });

  it('does not mutate the input array', () => {
    const input = [300, 100, 200];
    const snapshot = [...input];
    computePercentiles(input);
    expect(input).toEqual(snapshot);
  });
});
