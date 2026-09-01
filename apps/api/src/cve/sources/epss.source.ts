import type { EnrichmentEntry } from '@betterdb/shared';
import {
  describeRejectedIds,
  fetchJson,
  partitionCveIds,
  type EnrichmentResult,
  type EnrichmentSource,
  type FetchLike,
} from './cve-source.interface';

const EPSS_BATCH_SIZE = 100;

interface EpssResponse {
  total?: number;
  data?: Array<{ cve: string; epss: string; percentile: string }>;
}

function round(raw: string): number {
  return Number(Number(raw).toFixed(4));
}

export class EpssSource implements EnrichmentSource {
  readonly id = 'epss' as const;

  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async enrich(cveIds: string[]): Promise<EnrichmentResult> {
    const entries: Array<[string, EnrichmentEntry]> = [];
    const partialFailures: string[] = [];
    const { valid, rejected } = partitionCveIds(cveIds);

    if (rejected.length > 0) {
      partialFailures.push(describeRejectedIds(rejected));
    }

    for (let index = 0; index < valid.length; index += EPSS_BATCH_SIZE) {
      const batch = valid.slice(index, index + EPSS_BATCH_SIZE);
      const query = batch
        .map((cveId) => {
          return encodeURIComponent(cveId);
        })
        .join(',');
      const url = `https://api.first.org/data/v1/epss?cve=${query}`;

      let payload: EpssResponse;
      try {
        payload = await fetchJson<EpssResponse>(this.fetchImpl, url);
      } catch (error) {
        partialFailures.push(
          `batch of ${batch.length} CVEs failed: ${error instanceof Error ? error.message : error}`,
        );
        continue;
      }

      if (payload.total === 0) {
        partialFailures.push(`batch of ${batch.length} CVEs reported zero total`);
        continue;
      }

      for (const row of payload.data ?? []) {
        entries.push([
          row.cve,
          { epssScore: round(row.epss), epssPercentile: round(row.percentile) },
        ]);
      }
    }

    return {
      source: this.id,
      entries,
      recordCount: entries.length,
      query: 'api.first.org/data/v1/epss',
      fetchedAt: Date.now(),
      ...(partialFailures.length > 0 ? { partialFailures } : {}),
    };
  }
}
