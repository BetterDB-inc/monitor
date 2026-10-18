import type {
  Advisory,
  BranchRange,
  CveConfidence,
  CveProduct,
  CveSeverity,
} from '@betterdb/shared';
import { GHSA_REPOS } from '../cve.constants';
import { branchOf } from '../matcher/version-range';
import { unlistedBranchCeiling } from './branch-releases';
import {
  fetchLinkedJson,
  type LinkedJson,
  type CveSource,
  type FetchLike,
  type SourceFetchResult,
} from './cve-source.interface';

interface GhsaVulnerability {
  vulnerable_version_range?: string | null;
  patched_versions?: string | null;
}

interface GhsaAdvisory {
  ghsa_id: string;
  cve_id: string | null;
  summary: string;
  severity: string;
  cvss?: { score?: number | null } | null;
  cwe_ids?: string[] | null;
  html_url: string;
  published_at?: string | null;
  vulnerabilities?: GhsaVulnerability[] | null;
}

const SEVERITIES: CveSeverity[] = ['low', 'medium', 'high', 'critical'];

const GHSA_PAGE_SIZE = 100;

const GHSA_MAX_PAGES = 10;

// The unlisted-branch inference relies on REDIS_BRANCH_FIRST_RELEASE, which
// only describes the redis/redis engine version line. Module repos
// (RediSearch, …) use unrelated version numbers, and Valkey advisories list
// every affected branch. Opt-in only, so a repo added to GHSA_REPOS later
// cannot silently inherit it.
const WILDCARD_REPOS: ReadonlySet<string> = new Set(['redis/redis']);

function toSeverity(raw: string): CveSeverity {
  const lowered = raw.toLowerCase();
  const known = SEVERITIES.find((severity) => {
    return severity === lowered;
  });

  return known ?? 'medium';
}

// One patched_versions token: "6.2.17", the two-part "6.2" (= 6.2.0), Redis's
// "6.2.X" placeholder, optionally open-ended with ">=" / "+" / "and above" /
// "or later" / "or newer".
const PATCHED_TOKEN_PATTERN =
  /^(?<gte>>=\s*)?(?<major>\d+)\.(?<minor>\d+)(?:\.(?<patch>\d+|x))?(?<tail>\s*\+|\s+(?:and|or)\s+(?:above|later|newer))?$/i;
const THREE_PART_VERSION_PATTERN = /\d+\.\d+\.\d+/g;
const VER = String.raw`\d+\.\d+(?:\.\d+)?`;
// ">= 7.2", ">= 7.2.0", "7.0 or newer", "7.0 and later".
const LOWER_BOUND_PATTERN = new RegExp(
  String.raw`(?:>=\s*(${VER}))|(?:(${VER})\s+(?:or|and)\s+(?:newer|later|above))`,
  'i',
);
// Empty, "TBD", "none", "n/a" or "-": the vendor has not published a fix.
const NO_FIX_PATTERN = /^\s*(tbd|none|n\/a|-)?\s*$/i;
const NO_FIX_TOKEN_PATTERN = /^(tbd|none|n\/a|-)$/i;
const AT_OR_BELOW_PATTERN = /(?:^|,)\s*<=\s*(\d+\.\d+\.\d+)/;
const BELOW_PATTERN = /(?:^|,)\s*<\s*(\d+\.\d+\.\d+)/;

/** Vendor typos seen in real advisories: "=>" for ">=", "=<" for "<=". */
function normalizeRange(range: string): string {
  return range.replace(/=>/g, '>=').replace(/=</g, '<=');
}

/** Pads "7.2" to "7.2.0" so compareVersions/branchOf get three parts. */
function padVersion(version: string): string {
  return version.split('.').length === 2 ? `${version}.0` : version;
}

function lowerBoundOf(range: string): string | null {
  const match = range.match(LOWER_BOUND_PATTERN);
  const version = match?.[1] ?? match?.[2];
  return version ? padVersion(version) : null;
}

function lowerBoundFor(vulnerableVersionRange: string | undefined, branch: string): string | null {
  if (vulnerableVersionRange === undefined) {
    return null;
  }

  const lower = lowerBoundOf(vulnerableVersionRange);
  if (lower === null || branchOf(lower) !== branch) {
    return null;
  }

  return lower;
}

interface ParsedPatched {
  /** Concrete fix versions, padded to three parts ("6.2" becomes "6.2.0"). */
  versions: string[];
  /**
   * False when any non-TBD token is not a concrete version ("6.2.X", prose) or
   * is open-ended (">= 8.0.4", "8.0.4+", "8.0.4 and above"). The vendor named a
   * fix we can't place, or one that may also claim newer branches, so the
   * unlisted-branch inference can't be trusted for this advisory.
   */
  complete: boolean;
}

function parsePatchedVersions(patchedVersions: string): ParsedPatched {
  const versions: string[] = [];
  let complete = true;

  for (const token of patchedVersions.split(',').map((part) => part.trim())) {
    if (token.length === 0 || NO_FIX_TOKEN_PATTERN.test(token)) {
      continue;
    }

    const match = token.match(PATCHED_TOKEN_PATTERN);
    if (!match?.groups) {
      // Unrecognized prose: keep any full version it names, but don't trust it.
      versions.push(...(token.match(THREE_PART_VERSION_PATTERN) ?? []));
      complete = false;
      continue;
    }

    const { gte, major, minor, patch, tail } = match.groups;
    if (patch !== undefined && /^x$/i.test(patch)) {
      complete = false;
      continue;
    }

    versions.push(`${major}.${minor}.${patch ?? '0'}`);
    if (gte !== undefined || tail !== undefined) {
      // "8.0.4 and above" is a fix for its own branch (kept above), but whether it
      // also claims every newer branch is ambiguous, and the wildcard would
      // contradict the vendor. Don't infer unlisted branches; NVD wins.
      complete = false;
    }
  }

  return { versions, complete };
}

function exactRangesFromPatchedVersions(
  versions: string[],
  vulnerableVersionRange: string | undefined,
): BranchRange[] {
  const ranges: BranchRange[] = [];

  for (const version of versions) {
    const branch = branchOf(version);
    const vulnerableFrom = lowerBoundFor(vulnerableVersionRange, branch);

    ranges.push({
      branch,
      vulnerableBelow: version,
      patchedAt: version,
      ...(vulnerableFrom === null ? {} : { vulnerableFrom }),
    });
  }

  return ranges;
}

function upperBoundOf(
  vulnerableVersionRange: string,
): Pick<BranchRange, 'vulnerableAtOrBelow' | 'vulnerableBelow'> | null {
  const atOrBelow = vulnerableVersionRange.match(AT_OR_BELOW_PATTERN);
  if (atOrBelow) {
    return { vulnerableAtOrBelow: atOrBelow[1] };
  }

  const below = vulnerableVersionRange.match(BELOW_PATTERN);
  if (below) {
    return { vulnerableBelow: below[1] };
  }

  return null;
}

function unpatchedRangeFrom(vulnerableVersionRange: string): BranchRange | null {
  const upper = upperBoundOf(vulnerableVersionRange);
  if (upper === null) {
    return null;
  }

  const ceiling = upper.vulnerableAtOrBelow ?? upper.vulnerableBelow ?? '';
  const lower = lowerBoundOf(vulnerableVersionRange);

  if (lower === null) {
    return { branch: '*', ...upper };
  }

  const branch = branchOf(lower);

  if (branch !== branchOf(ceiling)) {
    return { branch: '*', ...upper, vulnerableFrom: lower };
  }

  return { branch, ...upper, vulnerableFrom: lower };
}

interface AffectedRanges {
  affected: BranchRange[];
  confidence: CveConfidence;
}

const ALL_VERSIONS_PATTERN = /^\s*(all|any|\*)(\s+versions?)?\s*$/i;
const ANY_UPPER_BOUND_PATTERN = /<=?\s*\d+\.\d+(?:\.\d+)?/g;
const AND_BELOW_PATTERN = /\band below\b/i;

/**
 * `patched_versions` only names branches that received a fix. When the
 * affected range is all-versions ("All") or has a floor and no ceiling
 * (">= 7.0", "7.0 and newer"), a branch it does not list is affected unless
 * it was cut after the advisory was published. The wildcard is therefore
 * capped at the first branch released on or after `published_at`
 * (branch-releases.ts), never at the newest listed fix: a branch above the
 * newest fix but released before disclosure (e.g. 7.4/8.0 when only 6.2 and
 * 7.2 are patched) stays flagged. With no date, or no newer known branch,
 * the wildcard has no upper bound (fail safe). matchRanges() still never lets the
 * wildcard override a fix published on the version's own branch.
 *
 * Nothing is inferred when: the range has any upper bound (already
 * branch-scoped); the range is missing/unparseable; there is no published
 * fix ("TBD", NVD wins); or a patched token cannot be placed ("6.2.X").
 */
function unlistedBranchFallback(
  rawRange: string | undefined,
  patched: ParsedPatched,
  publishedAt: string | null | undefined,
): BranchRange | null {
  if (patched.versions.length === 0 || !patched.complete) {
    return null;
  }

  const range = normalizeRange(rawRange ?? '');
  const ceiling = unlistedBranchCeiling(publishedAt);
  // Absent, not undefined, so toEqual, JSON and computeDatasetVersion never see a key.
  const bound = ceiling === undefined ? {} : { vulnerableBelow: ceiling };

  // A missing range is unknown, not "all versions": only an explicit marker counts.
  if (ALL_VERSIONS_PATTERN.test(range)) {
    return { branch: '*', vulnerableFrom: '0.0.0', ...bound, inferred: true };
  }

  const upperBounds = range.match(ANY_UPPER_BOUND_PATTERN) ?? [];
  const lower = lowerBoundOf(range);
  if (lower !== null && upperBounds.length === 0 && !AND_BELOW_PATTERN.test(range)) {
    return { branch: '*', vulnerableFrom: lower, ...bound, inferred: true };
  }

  return null;
}

function toAffectedRanges(
  vulnerabilities: GhsaVulnerability[],
  repo: string,
  publishedAt: string | null | undefined,
): AffectedRanges {
  const exact: BranchRange[] = [];
  const unpatched: BranchRange[] = [];
  const allowWildcard = WILDCARD_REPOS.has(repo);

  for (const vulnerability of vulnerabilities) {
    const patchedRaw = vulnerability.patched_versions?.trim() ?? '';
    const patchedVersions = NO_FIX_PATTERN.test(patchedRaw) ? '' : patchedRaw;
    const rawRange = vulnerability.vulnerable_version_range?.trim();
    const patched = parsePatchedVersions(patchedVersions);

    if (patched.versions.length > 0) {
      exact.push(
        ...exactRangesFromPatchedVersions(patched.versions, normalizeRange(rawRange ?? '')),
      );
      const fallback = allowWildcard ? unlistedBranchFallback(rawRange, patched, publishedAt) : null;
      if (fallback) {
        exact.push(fallback);
      }
      continue;
    }

    if (patchedVersions) {
      // Patched versions were named but none could be placed ("6.2.X"):
      // don't guess. NVD's range wins for this advisory.
      continue;
    }

    if (rawRange === undefined || rawRange.length === 0) {
      continue;
    }

    const range = unpatchedRangeFrom(normalizeRange(rawRange));
    if (range) {
      unpatched.push(range);
    }
  }

  if (exact.length > 0) {
    return { affected: [...exact, ...unpatched], confidence: 'exact' };
  }

  if (unpatched.length > 0) {
    return { affected: unpatched, confidence: 'broad' };
  }

  return { affected: [], confidence: 'unversioned' };
}

function toAdvisory(raw: GhsaAdvisory, product: CveProduct, repo: string): Advisory | null {
  if (!raw.cve_id) {
    return null;
  }

  const { affected, confidence } = toAffectedRanges(
    raw.vulnerabilities ?? [],
    repo,
    raw.published_at,
  );

  return {
    cveId: raw.cve_id,
    aliases: [raw.ghsa_id],
    product,
    affected,
    severity: toSeverity(raw.severity),
    ...(typeof raw.cvss?.score === 'number' ? { cvssScore: raw.cvss.score } : {}),
    cwes: raw.cwe_ids ?? [],
    knownExploited: false,
    confidence,
    sources: [{ source: 'ghsa', fields: ['affected', 'severity', 'cvssScore', 'summary'] }],
    summary: raw.summary,
    references: [raw.html_url],
  };
}

export class GhsaSource implements CveSource {
  readonly id = 'ghsa' as const;

  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly token?: string,
  ) {}

  private headers(): Record<string, string> {
    if (this.token === undefined) {
      return { accept: 'application/vnd.github+json' };
    }

    return {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${this.token}`,
    };
  }

  private async fetchRepoAdvisories(firstUrl: string): Promise<GhsaAdvisory[]> {
    const collected: GhsaAdvisory[] = [];
    let url: string | null = firstUrl;

    for (let page = 0; page < GHSA_MAX_PAGES && url !== null; page++) {
      const response: LinkedJson<GhsaAdvisory[]> = await fetchLinkedJson<GhsaAdvisory[]>(
        this.fetchImpl,
        url,
        this.headers(),
      );

      collected.push(...response.body);
      url = response.nextUrl;
    }

    return collected;
  }

  async fetchAdvisories(): Promise<SourceFetchResult> {
    const advisories: Advisory[] = [];
    const failures: string[] = [];

    for (const repo of GHSA_REPOS) {
      const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/security-advisories?per_page=${GHSA_PAGE_SIZE}`;

      try {
        for (const raw of await this.fetchRepoAdvisories(url)) {
          const advisory = toAdvisory(raw, repo.product, `${repo.owner}/${repo.repo}`);
          if (advisory) {
            advisories.push(advisory);
          }
        }
      } catch (error) {
        failures.push(
          `${repo.owner}/${repo.repo}: ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    if (failures.length === GHSA_REPOS.length) {
      throw new Error(`GHSA unreachable for every repo: ${failures.join('; ')}`);
    }

    return {
      source: this.id,
      advisories,
      recordCount: advisories.length,
      query: `github.com/repos/{${GHSA_REPOS.length} repos}/security-advisories`,
      fetchedAt: Date.now(),
      ...(failures.length > 0 ? { partialFailures: failures } : {}),
    };
  }
}
