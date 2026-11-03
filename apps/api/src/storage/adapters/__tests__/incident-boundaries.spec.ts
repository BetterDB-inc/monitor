import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { adapters, type AdapterFactory } from './anomaly-storage-adapters';
import { SqliteAdapter } from '../sqlite.adapter';
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

  it('keeps the metric and connection that began the incident', async () => {
    const anchored = { ...row('s1', 1000, 'a'), metricType: 'connections', connectionId: 'conn-a' };

    await storage.saveIncidentBoundaries([anchored, row('s1', 2000, 'b')]);

    const rows = await storage.getIncidentBoundaries({ startTime: 0 });
    expect(rows).toEqual([anchored, row('s1', 2000, 'b')]);
    expect(rows[1]).not.toHaveProperty('metricType');
    expect(rows[1]).not.toHaveProperty('connectionId');
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

describe('incident boundary anchor migration (sqlite)', () => {
  let dir: string;
  let filepath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'incident-boundaries-'));
    filepath = join(dir, 'legacy.db');
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('adds the anchor columns to a database from before them and keeps old rows readable', async () => {
    const db = new Database(filepath);
    db.exec(`
      CREATE TABLE incident_boundaries (
        scope_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        anomaly_id TEXT NOT NULL,
        PRIMARY KEY (scope_id, started_at, anomaly_id)
      );
      INSERT INTO incident_boundaries VALUES ('s1', 1000, 'old');
    `);
    db.close();

    const storage = new SqliteAdapter({ filepath });
    await storage.initialize();
    await storage.saveIncidentBoundaries([
      { scopeId: 's1', startedAt: 2000, anomalyId: 'new', metricType: 'connections', connectionId: 'conn-a' },
    ]);
    const rows = await storage.getIncidentBoundaries({ startTime: 0 });
    await storage.close();

    expect(rows).toEqual([
      { scopeId: 's1', startedAt: 1000, anomalyId: 'old' },
      { scopeId: 's1', startedAt: 2000, anomalyId: 'new', metricType: 'connections', connectionId: 'conn-a' },
    ]);
  });
});
