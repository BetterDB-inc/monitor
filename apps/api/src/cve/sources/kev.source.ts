import type { EnrichmentEntry } from '@betterdb/shared';
import {
  fetchJson,
  type EnrichmentResult,
  type EnrichmentSource,
  type FetchLike,
} from './cve-source.interface';

const KEV_URL =
  'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';

const KEV_MIN_CATALOGUE_SIZE = 500;

interface KevResponse {
  vulnerabilities?: Array<{ cveID: string }>;
}

export class KevSource implements EnrichmentSource {
  readonly id = 'kev' as const;

  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async enrich(cveIds: string[]): Promise<EnrichmentResult> {
    const payload = await fetchJson<KevResponse>(this.fetchImpl, KEV_URL);
    const catalogue = new Set(
      (payload.vulnerabilities ?? []).map((entry) => {
        return entry.cveID;
      }),
    );

    if (catalogue.size < KEV_MIN_CATALOGUE_SIZE) {
      return {
        source: this.id,
        entries: [],
        recordCount: 0,
        query: KEV_URL,
        fetchedAt: Date.now(),
        partialFailures: [
          `catalogue of ${catalogue.size} entries is below the ${KEV_MIN_CATALOGUE_SIZE} sanity floor`,
        ],
      };
    }

    const entries: Array<[string, EnrichmentEntry]> = [];

    for (const cveId of cveIds) {
      if (catalogue.has(cveId)) {
        entries.push([cveId, { knownExploited: true }]);
      }
    }

    return {
      source: this.id,
      entries,
      recordCount: entries.length,
      query: KEV_URL,
      fetchedAt: Date.now(),
    };
  }
}
