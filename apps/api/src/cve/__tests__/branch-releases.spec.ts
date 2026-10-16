import {
  REDIS_BRANCH_FIRST_RELEASE,
  unlistedBranchCeiling,
  NO_CEILING,
} from '../sources/branch-releases';

describe('unlistedBranchCeiling', () => {
  it('table is strictly ascending by date and by branch', () => {
    const dates = REDIS_BRANCH_FIRST_RELEASE.map((e) => Date.parse(e.releasedAt));
    expect(dates.every((d) => !Number.isNaN(d))).toBe(true);
    expect([...dates].sort((a, b) => a - b)).toEqual(dates);
  });
  it('returns NO_CEILING for missing or unparseable dates', () => {
    expect(unlistedBranchCeiling(undefined)).toBe(NO_CEILING);
    expect(unlistedBranchCeiling(null)).toBe(NO_CEILING);
    expect(unlistedBranchCeiling('not a date')).toBe(NO_CEILING);
  });
  it('caps at the first branch released on or after the publish date', () => {
    const first = REDIS_BRANCH_FIRST_RELEASE[0];
    expect(unlistedBranchCeiling(first.releasedAt)).toBe(`${first.branch}.0`);
  });
  it('returns NO_CEILING when every known branch predates the advisory', () => {
    expect(unlistedBranchCeiling('2099-01-01T00:00:00Z')).toBe(NO_CEILING);
  });
});
