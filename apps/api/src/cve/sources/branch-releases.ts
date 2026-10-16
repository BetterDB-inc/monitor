/**
 * First GA release (x.y.0) of each Redis branch, ascending. An "All" or
 * lower-bound-only GHSA advisory never lists branches it did not patch. A
 * branch first released on or after the advisory's publish date was cut from
 * a tree that already carried the fix, so it is not affected. A branch
 * released before the advisory and absent from patched_versions is affected.
 *
 * Source: `gh release view <branch>.0 --repo redis/redis --json publishedAt`
 * (5.0 and 6.0 have no GitHub release; their dates are the tag's date).
 * MAINTENANCE: append a row when Redis cuts a new branch. A branch missing
 * here is never cleared (see unlistedBranchCeiling), so a stale table errs
 * toward flagging, not toward a false all-clear.
 */
export const REDIS_BRANCH_FIRST_RELEASE: ReadonlyArray<{ branch: string; releasedAt: string }> = [
  { branch: '5.0', releasedAt: '2018-10-17T15:32:28Z' },
  { branch: '6.0', releasedAt: '2020-04-30T13:05:12Z' },
  { branch: '6.2', releasedAt: '2021-02-22T21:35:15Z' },
  { branch: '7.0', releasedAt: '2022-04-27T13:34:25Z' },
  { branch: '7.2', releasedAt: '2023-08-15T09:40:54Z' },
  { branch: '7.4', releasedAt: '2024-07-29T05:37:26Z' },
  { branch: '8.0', releasedAt: '2025-05-02T11:20:31Z' },
  { branch: '8.2', releasedAt: '2025-08-04T11:14:00Z' },
  { branch: '8.4', releasedAt: '2025-11-18T15:06:37Z' },
];

/** Effectively "no ceiling": matchRanges needs an upper bound to match. */
export const NO_CEILING = '999.0.0';

/**
 * Exclusive upper bound for the unlisted-branch wildcard: the floor of the
 * first branch released on or after `publishedAt`. Returns NO_CEILING when the
 * date is missing/unparseable or every known branch predates the advisory,
 * because then we have no evidence that any newer branch carries the fix.
 */
export function unlistedBranchCeiling(publishedAt: string | null | undefined): string {
  const published = publishedAt ? Date.parse(publishedAt) : Number.NaN;
  if (Number.isNaN(published)) {
    return NO_CEILING;
  }
  const carried = REDIS_BRANCH_FIRST_RELEASE.find((entry) => {
    return Date.parse(entry.releasedAt) >= published;
  });
  return carried ? `${carried.branch}.0` : NO_CEILING;
}
