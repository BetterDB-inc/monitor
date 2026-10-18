import { compareVersions } from '../matcher/version-range';
import { REDIS_BRANCH_FIRST_RELEASE, unlistedBranchCeiling } from '../sources/branch-releases';

describe('unlistedBranchCeiling', () => {
  it('table is strictly ascending by date and by branch', () => {
    const dates = REDIS_BRANCH_FIRST_RELEASE.map((e) => Date.parse(e.releasedAt));
    expect(dates.every((d) => !Number.isNaN(d))).toBe(true);
    expect([...dates].sort((a, b) => a - b)).toEqual(dates);
  });
  it('table is strictly ascending by branch version (8.10 after 8.8, not string order)', () => {
    const branches = REDIS_BRANCH_FIRST_RELEASE.map((e) => `${e.branch}.0`);
    for (let i = 1; i < branches.length; i++) {
      expect(compareVersions(branches[i], branches[i - 1])).toBeGreaterThan(0);
    }
  });
  it('last known branch is 8.10 (update with each new Redis GA)', () => {
    expect(REDIS_BRANCH_FIRST_RELEASE.at(-1)?.branch).toBe('8.10');
  });
  it('returns no ceiling for missing or unparseable dates', () => {
    expect(unlistedBranchCeiling(undefined)).toBeUndefined();
    expect(unlistedBranchCeiling(null)).toBeUndefined();
    expect(unlistedBranchCeiling('not a date')).toBeUndefined();
  });
  it('caps at the first branch released on or after the publish date', () => {
    const first = REDIS_BRANCH_FIRST_RELEASE[0];
    expect(unlistedBranchCeiling(first.releasedAt)).toBe(`${first.branch}.0`);
  });
  it('returns no ceiling when every known branch predates the advisory', () => {
    expect(unlistedBranchCeiling('2099-01-01T00:00:00Z')).toBeUndefined();
  });
});
