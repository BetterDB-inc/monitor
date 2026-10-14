import type {
  Advisory,
  BranchRange,
  CveConfidence,
  CveProduct,
  CveSeverity,
} from '@betterdb/shared';
import { GHSA_REPOS } from '../cve.constants';
import { branchOf, compareVersions } from '../matcher/version-range';
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
  vulnerabilities?: GhsaVulnerability[] | null;
}

const SEVERITIES: CveSeverity[] = ['low', 'medium', 'high', 'critical'];

const GHSA_PAGE_SIZE = 100;

const GHSA_MAX_PAGES = 10;

function toSeverity(raw: string): CveSeverity {
  const lowered = raw.toLowerCase();
  const known = SEVERITIES.find((severity) => {
    return severity === lowered;
  });

  return known ?? 'medium';
}

// One patched_versions token: "6.2.17", the two-part "6.2" (= 6.2.0), Redis's
// "6.2.X" placeholder, optionally with ">=" or "and above" / "or later" / "+".
const PATCHED_TOKEN_PATTERN =
  /^(?:>=\s*)?(\d+)\.(\d+)(?:\.(\d+|x))?(?:\s*\+|\s+(?:and|or)\s+(?:above|later|newer))?$/i;
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
   * False when any non-TBD token is not a concrete version ("6.2.X", prose).
   * The vendor named a fixed branch we can't place, so the unlisted-branch
   * inference can't be trusted for this advisory.
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
    if (!match) {
      // Unrecognized prose: keep any full version it names, but don't trust it.
      versions.push(...(token.match(THREE_PART_VERSION_PATTERN) ?? []));
      complete = false;
      continue;
    }

    if (match[3] !== undefined && /^x$/i.test(match[3])) {
      complete = false;
      continue;
    }

    versions.push(`${match[1]}.${match[2]}.${match[3] ?? '0'}`);
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
 * The first branch after the newest one that received a fix: "8.2.2" gives
 * "8.3.0". A branch cut after every listed fix carries that fix, so the
 * unlisted-branch wildcard stops there.
 */
function nextBranchFloor(versions: string[]): string {
  const newest = versions.reduce((highest, candidate) => {
    return compareVersions(candidate, highest) > 0 ? candidate : highest;
  });
  const [major, minor] = branchOf(newest).split('.').map(Number);

  return `${major}.${minor + 1}.0`;
}

/**
 * `patched_versions` only names the branches that received a fix. When the
 * vendor's affected range covers every version ("All", "All versions") or
 * has a floor but no ceiling (">= 7.0", "7.0 and newer"), a branch it
 * doesn't list that sits below the newest fixed branch is affected with no
 * fix available, typically EOL lines such as Redis 7.0.x.
 *
 * The wildcard is capped at the branch after the newest fix: Redis fixes
 * land upstream before the next branch is cut, so later branches (8.4.0 for
 * CVE-2025-49844) are not flagged. matchRanges() never lets the wildcard
 * override a fix published for the version's own branch.
 *
 * Nothing is inferred when:
 * - the range has any upper bound ("< 8.0.4", ">= 9.0.0, <= 9.0.2"): it is
 *   already branch-scoped;
 * - the range is missing or unparseable prose;
 * - there is no published fix ("TBD"): there is no ceiling, so it would flag
 *   every build forever. GHSA stays rangeless and NVD's range is used;
 * - a patched token can't be placed ("6.2.X"): the data is too ambiguous to
 *   trust the inference, so NVD's range is used, as before this fallback.
 */
function unlistedBranchFallback(
  rawRange: string | undefined,
  patched: ParsedPatched,
): BranchRange | null {
  if (patched.versions.length === 0 || !patched.complete) {
    return null;
  }

  const range = normalizeRange(rawRange ?? '');
  const vulnerableBelow = nextBranchFloor(patched.versions);

  // A missing range is unknown, not "all versions": only an explicit marker counts.
  if (ALL_VERSIONS_PATTERN.test(range)) {
    return { branch: '*', vulnerableFrom: '0.0.0', vulnerableBelow };
  }

  const upperBounds = range.match(ANY_UPPER_BOUND_PATTERN) ?? [];
  const lower = lowerBoundOf(range);
  if (lower !== null && upperBounds.length === 0 && !AND_BELOW_PATTERN.test(range)) {
    return { branch: '*', vulnerableFrom: lower, vulnerableBelow };
  }

  return null;
}

function toAffectedRanges(vulnerabilities: GhsaVulnerability[], repo: string): AffectedRanges {
  const exact: BranchRange[] = [];
  const unpatched: BranchRange[] = [];
  // Valkey advisories enumerate every affected branch, so there is never an
  // unlisted branch to infer.
  const allowWildcard = !repo.startsWith('valkey-io/');

  for (const vulnerability of vulnerabilities) {
    const patchedRaw = vulnerability.patched_versions?.trim() ?? '';
    const patchedVersions = NO_FIX_PATTERN.test(patchedRaw) ? '' : patchedRaw;
    const rawRange = vulnerability.vulnerable_version_range?.trim();
    const patched = parsePatchedVersions(patchedVersions);

    if (patched.versions.length > 0) {
      exact.push(
        ...exactRangesFromPatchedVersions(patched.versions, normalizeRange(rawRange ?? '')),
      );
      const fallback = allowWildcard ? unlistedBranchFallback(rawRange, patched) : null;
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

  const { affected, confidence } = toAffectedRanges(raw.vulnerabilities ?? [], repo);

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
