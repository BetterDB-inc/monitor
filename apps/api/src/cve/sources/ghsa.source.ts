import type {
  Advisory,
  BranchRange,
  CveConfidence,
  CveProduct,
  CveSeverity,
} from '@betterdb/shared';
import { GHSA_REPOS } from '../cve.constants';
import { branchOf } from '../matcher/version-range';
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

const VERSION_PATTERN = /\d+\.\d+\.\d+/g;
const VER = String.raw`\d+\.\d+(?:\.\d+)?`;
// ">= 7.2", ">= 7.2.0", "7.0 or newer", "7.0 and later".
const LOWER_BOUND_PATTERN = new RegExp(
  String.raw`(?:>=\s*(${VER}))|(?:(${VER})\s+(?:or|and)\s+(?:newer|later|above))`,
  'i',
);
// Empty, "TBD", "none", "n/a" or "-": the vendor has not published a fix.
const NO_FIX_PATTERN = /^\s*(tbd|none|n\/a|-)?\s*$/i;
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

function exactRangesFromPatchedVersions(
  patchedVersions: string,
  vulnerableVersionRange: string | undefined,
): BranchRange[] {
  const versions = patchedVersions.match(VERSION_PATTERN) ?? [];
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
 * `patched_versions` only names the branches that received a fix. When the
 * vendor's affected range covers every version ("All", "All versions") or
 * has a floor but no ceiling (">= 7.0", "7.0 and newer"), every branch it
 * doesn't list is affected with no fix available, typically EOL lines such
 * as Redis 7.0.x. Emit one unbounded wildcard for those branches.
 * matchRanges() never lets a wildcard override a fix published for the
 * version's own branch.
 *
 * Any upper bound ("< 8.0.4", ">= 9.0.0, <= 9.0.2") means the range is
 * already branch-scoped, so nothing is inferred; unparseable prose never
 * guesses a range.
 */
function unlistedBranchFallback(rawRange: string | undefined): BranchRange | null {
  const range = normalizeRange(rawRange ?? '');

  // A missing range is unknown, not "all versions": only an explicit marker counts.
  if (ALL_VERSIONS_PATTERN.test(range)) {
    return { branch: '*', vulnerableFrom: '0.0.0' };
  }

  const upperBounds = range.match(ANY_UPPER_BOUND_PATTERN) ?? [];
  const lower = lowerBoundOf(range);
  if (lower !== null && upperBounds.length === 0 && !AND_BELOW_PATTERN.test(range)) {
    return { branch: '*', vulnerableFrom: lower };
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
    const fallback = allowWildcard ? unlistedBranchFallback(rawRange) : null;

    if (patchedVersions) {
      exact.push(
        ...exactRangesFromPatchedVersions(patchedVersions, normalizeRange(rawRange ?? '')),
      );
      if (fallback) {
        exact.push(fallback);
      }
      continue;
    }

    if (fallback) {
      unpatched.push(fallback);
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
