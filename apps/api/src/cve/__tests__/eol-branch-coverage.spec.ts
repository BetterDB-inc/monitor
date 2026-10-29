import { matchAdvisories } from '../matcher/advisory-matcher';
import { matchRanges } from '../matcher/version-range';
import { normalizeAdvisories } from '../normalize/advisory.normalizer';
import { GhsaSource } from '../sources/ghsa.source';
import { NvdSource } from '../sources/nvd.source';
import ghsaRedis from './fixtures/ghsa-redis.json';
import nvdRedis49844 from './fixtures/nvd-redis-49844.json';

type ProductId = 'redis' | 'valkey';

const REPO: Record<ProductId, string> = {
  redis: 'redis/redis',
  valkey: 'valkey-io/valkey',
};

const CPE: Record<ProductId, string> = {
  redis: 'cpe:2.3:a:redis:redis:*:*:*:*:*:*:*:*',
  valkey: 'cpe:2.3:a:lfprojects:valkey:*:*:*:*:*:*:*:*',
};

interface NvdMatch {
  start?: string;
  end: string;
}

function ghsaAdvisory(
  cveId: string,
  vulnerabilities: Array<{ range: string | null; patched: string | null }>,
  product: ProductId = 'redis',
  publishedAt = '2025-10-03T00:00:00Z',
) {
  return {
    ghsa_id: `GHSA-${cveId}`,
    cve_id: cveId,
    severity: 'critical',
    cvss: { score: 9 },
    cwe_ids: [],
    summary: 's',
    published_at: publishedAt,
    html_url: `https://github.com/${REPO[product]}/security/advisories/GHSA-${cveId}`,
    vulnerabilities: vulnerabilities.map((entry) => ({
      package: { ecosystem: '', name: REPO[product].split('/')[1] },
      vulnerable_version_range: entry.range,
      patched_versions: entry.patched,
    })),
  };
}

function nvdPayload(cveId: string, matches: NvdMatch[], product: ProductId = 'redis') {
  return {
    totalResults: 1,
    vulnerabilities: [
      {
        cve: {
          id: cveId,
          descriptions: [{ lang: 'en', value: 's' }],
          metrics: { cvssMetricV31: [{ cvssData: { baseScore: 9, baseSeverity: 'CRITICAL' } }] },
          configurations: [
            {
              nodes: [
                {
                  cpeMatch: matches.map((match) => ({
                    vulnerable: true,
                    criteria: CPE[product],
                    ...(match.start ? { versionStartIncluding: match.start } : {}),
                    versionEndExcluding: match.end,
                  })),
                },
              ],
            },
          ],
        },
      },
    ],
  };
}

async function dataset(ghsaBody: unknown[], nvdBody: unknown | null, product: ProductId = 'redis') {
  const ghsaFetch = jest.fn().mockImplementation(async (url: string) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => (url.includes(`/repos/${REPO[product]}/`) ? ghsaBody : []),
  }));
  const results = [await new GhsaSource(ghsaFetch).fetchAdvisories()];

  if (nvdBody !== null) {
    const nvdFetch = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => nvdBody });
    results.push(await new NvdSource(nvdFetch).fetchAdvisories());
  }

  return normalizeAdvisories(results, []).advisories.filter((a) => a.product === product);
}

type Dataset = Awaited<ReturnType<typeof dataset>>;

function findingFor(ds: Dataset, version: string, product: ProductId = 'redis') {
  return matchAdvisories({ product, engineVersion: version, modules: [] }, ds).findings[0];
}

function isVulnerable(ds: Dataset, version: string, product: ProductId = 'redis') {
  return findingFor(ds, version, product) !== undefined;
}

describe('CVE-2025-49844 (GHSA "All" + NVD fallback wildcard)', () => {
  const build = () => dataset(ghsaRedis, nvdRedis49844);

  it.each([
    ['5.0.14', '6.2.20'],
    ['6.0.20', '6.2.20'],
    ['7.0.15', '7.2.11'],
  ])('flags EOL %s as broad with fixedIn %s', async (version, fixedIn) => {
    const finding = findingFor(await build(), version);

    expect(finding).toBeDefined();
    expect(finding.confidence).toBe('broad');
    expect(finding.fixedIn).toBe(fixedIn);
  });

  it.each(['6.2.20', '7.2.11', '7.4.6', '8.0.4', '8.2.2', '8.4.0', '8.10.0', '9.0.0'])(
    'clears %s',
    async (version) => {
      expect(isVulnerable(await build(), version)).toBe(false);
    },
  );

  it('flags 7.2.10 as exact (vendor range on its own branch)', async () => {
    const finding = findingFor(await build(), '7.2.10');

    expect(finding).toBeDefined();
    expect(finding.confidence).toBe('exact');
  });

  it('applies the same rule to pre-release builds, with no special casing', async () => {
    const ds = await build();

    for (const version of ['7.9.227', '8.1.240', '8.3.224', '8.11.240']) {
      expect(isVulnerable(ds, version)).toBe(false);
    }
  });
});

describe('CVE-2023-45145 (rc1 floor)', () => {
  const build = () =>
    dataset(
      [
        ghsaAdvisory('CVE-2023-45145', [
          { range: '>= 2.6.0-rc1', patched: '7.2.2, 7.0.14, 6.2.14' },
        ]),
      ],
      nvdPayload('CVE-2023-45145', [{ start: '2.6.0', end: '6.2.14' }]),
    );

  it.each(['6.0.20', '5.0.14', '4.0.14'])('flags %s from NVD data (broad)', async (version) => {
    const finding = findingFor(await build(), version);

    expect(finding).toBeDefined();
    expect(finding.confidence).toBe('broad');
  });

  it.each(['6.2.14', '7.0.14', '7.2.2'])('clears %s', async (version) => {
    expect(isVulnerable(await build(), version)).toBe(false);
  });
});

describe('own-branch floor wins over a fallback', () => {
  const build = () =>
    dataset(
      [ghsaAdvisory('CVE-2099-0003', [{ range: 'All', patched: '6.2.20' }])],
      nvdPayload('CVE-2099-0003', [{ start: '7.0.8', end: '7.0.12' }, { end: '7.2.0' }]),
    );

  it('keeps 7.0.5 clean (below the NVD floor, but 7.0 has its own range)', async () => {
    expect(isVulnerable(await build(), '7.0.5')).toBe(false);
  });

  it('flags 7.0.9 as exact', async () => {
    const finding = findingFor(await build(), '7.0.9');

    expect(finding).toBeDefined();
    expect(finding.confidence).toBe('exact');
  });

  it('clears 7.0.12', async () => {
    expect(isVulnerable(await build(), '7.0.12')).toBe(false);
  });
});

describe('Valkey "<= 9.0.2" with patched TBD', () => {
  it('leaves 8.1.6 and 8.0.20 clean, matching master', async () => {
    const ds = await dataset(
      [ghsaAdvisory('CVE-2099-0004', [{ range: '<= 9.0.2', patched: 'TBD' }], 'valkey')],
      nvdPayload('CVE-2099-0004', [{ start: '8.1.0', end: '8.1.6' }], 'valkey'),
      'valkey',
    );

    expect(isVulnerable(ds, '8.1.6', 'valkey')).toBe(false);
    expect(isVulnerable(ds, '8.0.20', 'valkey')).toBe(false);
  });
});

describe('two-part patched tokens', () => {
  it('yield no GHSA ranges, so NVD ranges for those branches survive', async () => {
    const ds = await dataset(
      [ghsaAdvisory('CVE-2099-0005', [{ range: 'All', patched: '2.6, 2.8' }], 'valkey')],
      nvdPayload(
        'CVE-2099-0005',
        [
          { start: '2.6.0', end: '2.6.5' },
          { start: '2.8.0', end: '2.8.3' },
        ],
        'valkey',
      ),
      'valkey',
    );

    expect(isVulnerable(ds, '2.6.1', 'valkey')).toBe(true);
    expect(isVulnerable(ds, '2.8.2', 'valkey')).toBe(true);
    expect(isVulnerable(ds, '2.6.5', 'valkey')).toBe(false);
  });
});

describe('NVD-only advisory (unchanged vs master)', () => {
  it('flags 7.0.10 through the NVD wildcard with no fallback flag', async () => {
    const ds = await dataset(
      [],
      nvdPayload('CVE-2099-0006', [{ start: '7.0.0', end: '7.0.5' }, { end: '7.2.0' }]),
    );

    expect(isVulnerable(ds, '7.0.10')).toBe(true);
    expect(ds.flatMap((a) => a.affected).some((r) => r.fallback === true)).toBe(false);
    expect(matchRanges('7.0.10', ds[0].affected)).not.toHaveProperty('fallback');
  });
});

describe('GHSA with its own stated "*"', () => {
  it('drops the NVD "*", as on master', async () => {
    const ds = await dataset(
      [
        ghsaAdvisory('CVE-2099-0007', [
          { range: 'All', patched: '6.2.20' },
          { range: '<= 7.0.5', patched: null },
        ]),
      ],
      nvdPayload('CVE-2099-0007', [{ end: '7.2.0' }]),
    );
    const wildcards = ds.flatMap((a) => a.affected).filter((r) => r.branch === '*');

    expect(wildcards).toHaveLength(1);
    expect(wildcards[0].fallback).toBeUndefined();
    expect(isVulnerable(ds, '7.0.9')).toBe(false);
  });
});

describe('new branch after the last release', () => {
  it('clears 8.12.0 and 9.0.0 (no table, no guess)', async () => {
    const ds = await dataset(
      [
        ghsaAdvisory(
          'CVE-2099-0008',
          [{ range: 'All', patched: '8.10.3, 8.8.5' }],
          'redis',
          '2026-09-01T00:00:00Z',
        ),
      ],
      nvdPayload('CVE-2099-0008', [{ end: '8.8.5' }]),
    );

    expect(isVulnerable(ds, '8.12.0')).toBe(false);
    expect(isVulnerable(ds, '9.0.0')).toBe(false);
  });
});
