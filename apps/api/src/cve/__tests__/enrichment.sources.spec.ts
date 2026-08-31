import { EpssSource } from '../sources/epss.source';
import { KevSource } from '../sources/kev.source';

const KEV_BODY = {
  vulnerabilities: [
    { cveID: 'CVE-2022-0543', vendorProject: 'Redis', product: 'Redis' },
    { cveID: 'CVE-2025-49844', vendorProject: 'Valkey', product: 'Valkey' },
  ],
};

const EPSS_BODY = {
  data: [
    { cve: 'CVE-2022-0543', epss: '0.993500000', percentile: '0.999900000' },
    { cve: 'CVE-2026-21863', epss: '0.007600000', percentile: '0.528000000' },
  ],
};

function fetchStub(body: unknown): jest.Mock {
  return jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body });
}

describe('KevSource', () => {
  it('flags only the ids present in the catalogue', async () => {
    const result = await new KevSource(fetchStub(KEV_BODY)).enrich([
      'CVE-2022-0543',
      'CVE-2026-63639',
    ]);
    const entries = new Map(result.entries);

    expect(entries.get('CVE-2022-0543')).toEqual({ knownExploited: true });
    expect(entries.has('CVE-2026-63639')).toBe(false);
  });
});

describe('EpssSource', () => {
  it('parses the string scores into numbers', async () => {
    const result = await new EpssSource(fetchStub(EPSS_BODY)).enrich([
      'CVE-2022-0543',
      'CVE-2026-21863',
    ]);
    const entries = new Map(result.entries);

    expect(entries.get('CVE-2026-21863')).toEqual({ epssScore: 0.0076, epssPercentile: 0.528 });
  });

  it('batches the ids so the query string cannot grow unbounded', async () => {
    const stub = fetchStub(EPSS_BODY);
    const ids = Array.from({ length: 250 }, (_, index) => {
      return `CVE-2026-${String(index).padStart(5, '0')}`;
    });
    await new EpssSource(stub).enrich(ids);

    expect(stub.mock.calls.length).toBeGreaterThan(1);
  });

  it('returns no entries for an empty id list without calling out', async () => {
    const stub = fetchStub(EPSS_BODY);
    const result = await new EpssSource(stub).enrich([]);

    expect(stub).not.toHaveBeenCalled();
    expect(result.entries).toEqual([]);
  });

  it('flags a batch as a partial failure when it reports zero total for a non-empty request', async () => {
    const stub = fetchStub({ total: 0, data: [] });
    const result = await new EpssSource(stub).enrich(['CVE-2022-0543']);

    expect(result.entries).toEqual([]);
    expect(result.partialFailures).toBeDefined();
    expect(result.partialFailures).toHaveLength(1);
  });

  it('keeps entries from a good batch when a later batch reports zero total', async () => {
    const ids = Array.from({ length: 150 }, (_, index) => {
      return `CVE-2026-${String(index).padStart(5, '0')}`;
    });
    let call = 0;
    const stub = jest.fn().mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        return { ok: true, status: 200, json: async () => EPSS_BODY };
      }
      return { ok: true, status: 200, json: async () => ({ total: 0, data: [] }) };
    });
    const result = await new EpssSource(stub).enrich(ids);

    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.partialFailures).toHaveLength(1);
  });

  it('keeps entries from a good batch when a later batch throws', async () => {
    const ids = Array.from({ length: 150 }, (_, index) => {
      return `CVE-2026-${String(index).padStart(5, '0')}`;
    });
    let call = 0;
    const stub = jest.fn().mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        return { ok: true, status: 200, json: async () => EPSS_BODY };
      }
      throw new Error('network unreachable');
    });
    const result = await new EpssSource(stub).enrich(ids);

    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.partialFailures).toHaveLength(1);
    expect(result.partialFailures?.[0]).toContain('network unreachable');
  });

  it('does not flag a batch as failed when the response has no total field at all', async () => {
    const stub = fetchStub(EPSS_BODY);
    const result = await new EpssSource(stub).enrich(['CVE-2022-0543', 'CVE-2026-21863']);

    expect(result.partialFailures).toBeUndefined();
  });
});
