import { MitreSource } from '../sources/mitre.source';
import mitreRecord from './fixtures/mitre-cve-2025-49112.json';

function fetchStub(body: unknown, status = 200): jest.Mock {
  return jest.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body });
}

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
});
