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
  aliases: string[];
  cwes: string[];
  references: string[];
  sources: SourceProvenance[];
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

function orderByPrecedence(views: SourceView[]): SourceView[] {
  return [...views].sort((a, b) => {
    const byRank = rankOf(a.owner) - rankOf(b.owner);
    if (byRank !== 0) {
      return byRank;
    }

    return compareStrings(a.owner, b.owner);
  });
}

function winnerFirst(ordered: SourceView[], winner: SourceView): SourceView[] {
  const rest = ordered.filter((view) => {
    return view !== winner;
  });

  return [winner, ...rest];
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
  const withRanges = ordered.find((view) => {
    return view.advisory.affected.length > 0;
  });
  const winner = withRanges ?? ordered[0];
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

  if (winner.advisory.affected.length > 0) {
    credits.push({ source: winner.owner, fields: ['affected', 'confidence'] });
  }

  if (scorer) {
    credits.push({ source: scorer.owner, fields: ['cvssScore'] });
  }

  if (summarizer) {
    credits.push({ source: summarizer.owner, fields: ['summary'] });
  }

  for (const view of ordered) {
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
    affected: winner.advisory.affected,
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
    confidence: winner.advisory.affected.length > 0 ? winner.advisory.confidence : 'unversioned',
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

function canonicalStrings(values: string[]): string[] {
  return [...values].sort(compareStrings);
}

function canonicalSources(sources: SourceProvenance[]): SourceProvenance[] {
  return sources
    .map((entry) => {
      return { source: entry.source, fields: canonicalStrings(entry.fields) };
    })
    .sort((a, b) => {
      return compareStrings(a.source, b.source);
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
        aliases: canonicalStrings(advisory.aliases),
        cwes: canonicalStrings(advisory.cwes),
        references: canonicalStrings(advisory.references),
        sources: canonicalSources(advisory.sources),
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
  const groups = new Map<string, SourceView[]>();

  for (const result of results) {
    for (const advisory of result.advisories) {
      const key = advisoryKey(advisory.cveId, advisory.product);
      const views = groups.get(key) ?? [];

      views.push({ owner: result.source, advisory });
      groups.set(key, views);
    }
  }

  const facts = collectEnrichment(enrichment);
  const advisories = [...groups.values()].map((views) => {
    return applyEnrichment(mergeGroup(views), facts);
  });

  return { advisories, datasetVersion: computeDatasetVersion(advisories) };
}
