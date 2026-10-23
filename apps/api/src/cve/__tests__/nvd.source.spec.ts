import type { Advisory } from '@betterdb/shared';
import { NvdSource } from '../sources/nvd.source';
import { matchAdvisories } from '../matcher/advisory-matcher';
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
    expect(advisory?.affected).toContainEqual({ branch: '*', vulnerableBelow: '7.2.12' });
  });

  it('splits a multi-branch NVD entry into one range per branch with exclusive upper bounds', async () => {
    const advisory = await advisoryFor('CVE-2026-21863', 'valkey');

    expect(advisory?.confidence).toBe('broad');
    expect(advisory?.affected).toContainEqual({
      branch: '8.0',
      vulnerableBelow: '8.0.7',
      vulnerableFrom: '8.0.0',
      patchedAt: '8.0.7',
    });
    expect(advisory?.affected).toContainEqual({
      branch: '8.1',
      vulnerableBelow: '8.1.6',
      vulnerableFrom: '8.1.0',
      patchedAt: '8.1.6',
    });
    expect(advisory?.affected).toContainEqual({
      branch: '9.0',
      vulnerableBelow: '9.0.2',
      vulnerableFrom: '9.0.0',
      patchedAt: '9.0.2',
    });
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

    expect(advisory?.affected).toContainEqual({
      branch: '7.4',
      vulnerableBelow: '7.4.3',
      vulnerableFrom: '7.4.0',
      patchedAt: '7.4.3',
    });
  });

  it('collapses multiple wildcard ranges for one advisory to the single highest bound', async () => {
    const advisory = await advisoryFor('CVE-2025-21605', 'redis');
    const wildcards = advisory?.affected.filter((range) => range.branch === '*') ?? [];

    expect(wildcards).toHaveLength(1);
    expect(wildcards[0]).toEqual({
      branch: '*',
      vulnerableBelow: '7.2.8',
      vulnerableFrom: '2.6.0',
    });
    expect(matchRanges('6.5.0', advisory?.affected ?? []).vulnerable).toBe(true);
  });

  it('records patchedAt only for an exclusive end on a concrete branch', () => {
    const cve = (match: Record<string, string>) => ({
      totalResults: 1,
      vulnerabilities: [
        {
          cve: {
            id: 'CVE-2099-7000',
            configurations: [
              {
                nodes: [
                  {
                    cpeMatch: [
                      {
                        criteria: 'cpe:2.3:a:redis:redis:*:*:*:*:*:*:*:*',
                        vulnerable: true,
                        ...match,
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      ],
    });
    const rangesFor = async (match: Record<string, string>) => {
      const result = await new NvdSource(fetchStub(cve(match))).fetchAdvisories();
      return result.advisories.find((a) => a.product === 'redis')?.affected ?? [];
    };

    return Promise.all([
      rangesFor({ versionStartIncluding: '7.0.0', versionEndExcluding: '7.0.15' }),
      rangesFor({ versionStartIncluding: '7.0.0', versionEndIncluding: '7.0.14' }),
      rangesFor({ versionEndExcluding: '7.0.15' }),
    ]).then(([excluding, including, wildcard]) => {
      expect(excluding).toEqual([
        { branch: '7.0', vulnerableBelow: '7.0.15', vulnerableFrom: '7.0.0', patchedAt: '7.0.15' },
      ]);
      expect(including[0]).not.toHaveProperty('patchedAt');
      expect(wildcard[0]).toMatchObject({ branch: '*' });
      expect(wildcard[0]).not.toHaveProperty('patchedAt');
    });
  });

  describe('NVD branch fix plus its own wildcard (KIvanow #6, jamby77)', () => {
    const payload = {
      totalResults: 1,
      vulnerabilities: [
        {
          cve: {
            id: 'CVE-2099-7001',
            configurations: [
              {
                nodes: [
                  {
                    cpeMatch: [
                      {
                        criteria: 'cpe:2.3:a:redis:redis:*:*:*:*:*:*:*:*',
                        vulnerable: true,
                        versionStartIncluding: '7.0.0',
                        versionEndExcluding: '7.0.5',
                      },
                      {
                        criteria: 'cpe:2.3:a:redis:redis:*:*:*:*:*:*:*:*',
                        vulnerable: true,
                        versionEndExcluding: '7.2.0',
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
    const redisAdvisory = async () => {
      const result = await new NvdSource(fetchStub(payload)).fetchAdvisories();
      const advisory = result.advisories.find((a) => a.product === 'redis');
      expect(advisory).toBeDefined();
      return advisory as Advisory;
    };

    it('reports fixedIn on an NVD on-branch finding (new, visible behaviour)', async () => {
      const advisory = await redisAdvisory();
      const finding = matchAdvisories({ product: 'redis', engineVersion: '7.0.4', modules: [] }, [
        advisory,
      ]).findings[0];
      expect(finding.fixedIn).toBe('7.0.5');
      expect(finding.confidence).toBe(advisory.confidence);
    });

    it("keeps flagging a build past the branch fix that NVD's own wildcard still covers (unchanged vs master)", async () => {
      const advisory = await redisAdvisory();
      expect(matchRanges('7.0.10', advisory.affected).vulnerable).toBe(true);
      expect(matchRanges('7.2.0', advisory.affected).vulnerable).toBe(false);
    });
  });

  it('keeps a .0 exclusive upper bound exclusive, so the first patched release is not a finding', async () => {
    const advisory = await advisoryFor('CVE-2021-31294', 'redis');

    expect(advisory?.affected).toContainEqual({ branch: '*', vulnerableBelow: '6.2.0' });
    expect(matchRanges('6.1.9', advisory?.affected ?? []).vulnerable).toBe(true);
    expect(matchRanges('6.2.0', advisory?.affected ?? []).vulnerable).toBe(false);
    expect(matchRanges('6.2.1', advisory?.affected ?? []).vulnerable).toBe(false);
  });

  it('keeps the inclusive ceiling when two CPE matches share it with different inclusivity', () => {
    const equalCeilingPayload = {
      totalResults: 1,
      vulnerabilities: [
        {
          cve: {
            id: 'CVE-9999-00002',
            descriptions: [{ lang: 'en', value: 'synthetic equal-ceiling case' }],
            configurations: [
              {
                nodes: [
                  {
                    cpeMatch: [
                      {
                        vulnerable: true,
                        criteria: 'cpe:2.3:a:redis:redis:*:*:*:*:*:*:*:*',
                        versionEndExcluding: '6.2.0',
                      },
                      {
                        vulnerable: true,
                        criteria: 'cpe:2.3:a:redis:redis:*:*:*:*:*:*:*:*',
                        versionEndIncluding: '6.2.0',
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

    return new NvdSource(fetchStub(equalCeilingPayload)).fetchAdvisories().then((result) => {
      const advisory = result.advisories.find((entry) => {
        return entry.cveId === 'CVE-9999-00002' && entry.product === 'redis';
      });

      expect(advisory?.affected).toEqual([{ branch: '*', vulnerableAtOrBelow: '6.2.0' }]);
      expect(matchRanges('6.2.0', advisory?.affected ?? []).vulnerable).toBe(true);
      expect(matchRanges('6.2.1', advisory?.affected ?? []).vulnerable).toBe(false);
    });
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

      expect(advisory?.affected).toContainEqual({ branch: '*', vulnerableBelow: '8.0' });
      expect(
        advisory?.affected.some((range) => {
          return `${range.vulnerableBelow ?? range.vulnerableAtOrBelow ?? ''}`.includes('NaN');
        }),
      ).toBe(false);
      expect(matchRanges('7.9.9', advisory?.affected ?? []).vulnerable).toBe(true);
      expect(matchRanges('8.0.0', advisory?.affected ?? []).vulnerable).toBe(false);
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

  it('keeps versionStartIncluding so a release below the interval is not flagged', async () => {
    const advisory = await advisoryFor('CVE-2025-21605', 'valkey');
    const onBranch = advisory?.affected.find((range) => {
      return range.branch === '7.2';
    });

    expect(onBranch?.vulnerableFrom).toBe('7.2.4');
    expect(matchRanges('7.2.3', advisory?.affected ?? []).vulnerable).toBe(false);
    expect(matchRanges('7.2.0', advisory?.affected ?? []).vulnerable).toBe(false);
    expect(matchRanges('7.2.4', advisory?.affected ?? []).vulnerable).toBe(true);
    expect(matchRanges('7.2.8', advisory?.affected ?? []).vulnerable).toBe(true);
    expect(matchRanges('7.2.9', advisory?.affected ?? []).vulnerable).toBe(false);
  });

  it('paginates past the first page instead of dropping the rest of a CPE result set', async () => {
    const page = (startIndex: number): unknown => {
      return {
        totalResults: 3,
        vulnerabilities: [
          {
            cve: {
              id: `CVE-9999-1000${startIndex}`,
              descriptions: [{ lang: 'en', value: 'paged' }],
            },
          },
        ],
      };
    };
    const stub = jest.fn().mockImplementation(async (url: string) => {
      const match = /startIndex=(\d+)/.exec(url);

      return { ok: true, status: 200, json: async () => page(Number(match?.[1] ?? 0)) };
    });
    const result = await new NvdSource(stub).fetchAdvisories();
    const redisIds = result.advisories
      .filter((advisory) => {
        return advisory.product === 'redis';
      })
      .map((advisory) => {
        return advisory.cveId;
      });

    expect(redisIds).toEqual(['CVE-9999-10000', 'CVE-9999-10001', 'CVE-9999-10002']);
    expect(result.partialFailures).toBeUndefined();
  });

  it('reports a partial failure rather than ok when a page cannot be fetched', async () => {
    const stub = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        return { totalResults: 500, vulnerabilities: [] };
      },
    });
    const result = await new NvdSource(stub).fetchAdvisories();

    expect(result.partialFailures).toBeDefined();
    expect(result.partialFailures?.[0]).toContain('fetched 0 of 500 results');
  });

  it('does not report a partial failure when every page was fetched', async () => {
    const result = await new NvdSource(fetchStub(nvdValkey)).fetchAdvisories();

    expect(result.partialFailures).toBeUndefined();
  });
});
