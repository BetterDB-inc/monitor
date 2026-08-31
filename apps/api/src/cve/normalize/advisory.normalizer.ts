import { createHash } from 'crypto';
import type {
  Advisory,
  BranchRange,
  CveConfidence,
  CveProduct,
  CveSeverity,
  CveSourceId,
  EnrichmentEntry,
  SourceProvenance,
} from '@betterdb/shared';
import type { EnrichmentResult, SourceFetchResult } from '../sources/cve-source.interface';

export interface NormalizedDataset {
  advisories: Advisory[];
  datasetVersion: string;
}

const RANGE_PRECEDENCE: CveSourceId[] = ['ghsa', 'nvd', 'mitre'];

const DATASET_VERSION_LENGTH = 16;

interface SourceView {
  owner: CveSourceId;
  advisory: Advisory;
}

interface EnrichmentFact {
  entry: EnrichmentEntry;
  provenance: SourceProvenance[];
}

interface CanonicalRange {
  branch: string;
  vulnerableAtOrBelow: string;
  patchedAt: string | null;
}

interface CanonicalAdvisory {
  cveId: string;
  product: CveProduct;
  severity: CveSeverity;
  confidence: CveConfidence;
  knownExploited: boolean;
  cvssScore: number | null;
  affected: CanonicalRange[];
}

function compareStrings(a: string, b: string): number {
  if (a < b) {
    return -1;
  }

  if (a > b) {
    return 1;
  }

  return 0;
}

function rankOf(owner: CveSourceId): number {
  const index = RANGE_PRECEDENCE.indexOf(owner);
  if (index === -1) {
    return RANGE_PRECEDENCE.length;
  }

  return index;
}

function advisoryKey(cveId: string, product: CveProduct): string {
  return `${cveId}|${product}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function hasRanges(view: SourceView): boolean {
  return view.advisory.affected.length > 0;
}

function orderByPrecedence(views: SourceView[]): SourceView[] {
  return [...views].sort((a, b) => {
    const byRank = rankOf(a.owner) - rankOf(b.owner);
    if (byRank !== 0) {
      return byRank;
    }

    if (a.owner !== b.owner) {
      return compareStrings(a.owner, b.owner);
    }

    return compareStrings(a.advisory.product, b.advisory.product);
  });
}

function winnerFirst(ordered: SourceView[], winner: SourceView): SourceView[] {
  const rest = ordered.filter((view) => {
    return view !== winner;
  });

  return [winner, ...rest];
}

function groupViews(views: SourceView[]): SourceView[][] {
  const groups = new Map<string, SourceView[]>();
  const keysByCve = new Map<string, string[]>();

  function register(key: string, cveId: string, view: SourceView): void {
    const members = groups.get(key) ?? [];

    members.push(view);
    groups.set(key, members);

    const keys = keysByCve.get(cveId) ?? [];
    if (!keys.includes(key)) {
      keys.push(key);
      keysByCve.set(cveId, keys);
    }
  }

  for (const view of views) {
    if (hasRanges(view)) {
      register(advisoryKey(view.advisory.cveId, view.advisory.product), view.advisory.cveId, view);
    }
  }

  const rangeless = orderByPrecedence(
    views.filter((view) => {
      return !hasRanges(view);
    }),
  );

  for (const view of rangeless) {
    const keys = keysByCve.get(view.advisory.cveId) ?? [];

    if (keys.length === 0) {
      register(advisoryKey(view.advisory.cveId, view.advisory.product), view.advisory.cveId, view);
      continue;
    }

    for (const key of keys) {
      groups.get(key)?.push(view);
    }
  }

  return [...groups.values()];
}

function mergeProvenance(entries: SourceProvenance[]): SourceProvenance[] {
  const fieldsBySource = new Map<CveSourceId, string[]>();

  for (const entry of entries) {
    const fields = fieldsBySource.get(entry.source) ?? [];

    for (const field of entry.fields) {
      if (!fields.includes(field)) {
        fields.push(field);
      }
    }

    fieldsBySource.set(entry.source, fields);
  }

  return [...fieldsBySource.entries()].map((entry) => {
    return { source: entry[0], fields: entry[1] };
  });
}

function mergeGroup(views: SourceView[]): Advisory {
  const ordered = orderByPrecedence(views);
  const winner = ordered.find(hasRanges) ?? ordered[0];
  const preference = winnerFirst(ordered, winner);
  const scorer = preference.find((view) => {
    return view.advisory.cvssScore !== undefined;
  });
  const summarizer = preference.find((view) => {
    return view.advisory.summary.length > 0;
  });
  const credits: SourceProvenance[] = ordered.map((view) => {
    return { source: view.owner, fields: [] };
  });

  credits.push({ source: winner.owner, fields: ['severity'] });

  if (hasRanges(winner)) {
    credits.push({ source: winner.owner, fields: ['affected', 'confidence'] });
  }

  if (scorer) {
    credits.push({ source: scorer.owner, fields: ['cvssScore'] });
  }

  if (summarizer) {
    credits.push({ source: summarizer.owner, fields: ['summary'] });
  }

  for (const view of ordered) {
    if (view.advisory.knownExploited) {
      credits.push({ source: view.owner, fields: ['knownExploited'] });
    }

    if (view.advisory.aliases.length > 0) {
      credits.push({ source: view.owner, fields: ['aliases'] });
    }

    if (view.advisory.cwes.length > 0) {
      credits.push({ source: view.owner, fields: ['cwes'] });
    }

    if (view.advisory.references.length > 0) {
      credits.push({ source: view.owner, fields: ['references'] });
    }
  }

  return {
    cveId: winner.advisory.cveId,
    aliases: unique(
      ordered.flatMap((view) => {
        return view.advisory.aliases;
      }),
    ),
    product: winner.advisory.product,
    affected: winner.advisory.affected.map((range) => {
      return { ...range };
    }),
    severity: winner.advisory.severity,
    ...(scorer?.advisory.cvssScore !== undefined ? { cvssScore: scorer.advisory.cvssScore } : {}),
    cwes: unique(
      ordered.flatMap((view) => {
        return view.advisory.cwes;
      }),
    ),
    knownExploited: ordered.some((view) => {
      return view.advisory.knownExploited;
    }),
    confidence: hasRanges(winner) ? winner.advisory.confidence : 'unversioned',
    sources: mergeProvenance(credits),
    summary: summarizer?.advisory.summary ?? '',
    references: unique(
      ordered.flatMap((view) => {
        return view.advisory.references;
      }),
    ),
  };
}

function enrichmentFields(entry: EnrichmentEntry): string[] {
  const fields: string[] = [];

  if (entry.knownExploited !== undefined) {
    fields.push('knownExploited');
  }

  if (entry.epssScore !== undefined) {
    fields.push('epssScore');
  }

  if (entry.epssPercentile !== undefined) {
    fields.push('epssPercentile');
  }

  return fields;
}

function collectEnrichment(results: EnrichmentResult[]): Map<string, EnrichmentFact> {
  const facts = new Map<string, EnrichmentFact>();

  for (const result of results) {
    for (const [cveId, entry] of result.entries) {
      const fields = enrichmentFields(entry);
      if (fields.length === 0) {
        continue;
      }

      const current = facts.get(cveId) ?? { entry: {}, provenance: [] };

      facts.set(cveId, {
        entry: { ...current.entry, ...entry },
        provenance: [...current.provenance, { source: result.source, fields }],
      });
    }
  }

  return facts;
}

function applyEnrichment(advisory: Advisory, facts: Map<string, EnrichmentFact>): Advisory {
  const fact = facts.get(advisory.cveId);
  if (!fact) {
    return advisory;
  }

  return {
    ...advisory,
    knownExploited: fact.entry.knownExploited ?? advisory.knownExploited,
    ...(fact.entry.epssScore !== undefined ? { epssScore: fact.entry.epssScore } : {}),
    ...(fact.entry.epssPercentile !== undefined
      ? { epssPercentile: fact.entry.epssPercentile }
      : {}),
    sources: mergeProvenance([...advisory.sources, ...fact.provenance]),
  };
}

function canonicalRanges(ranges: BranchRange[]): CanonicalRange[] {
  return ranges
    .map((range) => {
      return {
        branch: range.branch,
        vulnerableAtOrBelow: range.vulnerableAtOrBelow,
        patchedAt: range.patchedAt ?? null,
      };
    })
    .sort((a, b) => {
      const byBranch = compareStrings(a.branch, b.branch);
      if (byBranch !== 0) {
        return byBranch;
      }

      const byBound = compareStrings(a.vulnerableAtOrBelow, b.vulnerableAtOrBelow);
      if (byBound !== 0) {
        return byBound;
      }

      return compareStrings(a.patchedAt ?? '', b.patchedAt ?? '');
    });
}

export function computeDatasetVersion(advisories: Advisory[]): string {
  const canonical: CanonicalAdvisory[] = advisories
    .map((advisory) => {
      return {
        cveId: advisory.cveId,
        product: advisory.product,
        severity: advisory.severity,
        confidence: advisory.confidence,
        knownExploited: advisory.knownExploited,
        cvssScore: advisory.cvssScore ?? null,
        affected: canonicalRanges(advisory.affected),
      };
    })
    .sort((a, b) => {
      return compareStrings(advisoryKey(a.cveId, a.product), advisoryKey(b.cveId, b.product));
    });

  return createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex')
    .slice(0, DATASET_VERSION_LENGTH);
}

export function normalizeAdvisories(
  results: SourceFetchResult[],
  enrichment: EnrichmentResult[],
): NormalizedDataset {
  const views: SourceView[] = results.flatMap((result) => {
    return result.advisories.map((advisory) => {
      return { owner: result.source, advisory };
    });
  });
  const facts = collectEnrichment(enrichment);
  const advisories = groupViews(views).map((group) => {
    return applyEnrichment(mergeGroup(group), facts);
  });

  return { advisories, datasetVersion: computeDatasetVersion(advisories) };
}
