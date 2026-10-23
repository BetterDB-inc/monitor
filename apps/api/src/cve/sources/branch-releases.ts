/**
 * First GA release (x.y.0) of each Redis branch, ascending. An "All" or
 * lower-bound-only GHSA advisory never lists branches it did not patch. A
 * branch first released on or after the advisory's publish date was cut from
 * a tree that already carried the fix, so it is not affected. A branch
 * released before the advisory and absent from patched_versions is affected.
 *
 * Source: `gh release view <branch>.0 --repo redis/redis --json publishedAt`
 * (2.6 through 6.0 have no GitHub release; their dates are the tag's date).
 * MAINTENANCE: append a row when Redis cuts a new branch. A branch missing
 * here is never cleared (see unlistedBranchCeiling), so a stale table errs
 * toward flagging, not toward a false all-clear. Adding the row is part of
 * tracking a new Redis GA. `branch-releases.spec.ts` checks ordering, and the
 * `last known branch` test there must be updated in the same PR.
 */
export const REDIS_BRANCH_FIRST_RELEASE: ReadonlyArray<{ branch: string; releasedAt: string }> = [
  { branch: '2.6', releasedAt: '2012-10-22T21:27:28Z' },
  { branch: '2.8', releasedAt: '2013-11-22T09:25:57Z' },
  { branch: '3.0', releasedAt: '2015-04-01T14:02:50Z' },
  { branch: '3.2', releasedAt: '2016-05-06T10:14:05Z' },
  { branch: '4.0', releasedAt: '2017-07-14T13:06:26Z' },
  { branch: '5.0', releasedAt: '2018-10-17T15:32:28Z' },
  { branch: '6.0', releasedAt: '2020-04-30T13:05:12Z' },
  { branch: '6.2', releasedAt: '2021-02-22T21:35:15Z' },
  { branch: '7.0', releasedAt: '2022-04-27T13:34:25Z' },
  { branch: '7.2', releasedAt: '2023-08-15T09:40:54Z' },
  { branch: '7.4', releasedAt: '2024-07-29T05:37:26Z' },
  { branch: '8.0', releasedAt: '2025-05-02T11:20:31Z' },
  { branch: '8.2', releasedAt: '2025-08-04T11:14:00Z' },
  { branch: '8.4', releasedAt: '2025-11-18T15:06:37Z' },
  { branch: '8.6', releasedAt: '2026-02-10T14:15:04Z' },
  { branch: '8.8', releasedAt: '2026-05-25T09:29:25Z' },
  { branch: '8.10', releasedAt: '2026-07-29T17:20:06Z' },
];

/**
 * Exclusive upper bound for the unlisted-branch wildcard: the floor of the
 * first branch released on or after `publishedAt`. Returns undefined (no
 * ceiling) when the date is missing/unparseable or every known branch predates
 * the advisory, because then we have no evidence that any newer branch carries
 * the fix.
 */
export function unlistedBranchCeiling(publishedAt: string | null | undefined): string | undefined {
  const published = publishedAt ? Date.parse(publishedAt) : Number.NaN;
  if (Number.isNaN(published)) {
    return undefined;
  }
  const carried = REDIS_BRANCH_FIRST_RELEASE.find((entry) => {
    return Date.parse(entry.releasedAt) >= published;
  });
  return carried ? `${carried.branch}.0` : undefined;
}

function branchParts(branch: string): [number, number] {
  const [major, minor] = branch.split('.').map((part) => {
    const numeric = parseInt(part, 10);
    return Number.isNaN(numeric) ? 0 : numeric;
  });
  return [major ?? 0, minor ?? 0];
}

function compareBranches(a: string, b: string): number {
  const [aMajor, aMinor] = branchParts(a);
  const [bMajor, bMinor] = branchParts(b);
  return aMajor !== bMajor ? aMajor - bMajor : aMinor - bMinor;
}

const KNOWN_BRANCHES: ReadonlySet<string> = new Set(
  REDIS_BRANCH_FIRST_RELEASE.map((entry) => entry.branch),
);

/**
 * Whether an inferred unlisted-branch wildcard may flag a version on `branch`.
 * The wildcard's ceiling is a version number, so on its own it would also
 * cover minors that never shipped as a Redis GA line (7.1, 8.3, or a
 * pre-release/managed-service minor). Those sit between two known branches
 * and are skipped. A branch in the table is covered (the ceiling already clears
 * branches cut after disclosure). A branch newer than the last row, or older
 * than the first, is covered too: we have no release date for it, so we never
 * clear it on missing evidence.
 */
export function inferredWildcardCovers(branch: string): boolean {
  if (KNOWN_BRANCHES.has(branch)) {
    return true;
  }

  const first = REDIS_BRANCH_FIRST_RELEASE[0].branch;
  const last = REDIS_BRANCH_FIRST_RELEASE[REDIS_BRANCH_FIRST_RELEASE.length - 1].branch;

  return compareBranches(branch, last) > 0 || compareBranches(branch, first) < 0;
}
