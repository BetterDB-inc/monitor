import { MitreSource } from '../sources/mitre.source';
import mitreRecord from './fixtures/mitre-cve-2025-49112.json';

function fetchStub(body: unknown, status = 200): jest.Mock {
  return jest.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body });
}

const UNRECOGNIZED_PRODUCT_RECORD = {
  cveMetadata: { cveId: 'CVE-2025-90000' },
  containers: {
    cna: {
      descriptions: [{ lang: 'en', value: 'some description' }],
      references: [],
      affected: [{ product: 'SomeOtherThing', vendor: 'someone' }],
    },
  },
};

describe('MitreSource', () => {
  it('returns an unversioned advisory for a CNA record with no ranges', async () => {
    const result = await new MitreSource(fetchStub(mitreRecord)).fetchByIds(['CVE-2025-49112']);

    expect(result.advisories).toHaveLength(1);
    expect(result.advisories[0].confidence).toBe('unversioned');
    expect(result.advisories[0].affected).toEqual([]);
    expect(result.advisories[0].summary.length).toBeGreaterThan(0);
  });

  it('skips ids it cannot fetch instead of failing the refresh', async () => {
    const stub = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => mitreRecord });
    const result = await new MitreSource(stub).fetchByIds(['CVE-0000-0000', 'CVE-2025-49112']);

    expect(result.advisories).toHaveLength(1);
    expect(result.recordCount).toBe(1);
  });

  it('asks for nothing when given no ids', async () => {
    const stub = fetchStub(mitreRecord);
    const result = await new MitreSource(stub).fetchByIds([]);

    expect(stub).not.toHaveBeenCalled();
    expect(result.recordCount).toBe(0);
  });

  it('reports ids it could not fetch as partial failures instead of discarding them', async () => {
    const stub = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => mitreRecord });
    const result = await new MitreSource(stub).fetchByIds(['CVE-0000-0000', 'CVE-2025-49112']);

    expect(result.partialFailures).toBeDefined();
    expect(result.partialFailures).toHaveLength(1);
    expect(result.partialFailures?.[0]).toContain('CVE-0000-0000');
  });

  it('stops issuing requests once its per-source time budget is exhausted', async () => {
    const stub = fetchStub(mitreRecord);
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1100)
      .mockReturnValueOnce(1100)
      .mockReturnValueOnce(1200);

    try {
      const result = await new MitreSource(stub).fetchByIds(
        ['CVE-2025-49112', 'CVE-0000-0001', 'CVE-0000-0002'],
        {},
        50,
      );

      expect(stub).toHaveBeenCalledTimes(1);
      expect(result.advisories).toHaveLength(1);
      expect(result.partialFailures).toEqual([
        'CVE-0000-0001: skipped, mitre time budget exceeded',
        'CVE-0000-0002: skipped, mitre time budget exceeded',
      ]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('uses the caller-supplied product hint instead of the redis fallback', async () => {
    const stub = fetchStub(UNRECOGNIZED_PRODUCT_RECORD);
    const result = await new MitreSource(stub).fetchByIds(['CVE-2025-90000'], {
      'CVE-2025-90000': 'valkey-bloom',
    });

    expect(result.advisories[0].product).toBe('valkey-bloom');
  });

  it('falls back to redis when no product hint is supplied and the record names neither product', async () => {
    const stub = fetchStub(UNRECOGNIZED_PRODUCT_RECORD);
    const result = await new MitreSource(stub).fetchByIds(['CVE-2025-90000']);

    expect(result.advisories[0].product).toBe('redis');
  });
});
