import { parseMembership } from '@betterdb/shared';

describe('parseMembership', () => {
  it('defaults a piece-1 row without source to cluster', () => {
    expect(parseMembership('{"seedId":"s","nodeId":"n","origin":"auto"}')).toEqual({ seedId: 's', nodeId: 'n', origin: 'auto', source: 'cluster' });
  });

  it('keeps sentinel source, group and role', () => {
    const raw = { seedId: 's', nodeId: 'n', origin: 'auto', source: 'sentinel', group: 'mymaster', role: 'primary', retiredAt: 5 };
    expect(parseMembership(raw)).toEqual(raw);
  });

  it('drops an unknown role and a non-string group', () => {
    expect(parseMembership({ seedId: 's', nodeId: 'n', origin: 'auto', source: 'sentinel', group: 3, role: 'leader' })).toEqual({ seedId: 's', nodeId: 'n', origin: 'auto', source: 'sentinel' });
  });

  it('keeps the announced hostname', () => {
    const raw = { seedId: 's', nodeId: 'n', origin: 'auto', source: 'cluster', hostname: 'node-1.cluster.local' };
    expect(parseMembership(JSON.stringify(raw))).toEqual(raw);
  });

  it('drops an empty or non-string hostname', () => {
    const base = { seedId: 's', nodeId: 'n', origin: 'auto', source: 'cluster' };
    expect(parseMembership({ ...base, hostname: '' })).toEqual(base);
    expect(parseMembership({ ...base, hostname: 7 })).toEqual(base);
  });

  it('rejects an unknown source', () => {
    expect(parseMembership({ seedId: 's', nodeId: 'n', origin: 'auto', source: 'otlp' })).toBeUndefined();
  });
});
