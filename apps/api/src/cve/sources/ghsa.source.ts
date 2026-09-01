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
const LOWER_BOUND_PATTERN = /(?:^|,)\s*>=\s*(\d+\.\d+\.\d+)/;
const AT_OR_BELOW_PATTERN = /(?:^|,)\s*<=\s*(\d+\.\d+\.\d+)/;
const BELOW_PATTERN = /(?:^|,)\s*<\s*(\d+\.\d+\.\d+)/;

function lowerBoundFor(vulnerableVersionRange: string | undefined, branch: string): string | null {
  if (vulnerableVersionRange === undefined) {
    return null;
  }

  const match = vulnerableVersionRange.match(LOWER_BOUND_PATTERN);
  if (!match) {
    return null;
  }

  if (branchOf(match[1]) !== branch) {
    return null;
  }

  return match[1];
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
  const lower = vulnerableVersionRange.match(LOWER_BOUND_PATTERN);

  if (!lower) {
    return { branch: '*', ...upper };
  }

  const branch = branchOf(lower[1]);

  if (branch !== branchOf(ceiling)) {
    return { branch: '*', ...upper, vulnerableFrom: lower[1] };
  }

  return { branch, ...upper, vulnerableFrom: lower[1] };
}

interface AffectedRanges {
  affected: BranchRange[];
  confidence: CveConfidence;
}

function toAffectedRanges(vulnerabilities: GhsaVulnerability[]): AffectedRanges {
  const exact: BranchRange[] = [];
  const unpatched: BranchRange[] = [];

  for (const vulnerability of vulnerabilities) {
    const patchedVersions = vulnerability.patched_versions?.trim();
    const vulnerableVersionRange = vulnerability.vulnerable_version_range?.trim();

    if (patchedVersions) {
      exact.push(...exactRangesFromPatchedVersions(patchedVersions, vulnerableVersionRange));
      continue;
    }

    if (vulnerableVersionRange === undefined || vulnerableVersionRange.length === 0) {
      continue;
    }

    const range = unpatchedRangeFrom(vulnerableVersionRange);
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

function toAdvisory(raw: GhsaAdvisory, product: CveProduct): Advisory | null {
  if (!raw.cve_id) {
    return null;
  }

  const { affected, confidence } = toAffectedRanges(raw.vulnerabilities ?? []);

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
          const advisory = toAdvisory(raw, repo.product);
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
