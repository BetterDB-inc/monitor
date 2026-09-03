import type { Advisory, CveProduct } from '@betterdb/shared';
import {
  describeRejectedIds,
  fetchJson,
  partitionCveIds,
  type FetchLike,
  type MitreLikeSource,
  type SourceFetchResult,
} from './cve-source.interface';

interface MitreRecord {
  cveMetadata?: { cveId?: string };
  containers?: {
    cna?: {
      descriptions?: Array<{ lang: string; value: string }>;
      references?: Array<{ url: string }>;
      affected?: Array<{ product?: string; vendor?: string }>;
    };
  };
}

function productOf(record: MitreRecord, fallback: CveProduct): CveProduct {
  const named = record.containers?.cna?.affected?.[0]?.product?.toLowerCase() ?? '';

  if (named.includes('valkey')) {
    return 'valkey';
  }
  if (named.includes('redis')) {
    return 'redis';
  }

  return fallback;
}

export class MitreSource implements MitreLikeSource {
  readonly id = 'mitre' as const;

  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async fetchByIds(
    cveIds: string[],
    productHints: Partial<Record<string, CveProduct>> = {},
    budgetMs: number = Number.POSITIVE_INFINITY,
  ): Promise<SourceFetchResult> {
    const advisories: Advisory[] = [];
    const failures: string[] = [];
    const deadline = Date.now() + budgetMs;
    const { valid, rejected } = partitionCveIds(cveIds);

    if (rejected.length > 0) {
      failures.push(describeRejectedIds(rejected));
    }

    for (const cveId of valid) {
      if (Date.now() >= deadline) {
        failures.push(`${cveId}: skipped, mitre time budget exceeded`);
        continue;
      }

      try {
        const record = await fetchJson<MitreRecord>(
          this.fetchImpl,
          `https://cveawg.mitre.org/api/cve/${encodeURIComponent(cveId)}`,
        );
        const cna = record.containers?.cna;
        const description = cna?.descriptions?.find((entry) => {
          return entry.lang === 'en';
        });

        advisories.push({
          cveId: record.cveMetadata?.cveId ?? cveId,
          aliases: [],
          product: productOf(record, productHints[cveId] ?? 'redis'),
          affected: [],
          severity: 'medium',
          cwes: [],
          knownExploited: false,
          confidence: 'unversioned',
          sources: [{ source: 'mitre', fields: ['summary'] }],
          summary: description?.value ?? '',
          references: (cna?.references ?? []).map((reference) => {
            return reference.url;
          }),
        });
      } catch (error) {
        failures.push(`${cveId}: ${error instanceof Error ? error.message : error}`);
      }
    }

    return {
      source: this.id,
      advisories,
      recordCount: advisories.length,
      query: `cveawg.mitre.org/api/cve/{${cveIds.length} ids}`,
      fetchedAt: Date.now(),
      ...(failures.length > 0 ? { partialFailures: failures } : {}),
    };
  }
}
