import type { Advisory, BranchRange, CveProduct, CveSeverity } from '@betterdb/shared';
import { NVD_CPES } from '../cve.constants';
import { branchOf, compareVersions } from '../matcher/version-range';
import {
  fetchJson,
  type CveSource,
  type FetchLike,
  type SourceFetchResult,
} from './cve-source.interface';

interface NvdCpeMatch {
  criteria: string;
  vulnerable: boolean;
  versionStartIncluding?: string;
  versionEndExcluding?: string;
  versionEndIncluding?: string;
}

interface NvdNode {
  cpeMatch?: NvdCpeMatch[];
}

interface NvdCve {
  id: string;
  descriptions?: Array<{ lang: string; value: string }>;
  metrics?: {
    cvssMetricV31?: Array<{ cvssData: { baseScore: number; baseSeverity: string } }>;
  };
  weaknesses?: Array<{ description: Array<{ value: string }> }>;
  references?: Array<{ url: string }>;
  configurations?: Array<{ nodes: NvdNode[] }>;
}

interface NvdResponse {
  totalResults: number;
  vulnerabilities: Array<{ cve: NvdCve }>;
}

const SEVERITIES: CveSeverity[] = ['low', 'medium', 'high', 'critical'];

function toSeverity(raw: string | undefined): CveSeverity {
  const lowered = (raw ?? '').toLowerCase();
  const known = SEVERITIES.find((severity) => {
    return severity === lowered;
  });

  return known ?? 'medium';
}

function decrementPatch(version: string): string | null {
  const parts = version.split('.');
  if (parts.length !== 3) {
    return null;
  }

  const [major, minor, patch] = parts.map((part) => {
    return parseInt(part, 10);
  });

  if (!Number.isInteger(patch) || patch <= 0) {
    return null;
  }

  return `${major}.${minor}.${patch - 1}`;
}

function upperBoundOf(match: NvdCpeMatch): { raw: string; inclusive: boolean } | null {
  if (match.versionEndExcluding) {
    return { raw: match.versionEndExcluding, inclusive: false };
  }
  if (match.versionEndIncluding) {
    return { raw: match.versionEndIncluding, inclusive: true };
  }

  return null;
}

function branchFor(match: NvdCpeMatch, upperBoundRaw: string): string {
  if (!match.versionStartIncluding) {
    return '*';
  }

  const startBranch = branchOf(match.versionStartIncluding);
  if (startBranch !== branchOf(upperBoundRaw)) {
    return '*';
  }

  return startBranch;
}

function toRange(match: NvdCpeMatch): BranchRange | null {
  const upperBound = upperBoundOf(match);
  if (!upperBound) {
    return null;
  }

  const branch = branchFor(match, upperBound.raw);
  const vulnerableAtOrBelow = upperBound.inclusive
    ? upperBound.raw
    : (decrementPatch(upperBound.raw) ?? upperBound.raw);

  return { branch, vulnerableAtOrBelow };
}

function collapseByBranch(ranges: BranchRange[]): BranchRange[] {
  const highestByBranch = new Map<string, BranchRange>();

  for (const range of ranges) {
    const current = highestByBranch.get(range.branch);
    if (!current || compareVersions(range.vulnerableAtOrBelow, current.vulnerableAtOrBelow) > 0) {
      highestByBranch.set(range.branch, range);
    }
  }

  return Array.from(highestByBranch.values());
}

function toRanges(cve: NvdCve, cpePrefix: string): BranchRange[] {
  const ranges: BranchRange[] = [];

  for (const configuration of cve.configurations ?? []) {
    for (const node of configuration.nodes) {
      for (const match of node.cpeMatch ?? []) {
        if (!match.vulnerable || !match.criteria.startsWith(cpePrefix)) {
          continue;
        }

        const range = toRange(match);
        if (range) {
          ranges.push(range);
        }
      }
    }
  }

  return collapseByBranch(ranges);
}

function toAdvisory(cve: NvdCve, product: CveProduct, cpePrefix: string): Advisory {
  const affected = toRanges(cve, cpePrefix);
  const metric = cve.metrics?.cvssMetricV31?.[0]?.cvssData;
  const description = cve.descriptions?.find((entry) => {
    return entry.lang === 'en';
  });

  return {
    cveId: cve.id,
    aliases: [],
    product,
    affected,
    severity: toSeverity(metric?.baseSeverity),
    ...(typeof metric?.baseScore === 'number' ? { cvssScore: metric.baseScore } : {}),
    cwes: (cve.weaknesses ?? []).flatMap((weakness) => {
      return weakness.description.map((entry) => {
        return entry.value;
      });
    }),
    knownExploited: false,
    confidence: affected.length > 0 ? 'broad' : 'unversioned',
    sources: [{ source: 'nvd', fields: ['affected', 'severity', 'cvssScore', 'summary'] }],
    summary: description?.value ?? '',
    references: (cve.references ?? []).map((reference) => {
      return reference.url;
    }),
  };
}

export class NvdSource implements CveSource {
  readonly id = 'nvd' as const;

  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async fetchAdvisories(): Promise<SourceFetchResult> {
    const advisories: Advisory[] = [];

    for (const entry of NVD_CPES) {
      const url =
        'https://services.nvd.nist.gov/rest/json/cves/2.0' +
        `?virtualMatchString=${entry.cpe}&resultsPerPage=200`;
      const payload = await fetchJson<NvdResponse>(this.fetchImpl, url);

      for (const item of payload.vulnerabilities ?? []) {
        advisories.push(toAdvisory(item.cve, entry.product, entry.cpe));
      }
    }

    return {
      source: this.id,
      advisories,
      recordCount: advisories.length,
      query: NVD_CPES.map((entry) => {
        return entry.cpe;
      }).join(', '),
      fetchedAt: Date.now(),
    };
  }
}
