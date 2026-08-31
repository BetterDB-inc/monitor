import { GhsaSource } from '../sources/ghsa.source';
import ghsaValkey from './fixtures/ghsa-valkey.json';

function fetchStub(body: unknown, status = 200): jest.Mock {
  return jest.fn().mockResolvedValue({
    ok: status < 400,
    status,
    json: async () => body,
  });
}

describe('GhsaSource', () => {
  it('turns each vulnerability entry into a branch-aware range', async () => {
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

  it('throws when every repo fails, so the refresh keeps the previous dataset', async () => {
    const source = new GhsaSource(fetchStub({}, 403));

    await expect(source.fetchAdvisories()).rejects.toThrow();
  });
});
