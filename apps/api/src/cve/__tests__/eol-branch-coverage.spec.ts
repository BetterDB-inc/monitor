import type { Advisory, BranchRange } from '@betterdb/shared';
import { matchAdvisories } from '../matcher/advisory-matcher';
import { matchRanges } from '../matcher/version-range';
import { normalizeAdvisories } from '../normalize/advisory.normalizer';
import { GhsaSource } from '../sources/ghsa.source';
import ghsaRedis from './fixtures/ghsa-redis.json';

function fetchStub(body: unknown): jest.Mock {
  return jest.fn().mockImplementation(async (url: string) => {
    const payload = url.includes('/repos/redis/redis/') ? body : [];
    return { ok: true, status: 200, json: async () => payload, headers: { get: () => null } };
  });
}

async function redisDataset() {
  const ghsa = await new GhsaSource(fetchStub(ghsaRedis)).fetchAdvisories();
  return normalizeAdvisories([ghsa], []).advisories.filter((a) => a.product === 'redis');
}

type Dataset = Awaited<ReturnType<typeof redisDataset>>;

function isVulnerableFor(advisories: Dataset, product: 'redis' | 'valkey', version: string) {
  return (
    matchAdvisories({ product, engineVersion: version, modules: [] }, advisories).findings.length >
    0
  );
}

function isVulnerable(advisories: Dataset, version: string) {
  return isVulnerableFor(advisories, 'redis', version);
}

describe('CVE-2025-49844 (affected "All", patched on five branches)', () => {
  it.each(['5.0.14', '6.0.20', '7.0.15'])(
    'flags %s on an EOL branch the vendor never patched',
    async (version) => {
      expect(isVulnerable(await redisDataset(), version)).toBe(true);
    },
  );

  it.each(['6.2.19', '7.2.10', '7.4.5', '8.0.3', '8.2.1'])(
    'still flags %s below the fix on its own branch',
    async (version) => {
      expect(isVulnerable(await redisDataset(), version)).toBe(true);
    },
  );

  it.each(['6.2.20', '7.2.11', '7.4.6', '8.0.4', '8.2.2', '8.4.0'])(
    'clears %s (patched on its branch, or a newer branch)',
    async (version) => {
      expect(isVulnerable(await redisDataset(), version)).toBe(false);
    },
  );
});

describe('matchRanges wildcard precedence', () => {
  const ranges: BranchRange[] = [
    { branch: '7.2', vulnerableBelow: '7.2.11', patchedAt: '7.2.11' },
    { branch: '*', vulnerableBelow: '8.2.2' },
  ];

  it('never lets a wildcard re-flag a version past its own branch fix', () => {
    expect(matchRanges('7.2.11', ranges).vulnerable).toBe(false);
  });

  it('applies the wildcard to a branch with no range of its own', () => {
    expect(matchRanges('7.0.15', ranges).vulnerable).toBe(true);
  });

  it('lets the wildcard apply past an on-branch upper bound that has no published fix', () => {
    const unfixed: BranchRange[] = [
      { branch: '7.2', vulnerableBelow: '7.2.5' },
      { branch: '*', vulnerableBelow: '7.2.10' },
    ];

    expect(matchRanges('7.2.6', unfixed).vulnerable).toBe(true);
  });
});

describe('GHSA unlisted-branch fallback with no vulnerable_version_range', () => {
  const advisory = {
    ghsa_id: 'GHSA-null-range',
    cve_id: 'CVE-2099-0001',
    severity: 'high',
    cvss: { score: 7.5 },
    cwe_ids: [],
    summary: 'synthetic advisory with a missing affected range',
    html_url: 'https://github.com/redis/redis/security/advisories/GHSA-null-range',
    vulnerabilities: [
      {
        package: { ecosystem: '', name: 'redis' },
        vulnerable_version_range: null,
        patched_versions: '7.2.11',
      },
    ],
  };

  async function dataset() {
    const ghsa = await new GhsaSource(fetchStub([advisory])).fetchAdvisories();
    return normalizeAdvisories([ghsa], []).advisories.filter((a) => a.product === 'redis');
  }

  it('does not treat a missing range as "all versions"', async () => {
    const advisories = await dataset();

    expect(advisories.flatMap((a) => a.affected).some((r) => r.branch === '*')).toBe(false);
    expect(isVulnerable(advisories, '7.0.15')).toBe(false);
  });
});

const adv = (range: string | null, patched: string, repo = 'redis/redis', id = 'GHSA-x') => ({
  ghsa_id: id,
  cve_id: 'CVE-2099-0002',
  severity: 'critical',
  cvss: { score: 9 },
  cwe_ids: [],
  summary: 's',
  html_url: `https://github.com/${repo}/security/advisories/${id}`,
  vulnerabilities: [
    {
      package: { ecosystem: '', name: repo.split('/')[1] },
      vulnerable_version_range: range,
      patched_versions: patched,
    },
  ],
});

async function datasetFor(advisories: unknown[], repo = 'redis/redis', product = 'redis') {
  const fetch = jest.fn().mockImplementation(async (url: string) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => (url.includes(`/repos/${repo}/`) ? advisories : []),
  }));
  const ghsa = await new GhsaSource(fetch).fetchAdvisories();
  return normalizeAdvisories([ghsa], []).advisories.filter((a) => a.product === product);
}

async function datasetWithNvd(advisories: unknown[], nvdRange: BranchRange) {
  const fetch = jest.fn().mockImplementation(async (url: string) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => (url.includes('/repos/redis/redis/') ? advisories : []),
  }));
  const ghsa = await new GhsaSource(fetch).fetchAdvisories();
  const nvdAdvisory: Advisory = {
    cveId: 'CVE-2099-0002',
    aliases: [],
    product: 'redis',
    affected: [nvdRange],
    severity: 'critical',
    cwes: [],
    knownExploited: false,
    confidence: 'exact',
    sources: [{ source: 'nvd', fields: ['affected'] }],
    summary: 's',
    references: [],
  };
  const nvd = { ...ghsa, source: 'nvd' as const, advisories: [nvdAdvisory], recordCount: 1 };
  return normalizeAdvisories([ghsa, nvd], []).advisories.filter((a) => a.product === 'redis');
}

describe('GHSA unlisted-branch wildcard rules', () => {
  it('(a) bare single upper bound does not flag other branches', async () => {
    const ds = await datasetFor([adv('< 8.0.4', '8.0.4')]);
    for (const v of ['7.4.6', '7.2.11', '6.2.20', '6.0.20', '5.0.14']) {
      expect(isVulnerable(ds, v)).toBe(false);
    }
    expect(isVulnerable(ds, '8.0.3')).toBe(true);
  });

  it('(a) bounded ">= x, <= y" range does not flag other branches', async () => {
    const ds = await datasetFor([adv('>= 7.2.0, <= 7.2.10', '7.2.11')]);
    for (const v of ['7.0.15', '7.4.0', '8.0.0']) {
      expect(isVulnerable(ds, v)).toBe(false);
    }
    expect(isVulnerable(ds, '7.2.10')).toBe(true);
  });

  it('(b) "All" flags unlisted branches up to the newest fixed branch, not past it', async () => {
    const ds = await datasetFor([adv('All', '6.2.20, 7.2.11')]);
    for (const v of ['5.0.14', '6.0.20', '7.0.15', '6.2.19', '7.2.10']) {
      expect(isVulnerable(ds, v)).toBe(true);
    }
    // A branch cut after the newest fix carries it.
    for (const v of ['6.2.20', '7.2.11', '7.4.0', '8.0.0']) {
      expect(isVulnerable(ds, v)).toBe(false);
    }
  });

  it.each(['All versions', 'all', '>= 2.8', '2.8 or newer', '7.0 and newer', '=> 7.0'])(
    'parses vendor phrasing %s',
    async (range) => {
      const ds = await datasetFor([adv(range, '7.2.11')]);
      expect(isVulnerable(ds, '7.0.15')).toBe(true);
      expect(isVulnerable(ds, '7.2.11')).toBe(false);
    },
  );

  it('emits no wildcard for "All" + TBD, so builds are not flagged forever (CVE-2025-46817 shape)', async () => {
    const ds = await datasetFor([adv('All', 'TBD')]);
    expect(ds.flatMap((a) => a.affected)).toEqual([]);
    expect(ds[0]?.confidence).toBe('unversioned');
    for (const v of ['7.2.11', '8.2.3', '8.4.0']) {
      expect(isVulnerable(ds, v)).toBe(false);
    }
  });

  it('lets NVD win for "All" + TBD', async () => {
    const ds = await datasetWithNvd([adv('All', 'TBD')], {
      branch: '*',
      vulnerableBelow: '7.2.8',
    });
    expect(isVulnerable(ds, '7.2.7')).toBe(true);
    expect(isVulnerable(ds, '8.2.3')).toBe(false);
  });

  it('ignores a TBD token mixed with real patched versions', async () => {
    const ds = await datasetFor([adv('All', '7.2.11, TBD')]);
    expect(isVulnerable(ds, '7.2.11')).toBe(false);
    expect(isVulnerable(ds, '7.0.15')).toBe(true);
  });

  it('Valkey "=>9.0.0, <= 9.0.2" does not flag patched older branches', async () => {
    const ds = await datasetFor(
      [adv('=>9.0.0, <= 9.0.2', '9.0.3', 'valkey-io/valkey')],
      'valkey-io/valkey',
      'valkey',
    );
    for (const v of ['7.2.14', '8.0.11', '8.1.10']) {
      expect(isVulnerableFor(ds, 'valkey', v)).toBe(false);
    }
    expect(isVulnerableFor(ds, 'valkey', '9.0.2')).toBe(true);
  });

  it('Valkey with no published fix still never gets a wildcard', async () => {
    const ds = await datasetFor([adv('All', 'TBD', 'valkey-io/valkey')], 'valkey-io/valkey', 'valkey');
    expect(ds.flatMap((a) => a.affected).some((r) => r.branch === '*')).toBe(false);
  });

  it('does not trust patched "X" placeholders (CVE-2024-46981 shape)', async () => {
    const ds = await datasetFor([adv('All', '6.2.X, 7.2.X, 7.4.X')]);
    expect(ds.flatMap((a) => a.affected).some((r) => r.branch === '*')).toBe(false);
    for (const v of ['6.2.17', '7.2.7', '7.4.2', '8.0.3', '8.2.2']) {
      expect(isVulnerable(ds, v)).toBe(false);
    }
  });

  it('falls back to NVD when every patched token is an "X" placeholder', async () => {
    const ds = await datasetWithNvd([adv('All', '6.2.X, 7.2.X, 7.4.X')], {
      branch: '7.2',
      vulnerableBelow: '7.2.7',
      patchedAt: '7.2.7',
    });
    expect(isVulnerable(ds, '7.2.6')).toBe(true);
    expect(isVulnerable(ds, '7.2.7')).toBe(false);
    expect(isVulnerable(ds, '8.0.3')).toBe(false);
  });

  it('keeps placed fixes but drops the wildcard when only some tokens are "X"', async () => {
    const ds = await datasetFor([adv('All', '6.2.17, 7.2.X')]);
    expect(ds.flatMap((a) => a.affected).some((r) => r.branch === '*')).toBe(false);
    expect(isVulnerable(ds, '6.2.16')).toBe(true);
    for (const v of ['6.2.17', '7.0.15', '7.2.7']) {
      expect(isVulnerable(ds, v)).toBe(false);
    }
  });

  it('parses a two-part patched version as the .0 release (CVE-2021-21309 shape)', async () => {
    const ds = await datasetFor([adv('All', '6.0.11, 5.0.11, 6.2')]);
    for (const v of ['6.2.0', '6.2.5', '6.2.20', '6.0.11', '5.0.11', '7.0.15']) {
      expect(isVulnerable(ds, v)).toBe(false);
    }
    for (const v of ['6.0.10', '5.0.10', '4.0.14']) {
      expect(isVulnerable(ds, v)).toBe(true);
    }
  });

  it.each([
    ['CVE-2021-32626', '2.6 or newer', '5.0.14, 6.0.16, 6.2.6', '8.2.3', '6.0.15'],
    ['CVE-2024-31449', '>= 2.8.18', '6.2.16, 7.2.6, 7.4.1', '8.0.4', '7.0.15'],
    ['CVE-2025-62507', '>= 8.2.0', '8.2.3', '8.4.0', '8.2.2'],
  ])(
    '%s: no finding on a branch cut after the newest fix',
    async (_cve, range, patched, clean, vulnerable) => {
      const ds = await datasetFor([adv(range, patched)]);
      expect(isVulnerable(ds, clean)).toBe(false);
      expect(isVulnerable(ds, vulnerable)).toBe(true);
    },
  );

  it('lower-bounded range does not flag versions below the floor', async () => {
    const ds = await datasetFor([adv('>= 7.0.0', '7.2.11')]);
    expect(isVulnerable(ds, '6.2.20')).toBe(false);
    expect(isVulnerable(ds, '7.0.15')).toBe(true);
  });
});
