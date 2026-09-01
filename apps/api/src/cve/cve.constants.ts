import type { CveProduct } from '@betterdb/shared';

export const CVE_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

export const CVE_SCAN_INTERVAL_MS = 6 * 60 * 60 * 1000;

export const CVE_SCAN_RETRY_INTERVAL_MS = 60 * 1000;

export const CVE_SOURCES = 'CVE_SOURCES';
export const CVE_ENRICHMENT_SOURCES = 'CVE_ENRICHMENT_SOURCES';
export const CVE_MITRE_SOURCE = 'CVE_MITRE_SOURCE';

export const CVE_REFRESH_DEADLINE_MS = 5 * 60 * 1000;

export const CVE_MITRE_TIME_BUDGET_MS = 90 * 1000;

export function isCveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CVE_ENABLED !== undefined) {
    return env.CVE_ENABLED !== 'false';
  }

  return env.NODE_ENV !== 'test';
}

export const GHSA_REPOS: Array<{ owner: string; repo: string; product: CveProduct }> = [
  { owner: 'redis', repo: 'redis', product: 'redis' },
  { owner: 'valkey-io', repo: 'valkey', product: 'valkey' },
  { owner: 'valkey-io', repo: 'valkey-bloom', product: 'valkey-bloom' },
  { owner: 'valkey-io', repo: 'valkey-json', product: 'valkey-json' },
  { owner: 'valkey-io', repo: 'valkey-search', product: 'valkey-search' },
  { owner: 'RediSearch', repo: 'RediSearch', product: 'redisearch' },
];

export const NVD_CPES: Array<{ cpe: string; product: CveProduct }> = [
  { cpe: 'cpe:2.3:a:redis:redis', product: 'redis' },
  { cpe: 'cpe:2.3:a:lfprojects:valkey', product: 'valkey' },
  { cpe: 'cpe:2.3:a:lfprojects:valkey-bloom', product: 'valkey-bloom' },
];

export const MODULE_PRODUCTS: Partial<Record<CveProduct, Record<string, CveProduct>>> = {
  valkey: {
    bf: 'valkey-bloom',
    json: 'valkey-json',
    search: 'valkey-search',
  },
  redis: {
    search: 'redisearch',
    searchlight: 'redisearch',
  },
};

export type ModuleVersionEncoding = 'decimal' | 'byte-triplet' | 'byte-quad-stage';

export const MODULE_VERSION_ENCODINGS: Partial<
  Record<CveProduct, Record<string, ModuleVersionEncoding>>
> = {
  valkey: {
    bf: 'decimal',
    json: 'decimal',
    ldap: 'byte-quad-stage',
    search: 'byte-triplet',
  },
  redis: {
    bf: 'decimal',
    rejson: 'decimal',
    search: 'decimal',
    searchlight: 'decimal',
    timeseries: 'decimal',
  },
};
