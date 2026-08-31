import type { EnrichmentEntry } from '@betterdb/shared';
import {
  fetchJson,
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

    for (let index = 0; index < cveIds.length; index += EPSS_BATCH_SIZE) {
      const batch = cveIds.slice(index, index + EPSS_BATCH_SIZE);
      const url = `https://api.first.org/data/v1/epss?cve=${batch.join(',')}`;
      const payload = await fetchJson<EpssResponse>(this.fetchImpl, url);

      if (payload.total === 0 && batch.length > 0) {
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
