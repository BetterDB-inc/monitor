import { GhsaSource } from '../sources/ghsa.source';
import ghsaValkey from './fixtures/ghsa-valkey.json';

function fetchStub(body: unknown, status = 200): jest.Mock {
  return jest.fn().mockResolvedValue({
    ok: status < 400,
    status,
    json: async () => body,
  });
}

function ghsaAdvisory(overrides: {
  cve_id: string;
  vulnerable_version_range: string | null;
  patched_versions: string | null;
}): unknown {
  return {
    ghsa_id: `GHSA-${overrides.cve_id}`,
    cve_id: overrides.cve_id,
    summary: 'synthetic advisory',
    severity: 'medium',
    cvss: { score: 5.5 },
    cwe_ids: [],
    html_url: `https://github.com/valkey-io/valkey/security/advisories/GHSA-${overrides.cve_id}`,
    vulnerabilities: [
      {
        vulnerable_version_range: overrides.vulnerable_version_range,
        patched_versions: overrides.patched_versions,
      },
    ],
  };
}

describe('GhsaSource', () => {
  it('expands patched_versions into one branch-aware range per patched branch', async () => {
    const source = new GhsaSource(fetchStub(ghsaValkey));
    const result = await source.fetchAdvisories();
    const advisory = result.advisories.find((a) => {
      return a.cveId === 'CVE-2026-63639';
    });

    expect(advisory).toBeDefined();
    expect(advisory?.confidence).toBe('exact');
    expect(advisory?.affected).toContainEqual({
      branch: '8.0',
      vulnerableAtOrBelow: '8.0.9',
      patchedAt: '8.0.10',
    });
    expect(advisory?.affected).toHaveLength(5);
  });

  it('expands a partial vulnerable_version_range using the fuller patched_versions list', async () => {
    const source = new GhsaSource(fetchStub(ghsaValkey));
    const result = await source.fetchAdvisories();
    const advisory = result.advisories.find((a) => {
      return a.cveId === 'CVE-2026-21863';
    });

    expect(advisory).toBeDefined();
    expect(advisory?.confidence).toBe('exact');
    expect(advisory?.affected).toHaveLength(4);
    expect(advisory?.affected).toContainEqual({
      branch: '8.1',
      vulnerableAtOrBelow: '8.1.5',
      patchedAt: '8.1.6',
    });
    expect(advisory?.affected).toContainEqual({
      branch: '7.2',
      vulnerableAtOrBelow: '7.2.11',
      patchedAt: '7.2.12',
    });
  });

  it('parses the "and below" / "and above" prose form of patched_versions', async () => {
    const source = new GhsaSource(fetchStub(ghsaValkey));
    const result = await source.fetchAdvisories();
    const advisory = result.advisories.find((a) => {
      return a.cveId === 'CVE-2025-49844';
    });

    expect(advisory).toBeDefined();
    expect(advisory?.confidence).toBe('exact');
    expect(advisory?.affected).toHaveLength(3);
    expect(advisory?.affected).toContainEqual({
      branch: '8.1',
      vulnerableAtOrBelow: '8.1.3',
      patchedAt: '8.1.4',
    });
  });

  it('decrements a patch-1 patched version down to the branch minor release', async () => {
    const source = new GhsaSource(fetchStub(ghsaValkey));
    const result = await source.fetchAdvisories();
    const advisory = result.advisories.find((a) => {
      return a.cveId === 'CVE-2025-21605';
    });

    expect(advisory).toBeDefined();
    expect(advisory?.affected).toContainEqual({
      branch: '8.1',
      vulnerableAtOrBelow: '8.1.0',
      patchedAt: '8.1.1',
    });
  });

  it('skips a patched version whose patch segment is 0, since nothing on that branch is vulnerable', async () => {
    const fixture = [
      ghsaAdvisory({
        cve_id: 'CVE-9999-00001',
        vulnerable_version_range: '<= 9.0.9, <= 8.0.9',
        patched_versions: '9.0.0, 8.0.5',
      }),
    ];
    const source = new GhsaSource(fetchStub(fixture));
    const result = await source.fetchAdvisories();
    const advisory = result.advisories[0];

    expect(advisory.confidence).toBe('exact');
    expect(advisory.affected).toEqual([
      { branch: '8.0', vulnerableAtOrBelow: '8.0.4', patchedAt: '8.0.5' },
    ]);
  });

  it('falls back to a broad wildcard range when only a bare upper bound is available', async () => {
    const fixture = [
      ghsaAdvisory({
        cve_id: 'CVE-9999-00002',
        vulnerable_version_range: '<= 9.1.0',
        patched_versions: null,
      }),
    ];
    const source = new GhsaSource(fetchStub(fixture));
    const result = await source.fetchAdvisories();
    const advisory = result.advisories[0];

    expect(advisory.confidence).toBe('broad');
    expect(advisory.affected).toEqual([{ branch: '*', vulnerableAtOrBelow: '9.1.0' }]);
  });

  it('reports unversioned when neither field yields a parseable version', async () => {
    const fixture = [
      ghsaAdvisory({
        cve_id: 'CVE-9999-00003',
        vulnerable_version_range: '>= 7.2',
        patched_versions: null,
      }),
    ];
    const source = new GhsaSource(fetchStub(fixture));
    const result = await source.fetchAdvisories();
    const advisory = result.advisories[0];

    expect(advisory.confidence).toBe('unversioned');
    expect(advisory.affected).toEqual([]);
  });

  it('records the product of the repo it came from', async () => {
    const source = new GhsaSource(fetchStub(ghsaValkey));
    const result = await source.fetchAdvisories();

    expect(
      result.advisories.every((a) =>
        ['redis', 'valkey', 'valkey-bloom', 'valkey-json', 'valkey-search', 'redisearch'].includes(
          a.product,
        ),
      ),
    ).toBe(true);
    expect(result.source).toBe('ghsa');
    expect(result.partialFailures).toBeUndefined();
  });

  it('reports the record count and the query it used', async () => {
    const source = new GhsaSource(fetchStub(ghsaValkey));
    const result = await source.fetchAdvisories();

    expect(result.recordCount).toBe(result.advisories.length);
    expect(result.query).toContain('security-advisories');
  });

  it('keeps the repos that answered when one repo fails', async () => {
    let call = 0;
    const flaky = jest.fn().mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        return { ok: false, status: 403, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ghsaValkey };
    });
    const source = new GhsaSource(flaky);
    const result = await source.fetchAdvisories();

    expect(result.recordCount).toBeGreaterThan(0);
  });

  it('reports the repo that failed as a partial failure instead of discarding it silently', async () => {
    let call = 0;
    const flaky = jest.fn().mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        return { ok: false, status: 403, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ghsaValkey };
    });
    const source = new GhsaSource(flaky);
    const result = await source.fetchAdvisories();

    expect(result.partialFailures).toBeDefined();
    expect(result.partialFailures).toHaveLength(1);
    expect(result.partialFailures?.[0]).toContain('redis/redis');
  });

  it('throws when every repo fails, so the refresh keeps the previous dataset', async () => {
    const source = new GhsaSource(fetchStub({}, 403));

    await expect(source.fetchAdvisories()).rejects.toThrow();
  });
});
