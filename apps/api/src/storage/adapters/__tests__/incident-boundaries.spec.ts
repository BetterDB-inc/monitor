import { adapters, type AdapterFactory } from './anomaly-storage-adapters';
import type { StoragePort } from '../../../common/interfaces/storage-port.interface';

describe.each<[string, AdapterFactory]>(adapters)('incident boundaries (%s)', (_name, makeAdapter) => {
  let storage: StoragePort;
  let cleanup: () => Promise<void>;
  const row = (scopeId: string, startedAt: number, anomalyId: string) => ({
    scopeId,
    startedAt,
    anomalyId,
  });

  beforeEach(async () => {
    ({ storage, cleanup } = await makeAdapter());
  });

  afterEach(async () => {
    await cleanup();
  });

  it('stores a boundary once', async () => {
    expect(await storage.saveIncidentBoundaries([row('s1', 1000, 'a')])).toBe(1);
    expect(await storage.saveIncidentBoundaries([row('s1', 1000, 'a'), row('s1', 2000, 'b')])).toBe(1);

    expect(await storage.getIncidentBoundaries({ startTime: 0 })).toEqual([
      row('s1', 1000, 'a'),
      row('s1', 2000, 'b'),
    ]);
  });

  it('returns the window and the latest earlier boundary of each scope', async () => {
    await storage.saveIncidentBoundaries([
      row('s1', 100, 'old'),
      row('s1', 200, 'prior'),
      row('s1', 300, 'inside'),
      row('s1', 500, 'after'),
      row('s2', 150, 'other'),
    ]);

    const rows = await storage.getIncidentBoundaries({ startTime: 250, endTime: 400 });

    expect(rows).toEqual([row('s2', 150, 'other'), row('s1', 200, 'prior'), row('s1', 300, 'inside')]);
  });

  it('filters by scope', async () => {
    await storage.saveIncidentBoundaries([row('s1', 100, 'a'), row('s2', 100, 'b')]);

    expect(await storage.getIncidentBoundaries({ startTime: 0, scopeIds: ['s2'] })).toEqual([
      row('s2', 100, 'b'),
    ]);
    expect(await storage.getIncidentBoundaries({ startTime: 0, scopeIds: [] })).toEqual([]);
  });

  it('prunes boundaries older than the cutoff', async () => {
    await storage.saveIncidentBoundaries([row('s1', 100, 'a'), row('s1', 200, 'b')]);

    expect(await storage.pruneOldIncidentBoundaries(150)).toBe(1);

    expect(await storage.getIncidentBoundaries({ startTime: 0 })).toEqual([row('s1', 200, 'b')]);
  });
});
