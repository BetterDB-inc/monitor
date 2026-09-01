import { EpssSource } from '../sources/epss.source';
import { KevSource } from '../sources/kev.source';

function kevCatalogue(size: number): { vulnerabilities: Array<{ cveID: string }> } {
  const filler = Array.from({ length: Math.max(size - 2, 0) }, (_unused, index) => {
    return { cveID: `CVE-2020-${String(index).padStart(5, '0')}` };
  });

  return {
    vulnerabilities: [{ cveID: 'CVE-2022-0543' }, { cveID: 'CVE-2025-49844' }, ...filler],
  };
}

const KEV_BODY = kevCatalogue(1500);

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

  it('reports recordCount as matched entries, in the same unit the blanking guard measures', async () => {
    const result = await new KevSource(fetchStub(KEV_BODY)).enrich([
      'CVE-2022-0543',
      'CVE-2026-63639',
    ]);

    expect(result.entries).toHaveLength(1);
    expect(result.recordCount).toBe(1);
  });

  it('rejects a truncated catalogue as a partial failure instead of demoting knownExploited', async () => {
    const result = await new KevSource(fetchStub(kevCatalogue(3))).enrich([
      'CVE-2022-0543',
      'CVE-2025-49844',
    ]);

    expect(result.entries).toEqual([]);
    expect(result.recordCount).toBe(0);
    expect(result.partialFailures).toHaveLength(1);
    expect(result.partialFailures?.[0]).toContain('sanity floor');
  });

  it('rejects an entirely empty catalogue rather than grading it ok', async () => {
    const result = await new KevSource(fetchStub({ vulnerabilities: [] })).enrich([
      'CVE-2022-0543',
    ]);

    expect(result.partialFailures).toHaveLength(1);
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

  it('never lets a malformed id truncate the query string for the rest of its batch', async () => {
    const stub = fetchStub(EPSS_BODY);
    await new EpssSource(stub).enrich(['CVE-2022-0543', 'CVE-2026-21863#anchor', 'CVE-2026-21864']);
    const url = String(stub.mock.calls[0][0]);

    expect(stub).toHaveBeenCalledTimes(1);
    expect(url).toContain('CVE-2022-0543');
    expect(url).toContain('CVE-2026-21864');
    expect(url).not.toContain('#');
    expect(url).not.toContain('21863');
  });

  it('records the dropped ids as a partial failure rather than reporting a clean batch', async () => {
    const stub = fetchStub(EPSS_BODY);
    const result = await new EpssSource(stub).enrich(['CVE-2022-0543', 'not-a-cve']);

    expect(result.partialFailures).toHaveLength(1);
    expect(result.partialFailures?.[0]).toContain('malformed CVE id');
  });

  it('makes no request at all when every id is malformed', async () => {
    const stub = fetchStub(EPSS_BODY);
    const result = await new EpssSource(stub).enrich(['../../etc/passwd', 'CVE-20-1']);

    expect(stub).not.toHaveBeenCalled();
    expect(result.partialFailures).toHaveLength(1);
  });
});
