import type { BranchRange } from '@betterdb/shared';
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

function isVulnerable(advisories: Awaited<ReturnType<typeof redisDataset>>, version: string) {
  return (
    matchAdvisories({ product: 'redis', engineVersion: version, modules: [] }, advisories)
      .findings.length > 0
  );
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
