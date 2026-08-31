import type { Advisory } from '@betterdb/shared';
import { NvdSource } from '../sources/nvd.source';
import { matchRanges } from '../matcher/version-range';
import nvdValkey from './fixtures/nvd-valkey.json';

function fetchStub(body: unknown, status = 200): jest.Mock {
  return jest.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body });
}

async function advisoryFor(cveId: string, product: string): Promise<Advisory | undefined> {
  const result = await new NvdSource(fetchStub(nvdValkey)).fetchAdvisories();

  return result.advisories.find((advisory) => {
    return advisory.cveId === cveId && advisory.product === product;
  });
}

describe('NvdSource', () => {
  it('queries the lfprojects vendor, never linuxfoundation', async () => {
    const stub = fetchStub(nvdValkey);
    await new NvdSource(stub).fetchAdvisories();
    const urls = stub.mock.calls.map((call) => {
      return String(call[0]);
    });

    expect(urls.some((url) => url.includes('lfprojects:valkey'))).toBe(true);
    expect(urls.some((url) => url.includes('linuxfoundation'))).toBe(false);
  });

  it('wildcards the branch only for a match with no versionStartIncluding', async () => {
    const advisory = await advisoryFor('CVE-2026-21863', 'valkey');

    expect(advisory?.confidence).toBe('broad');
    expect(advisory?.affected).toContainEqual({ branch: '*', vulnerableAtOrBelow: '7.2.11' });
  });

  it('splits a multi-branch NVD entry into one range per branch with exact decremented bounds', async () => {
    const advisory = await advisoryFor('CVE-2026-21863', 'valkey');

    expect(advisory?.confidence).toBe('broad');
    expect(advisory?.affected).toContainEqual({ branch: '8.0', vulnerableAtOrBelow: '8.0.6' });
    expect(advisory?.affected).toContainEqual({ branch: '8.1', vulnerableAtOrBelow: '8.1.5' });
    expect(advisory?.affected).toContainEqual({ branch: '9.0', vulnerableAtOrBelow: '9.0.1' });
    expect(advisory?.affected).toHaveLength(4);
  });

  it('regression: does not flag a patched version against an exclusive upper bound', async () => {
    const advisory = await advisoryFor('CVE-2026-21863', 'valkey');

    expect(matchRanges('7.2.12', advisory?.affected ?? []).vulnerable).toBe(false);
    expect(matchRanges('8.0.7', advisory?.affected ?? []).vulnerable).toBe(false);
  });

  it('regression: flags a vulnerable predecessor on its derived branch rather than missing it', async () => {
    const advisory = await advisoryFor('CVE-2026-21863', 'valkey');

    expect(matchRanges('8.0.6', advisory?.affected ?? []).vulnerable).toBe(true);
  });

  it('contributes no ranges to the valkey product for a redis-only advisory', async () => {
    const advisory = await advisoryFor('CVE-2021-32687', 'valkey');

    expect(advisory?.affected).toEqual([]);
    expect(advisory?.confidence).toBe('unversioned');
  });

  it('marks a CVE with no configurations as unversioned rather than dropping it', async () => {
    const result = await new NvdSource(fetchStub(nvdValkey)).fetchAdvisories();
    const unversioned = result.advisories.filter((advisory) => {
      return advisory.confidence === 'unversioned';
    });

    expect(unversioned.length).toBeGreaterThan(0);
    expect(unversioned[0].affected).toEqual([]);
  });

  it('reports zero records without throwing, so the refresh can call it a source failure', async () => {
    const empty = { totalResults: 0, vulnerabilities: [] };
    const result = await new NvdSource(fetchStub(empty)).fetchAdvisories();

    expect(result.recordCount).toBe(0);
    expect(result.query).toContain('lfprojects');
  });

  it('regression: keeps a cross-branch interval wildcarded and matches a mid-branch version', async () => {
    const advisory = await advisoryFor('CVE-2025-21605', 'redis');

    expect(advisory?.affected.some((range) => range.branch === '7.0')).toBe(false);
    expect(matchRanges('7.2.4', advisory?.affected ?? []).vulnerable).toBe(true);
  });

  it('pins a same-branch interval to its branch rather than leaving it wildcarded', async () => {
    const advisory = await advisoryFor('CVE-2025-21605', 'redis');

    expect(advisory?.affected).toContainEqual({ branch: '7.4', vulnerableAtOrBelow: '7.4.2' });
  });

  it('collapses multiple wildcard ranges for one advisory to the single highest bound', async () => {
    const advisory = await advisoryFor('CVE-2025-21605', 'redis');
    const wildcards = advisory?.affected.filter((range) => range.branch === '*') ?? [];

    expect(wildcards).toHaveLength(1);
    expect(wildcards[0]).toEqual({ branch: '*', vulnerableAtOrBelow: '7.2.7' });
    expect(matchRanges('6.5.0', advisory?.affected ?? []).vulnerable).toBe(true);
  });

  it('uses a .0 exclusive upper bound inclusively instead of producing a malformed decrement', async () => {
    const advisory = await advisoryFor('CVE-2021-31294', 'redis');

    expect(advisory?.affected).toContainEqual({ branch: '*', vulnerableAtOrBelow: '6.2.0' });
    expect(matchRanges('6.2.0', advisory?.affected ?? []).vulnerable).toBe(true);
    expect(matchRanges('6.2.1', advisory?.affected ?? []).vulnerable).toBe(false);
  });

  it('does not produce a NaN segment for a two-segment exclusive upper bound', () => {
    const twoSegmentPayload = {
      totalResults: 1,
      vulnerabilities: [
        {
          cve: {
            id: 'CVE-9999-00001',
            descriptions: [{ lang: 'en', value: 'synthetic two-segment bound case' }],
            configurations: [
              {
                nodes: [
                  {
                    cpeMatch: [
                      {
                        vulnerable: true,
                        criteria: 'cpe:2.3:a:redis:redis:*:*:*:*:*:*:*:*',
                        versionEndExcluding: '8.0',
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      ],
    };

    return new NvdSource(fetchStub(twoSegmentPayload)).fetchAdvisories().then((result) => {
      const advisory = result.advisories.find((entry) => {
        return entry.cveId === 'CVE-9999-00001' && entry.product === 'redis';
      });

      expect(advisory?.affected).toContainEqual({ branch: '*', vulnerableAtOrBelow: '8.0' });
      expect(advisory?.affected.some((range) => range.vulnerableAtOrBelow.includes('NaN'))).toBe(
        false,
      );
      expect(matchRanges('7.9.9', advisory?.affected ?? []).vulnerable).toBe(true);
      expect(matchRanges('8.1.0', advisory?.affected ?? []).vulnerable).toBe(false);
    });
  });

  it('still marks a CVE that omits the configurations key as unversioned', async () => {
    const advisory = await advisoryFor('CVE-2025-49112', 'valkey');

    expect(advisory?.confidence).toBe('unversioned');
    expect(advisory?.affected).toEqual([]);
  });

  it('flags CVE-2025-49844 (RediShell) as vulnerable for redis 7.2.4', async () => {
    const advisory = await advisoryFor('CVE-2025-49844', 'redis');

    expect(matchRanges('7.2.4', advisory?.affected ?? []).vulnerable).toBe(true);
  });
});
