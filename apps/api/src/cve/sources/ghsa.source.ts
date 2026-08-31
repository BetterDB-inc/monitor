import type { Advisory, BranchRange, CveProduct, CveSeverity } from '@betterdb/shared';
import { GHSA_REPOS } from '../cve.constants';
import { branchOf } from '../matcher/version-range';
import {
  fetchJson,
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

function toSeverity(raw: string): CveSeverity {
  const lowered = raw.toLowerCase();
  const known = SEVERITIES.find((severity) => {
    return severity === lowered;
  });

  return known ?? 'medium';
}

function toRange(vulnerability: GhsaVulnerability): BranchRange | null {
  const raw = vulnerability.vulnerable_version_range?.trim();
  if (!raw) {
    return null;
  }

  const upper = raw.replace(/^<=?\s*/, '').trim();
  if (upper.length === 0) {
    return null;
  }

  const patched = vulnerability.patched_versions?.trim();

  return {
    branch: branchOf(upper),
    vulnerableAtOrBelow: upper,
    ...(patched ? { patchedAt: patched } : {}),
  };
}

function toAdvisory(raw: GhsaAdvisory, product: CveProduct): Advisory | null {
  if (!raw.cve_id) {
    return null;
  }

  const affected = (raw.vulnerabilities ?? [])
    .map(toRange)
    .filter((range): range is BranchRange => {
      return range !== null;
    });

  return {
    cveId: raw.cve_id,
    aliases: [raw.ghsa_id],
    product,
    affected,
    severity: toSeverity(raw.severity),
    ...(typeof raw.cvss?.score === 'number' ? { cvssScore: raw.cvss.score } : {}),
    cwes: raw.cwe_ids ?? [],
    knownExploited: false,
    confidence: affected.length > 0 ? 'exact' : 'unversioned',
    sources: [{ source: 'ghsa', fields: ['affected', 'severity', 'cvssScore', 'summary'] }],
    summary: raw.summary,
    references: [raw.html_url],
  };
}

export class GhsaSource implements CveSource {
  readonly id = 'ghsa' as const;

  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async fetchAdvisories(): Promise<SourceFetchResult> {
    const advisories: Advisory[] = [];
    const failures: string[] = [];

    for (const repo of GHSA_REPOS) {
      const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/security-advisories`;

      try {
        const payload = await fetchJson<GhsaAdvisory[]>(this.fetchImpl, url, {
          accept: 'application/vnd.github+json',
        });

        for (const raw of payload) {
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
    };
  }
}
