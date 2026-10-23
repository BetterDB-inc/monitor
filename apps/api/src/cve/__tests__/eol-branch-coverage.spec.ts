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
    { branch: '*', vulnerableFrom: '0.0.0', vulnerableBelow: '8.4.0', inferred: true },
  ];
  it('never lets an inferred wildcard re-flag a version past its own branch fix', () => {
    expect(matchRanges('7.2.11', ranges).vulnerable).toBe(false);
  });
  it('applies the inferred wildcard to a branch with no range of its own', () => {
    expect(matchRanges('7.0.15', ranges)).toMatchObject({ vulnerable: true, inferred: true });
  });
  it('lets the inferred wildcard apply past an on-branch upper bound that has no published fix', () => {
    const unfixed: BranchRange[] = [
      { branch: '7.2', vulnerableBelow: '7.2.5' },
      { branch: '*', vulnerableFrom: '0.0.0', vulnerableBelow: '8.4.0', inferred: true },
    ];
    expect(matchRanges('7.2.6', unfixed).vulnerable).toBe(true);
  });
  it('prefers a stated wildcard over the inferred one, so the match is not labelled inferred (jamby77)', () => {
    const both: BranchRange[] = [
      { branch: '*', vulnerableFrom: '0.0.0', vulnerableBelow: '8.4.0', inferred: true },
      { branch: '*', vulnerableBelow: '7.2.0' },
    ];
    const match = matchRanges('7.0.10', both);
    expect(match.vulnerable).toBe(true);
    expect(match).not.toHaveProperty('inferred');
  });
  it('keeps master behaviour for a stated wildcard next to an on-branch fix (NVD-only shape, jamby77)', () => {
    // NVD: [7.0.0, 7.0.5) on 7.0 plus "* < 7.2.0". Only the inferred wildcard is
    // suppressed by an on-branch fix; NVD's own wildcard still flags 7.0.10.
    const nvdOnly: BranchRange[] = [
      { branch: '7.0', vulnerableFrom: '7.0.0', vulnerableBelow: '7.0.5', patchedAt: '7.0.5' },
      { branch: '*', vulnerableBelow: '7.2.0' },
    ];
    expect(matchRanges('7.0.10', nvdOnly).vulnerable).toBe(true);
    expect(matchRanges('7.0.10', nvdOnly)).not.toHaveProperty('inferred');
    expect(matchRanges('7.2.0', nvdOnly).vulnerable).toBe(false);
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

// Default publish date falls after 8.2.0 and before 8.4.0 (see branch-releases.ts).
const adv = (
  range: string | null,
  patched: string,
  repo = 'redis/redis',
  id = 'GHSA-x',
  publishedAt: string | null = '2025-10-03T00:00:00Z',
) => ({
  ghsa_id: id,
  cve_id: 'CVE-2099-0002',
  severity: 'critical',
  cvss: { score: 9 },
  cwe_ids: [],
  summary: 's',
  published_at: publishedAt,
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

  it('(b) "All" with only 6.2/7.2 patched still flags unpatched 7.4/8.0 released before disclosure', async () => {
    const ds = await datasetFor([adv('All', '6.2.20, 7.2.11')]);
    for (const v of [
      '5.0.14',
      '6.0.20',
      '7.0.15',
      '6.2.19',
      '7.2.10',
      '7.4.0',
      '7.4.5',
      '8.0.0',
      '8.2.0',
    ]) {
      expect(isVulnerable(ds, v)).toBe(true);
    }
    for (const v of ['6.2.20', '7.2.11']) {
      expect(isVulnerable(ds, v)).toBe(false); // patched on own branch
    }
    expect(isVulnerable(ds, '8.4.0')).toBe(false); // cut after disclosure
  });

  it('with no published_at, never clears an unlisted newer branch (fail safe)', async () => {
    const ds = await datasetFor([adv('All', '6.2.20, 7.2.11', 'redis/redis', 'GHSA-x', null)]);
    for (const v of ['7.4.0', '8.0.0', '8.4.0']) {
      expect(isVulnerable(ds, v)).toBe(true);
    }
  });

  it('advisory published after every known branch clears nothing unlisted (no evidence)', async () => {
    const ds = await datasetFor([
      adv('All', '6.2.20', 'redis/redis', 'GHSA-x', '2099-01-01T00:00:00Z'),
    ]);
    expect(isVulnerable(ds, '8.4.0')).toBe(true);
    expect(isVulnerable(ds, '6.2.20')).toBe(false);
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
    const ds = await datasetFor(
      [adv('All', 'TBD', 'valkey-io/valkey')],
      'valkey-io/valkey',
      'valkey',
    );
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

  // published_at per NVD (Feb 27, 2021); any date before Redis 7.0.0 (2022-04-27) behaves the same.
  it('parses a two-part patched version as the .0 release (CVE-2021-21309 shape)', async () => {
    const ds = await datasetFor([
      adv('All', '6.0.11, 5.0.11, 6.2', 'redis/redis', 'GHSA-x', '2021-02-27T00:00:00Z'),
    ]);
    for (const v of ['6.2.0', '6.2.5', '6.2.20', '6.0.11', '5.0.11', '7.0.15']) {
      expect(isVulnerable(ds, v)).toBe(false);
    }
    for (const v of ['6.0.10', '5.0.10', '4.0.14']) {
      expect(isVulnerable(ds, v)).toBe(true);
    }
  });

  it.each([
    [
      'CVE-2021-32626',
      '2.6 or newer',
      '5.0.14, 6.0.16, 6.2.6',
      '8.2.3',
      '6.0.15',
      '2021-10-04T11:30:20Z',
    ],
    [
      'CVE-2024-31449',
      '>= 2.8.18',
      '6.2.16, 7.2.6, 7.4.1',
      '8.0.4',
      '7.0.15',
      '2024-10-06T18:16:07Z',
    ],
    ['CVE-2025-62507', '>= 8.2.0', '8.2.3', '8.4.0', '8.2.2', '2025-11-02T13:49:19Z'],
  ])(
    '%s: no finding on a branch cut after the advisory',
    async (_cve, range, patched, clean, vulnerable, publishedAt) => {
      const ds = await datasetFor([adv(range, patched, 'redis/redis', 'GHSA-x', publishedAt)]);
      expect(isVulnerable(ds, clean)).toBe(false);
      expect(isVulnerable(ds, vulnerable)).toBe(true);
    },
  );

  it('an NVD on-branch fix suppresses the wildcard (KIvanow #1)', async () => {
    const ds = await datasetWithNvd([adv('All', '6.2.20, 7.2.11')], {
      branch: '7.0',
      vulnerableBelow: '7.0.15',
      patchedAt: '7.0.15',
    });
    expect(isVulnerable(ds, '7.0.20')).toBe(false); // NVD says fixed on 7.0
    expect(isVulnerable(ds, '7.0.15')).toBe(false);
    expect(isVulnerable(ds, '7.0.14')).toBe(true);
    expect(isVulnerable(ds, '6.0.20')).toBe(true); // other unlisted EOL still flagged
  });

  it('never infers a wildcard for RediSearch (module version line)', async () => {
    const repo = 'RediSearch/RediSearch';
    const fetch = jest.fn().mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () =>
        url.includes(`/repos/${repo}/`) ? [adv('>= 2.0.0', '2.6.20, 2.8.10', repo)] : [],
    }));
    const ghsa = await new GhsaSource(fetch).fetchAdvisories();
    const affected = ghsa.advisories.flatMap((a) => a.affected);
    expect(affected.length).toBeGreaterThan(0);
    expect(affected.some((r) => r.branch === '*')).toBe(false);
  });

  it.each(['8.0.4 and above', '>= 8.0.4', '8.0.4+', '8.0.4 or later'])(
    'open-ended patched token "%s" infers no wildcard (KIvanow #3)',
    async (token) => {
      const ds = await datasetFor([adv('All', `7.2.11, ${token}`)]);
      expect(ds.flatMap((a) => a.affected).some((r) => r.branch === '*')).toBe(false);
      expect(isVulnerable(ds, '8.2.1')).toBe(false); // vendor says fixed
      expect(isVulnerable(ds, '8.0.3')).toBe(true); // below fix on own branch
      expect(isVulnerable(ds, '7.2.10')).toBe(true);
    },
  );

  it('stores no sentinel ceiling when there is no evidence (KIvanow #4)', async () => {
    const ds = await datasetFor([adv('All', '6.2.20, 7.2.11', 'redis/redis', 'GHSA-x', null)]);
    const wildcard = ds.flatMap((a) => a.affected).find((r) => r.branch === '*');
    expect(wildcard).toBeDefined();
    expect(wildcard).not.toHaveProperty('vulnerableBelow');
    expect(JSON.stringify(ds)).not.toContain('999');
    for (const v of ['7.4.0', '8.0.0', '8.4.0', '8.10.0']) expect(isVulnerable(ds, v)).toBe(true);
  });

  it('labels date-inferred matches broad and vendor ranges exact (KIvanow #5)', async () => {
    const ds = await redisDataset();
    const finding = (v: string) =>
      matchAdvisories({ product: 'redis', engineVersion: v, modules: [] }, ds).findings[0];
    expect(finding('7.0.15').confidence).toBe('broad'); // EOL, wildcard only
    expect(finding('7.2.10').confidence).toBe('exact'); // below vendor fix on own branch
  });

  it('an advisory published between 8.8 and 8.10 GA clears 8.10.0 but flags 8.8.x', async () => {
    const ds = await datasetFor([
      adv('All', '7.2.11', 'redis/redis', 'GHSA-x', '2026-06-15T00:00:00Z'),
    ]);
    expect(isVulnerable(ds, '8.10.0')).toBe(false);
    expect(isVulnerable(ds, '8.8.0')).toBe(true);
    expect(isVulnerable(ds, '8.6.3')).toBe(true);
  });

  it('lower-bounded range does not flag versions below the floor', async () => {
    const ds = await datasetFor([adv('>= 7.0.0', '7.2.11')]);
    expect(isVulnerable(ds, '6.2.20')).toBe(false);
    expect(isVulnerable(ds, '7.0.15')).toBe(true);
  });
  it.each(['7.1.0', '7.3.2', '7.9.240', '8.1.0', '8.3.0'])(
    'does not flag %s: a minor that never shipped as a Redis GA branch (KIvanow #3)',
    async (version) => {
      expect(isVulnerable(await redisDataset(), version)).toBe(false);
    },
  );
  it('still flags branches newer than the release table or older than it (fail safe)', async () => {
    const ds = await datasetFor([adv('All', '6.2.20, 7.2.11', 'redis/redis', 'GHSA-x', null)]);
    // Above the last row we cannot tell a GA line from a minor, so never clear it.
    for (const v of ['8.11.0', '8.12.0', '9.0.0', '2.4.18']) {
      expect(isVulnerable(ds, v)).toBe(true);
    }
  });
  it('infers nothing from a platform-qualified range (CVE-2021-21309 real shape, KIvanow #5)', async () => {
    const ds = await datasetFor([
      adv(
        '>= 4.0 (32-bit only)',
        '6.0.11, 5.0.11, 6.2',
        'redis/redis',
        'GHSA-x',
        '2021-02-27T00:00:00Z',
      ),
    ]);
    expect(ds.flatMap((a) => a.affected).some((r) => r.branch === '*')).toBe(false);
    for (const v of ['4.0.14', '6.2.0', '7.0.15']) {
      expect(isVulnerable(ds, v)).toBe(false);
    }
    expect(isVulnerable(ds, '6.0.10')).toBe(true); // vendor fix on its own branch still applies
  });
  it.each(['>= 7.0, < 7.2', '7.0 and newer on 32-bit', '>= 7.0 (see notes)'])(
    'infers nothing when the floor is qualified: %s',
    async (range) => {
      const ds = await datasetFor([adv(range, '7.2.11')]);
      expect(ds.flatMap((a) => a.affected).some((r) => r.inferred === true)).toBe(false);
    },
  );
  it('reports exact, not broad, when a stated wildcard also covers the version (jamby77)', async () => {
    const base = adv('All', '6.2.20, 7.2.11');
    const both = {
      ...base,
      vulnerabilities: [
        ...base.vulnerabilities,
        {
          package: { ecosystem: '', name: 'redis' },
          vulnerable_version_range: '< 7.2.0',
          patched_versions: '',
        },
      ],
    };
    const ds = await datasetFor([both]);
    const affected = ds.flatMap((a) => a.affected);
    expect(affected.some((r) => r.branch === '*' && r.inferred === true)).toBe(true);
    expect(affected.some((r) => r.branch === '*' && r.inferred !== true)).toBe(true);
    const finding = (v: string) =>
      matchAdvisories({ product: 'redis', engineVersion: v, modules: [] }, ds).findings[0];
    expect(finding('7.0.15').confidence).toBe('exact'); // vendor's "< 7.2.0" covers it
    expect(finding('7.4.0').confidence).toBe('broad'); // only the inferred wildcard does
  });
});
