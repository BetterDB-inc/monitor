import { compareVersions } from '../matcher/version-range';
import {
  inferredWildcardCovers,
  REDIS_BRANCH_FIRST_RELEASE,
  unlistedBranchCeiling,
} from '../sources/branch-releases';

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
  it('is not stale: the newest row is under ~6 months old (add the new Redis GA row)', () => {
    // Redis cuts a branch every few months. When this fails, add the new x.y.0
    // GA date (gh release view <x.y>.0 --repo redis/redis) and bump the
    // "last known branch" test above. Until then, newer branches are flagged
    // for every "All"/lower-bound advisory instead of cleared by date.
    const newest = Date.parse(REDIS_BRANCH_FIRST_RELEASE.at(-1)?.releasedAt ?? '');
    const sixMonthsMs = 183 * 24 * 60 * 60 * 1000;
    expect(Date.now() - newest).toBeLessThan(sixMonthsMs);
  });
});

describe('inferredWildcardCovers', () => {
  it.each(['2.6', '4.0', '5.0', '7.0', '7.4', '8.10'])('covers GA branch %s', (branch) => {
    expect(inferredWildcardCovers(branch)).toBe(true);
  });
  it.each(['6.1', '7.1', '7.3', '7.9', '8.1', '8.3', '8.9'])(
    'skips %s, which sits between known GA branches',
    (branch) => {
      expect(inferredWildcardCovers(branch)).toBe(false);
    },
  );
  it.each(['8.11', '8.12', '9.0', '2.4'])('covers %s outside the table (fail safe)', (branch) => {
    expect(inferredWildcardCovers(branch)).toBe(true);
  });
});
