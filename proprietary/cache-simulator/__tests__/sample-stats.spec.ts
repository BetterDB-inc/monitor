import { adjustedSkewness } from '../sample-stats';

describe('adjustedSkewness', () => {
  it('matches a hand-computed value', () => {
    expect(adjustedSkewness([1, 2, 6])).toBeCloseTo(Math.sqrt(6) * (6 / (14 / 3) ** 1.5), 10);
    expect(adjustedSkewness([1, 2, 6])).toBeCloseTo(1.458, 3);
  });

  it('is zero for symmetric data', () => {
    expect(adjustedSkewness([1, 2, 3])).toBeCloseTo(0, 10);
  });

  it('is zero without variance', () => {
    expect(adjustedSkewness([5, 5])).toBe(0);
    expect(adjustedSkewness([5])).toBe(0);
  });

  it('is untrusted for fewer than three varying values', () => {
    expect(adjustedSkewness([1, 2])).toBe(Number.POSITIVE_INFINITY);
  });
});
