import { NvdSource } from '../sources/nvd.source';
import nvdValkey from './fixtures/nvd-valkey.json';

function fetchStub(body: unknown, status = 200): jest.Mock {
  return jest.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body });
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

  it('marks an upper-bound-only range as broad and wildcards its branch', async () => {
    const result = await new NvdSource(fetchStub(nvdValkey)).fetchAdvisories();
    const ranged = result.advisories.find((advisory) => {
      return advisory.affected.length > 0;
    });

    expect(ranged?.confidence).toBe('broad');
    expect(ranged?.affected[0].branch).toBe('*');
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
});
