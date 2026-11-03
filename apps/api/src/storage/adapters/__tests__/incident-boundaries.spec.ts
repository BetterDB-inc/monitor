import { randomUUID } from 'crypto';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { adapters, type AdapterFactory } from './anomaly-storage-adapters';
import { SqliteAdapter } from '../sqlite.adapter';
import { PostgresAdapter } from '../postgres.adapter';
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

const legacyEvent = (connectionId: string) => ({
  id: randomUUID(),
  timestamp: 1000,
  metricType: 'connections',
  anomalyType: 'spike',
  severity: 'warning',
  value: 10,
  baseline: 1,
  stdDev: 1,
  zScore: 9,
  threshold: 3,
  message: 'm',
  resolved: false,
  connectionId,
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

  it('fills the anchor of a boundary from before the columns from its stored event', async () => {
    const first = new SqliteAdapter({ filepath });
    await first.initialize();
    const anchor = legacyEvent('conn-a');
    await first.saveAnomalyEvent(anchor, 'conn-a');
    await first.saveIncidentBoundaries([
      { scopeId: 's1', startedAt: 1000, anomalyId: anchor.id },
      { scopeId: 's1', startedAt: 2000, anomalyId: 'pruned' },
    ]);
    await first.close();

    const db = new Database(filepath);
    db.exec(`
      ALTER TABLE incident_boundaries DROP COLUMN metric_type;
      ALTER TABLE incident_boundaries DROP COLUMN connection_id;
    `);
    db.close();

    const reopened = new SqliteAdapter({ filepath });
    await reopened.initialize();
    const rows = await reopened.getIncidentBoundaries({ startTime: 0 });
    await reopened.close();

    expect(rows).toEqual([
      { scopeId: 's1', startedAt: 1000, anomalyId: anchor.id, metricType: 'connections', connectionId: 'conn-a' },
      { scopeId: 's1', startedAt: 2000, anomalyId: 'pruned' },
    ]);
  });

  it('fills an anchor left empty by an upgrade that stopped after adding the columns', async () => {
    const first = new SqliteAdapter({ filepath });
    await first.initialize();
    const anchor = legacyEvent('conn-a');
    await first.saveAnomalyEvent(anchor, 'conn-a');
    await first.saveIncidentBoundaries([{ scopeId: 's1', startedAt: 1000, anomalyId: anchor.id }]);
    await first.close();

    const db = new Database(filepath);
    db.exec(`UPDATE incident_boundaries SET metric_type = NULL, connection_id = NULL`);
    db.close();

    const reopened = new SqliteAdapter({ filepath });
    await reopened.initialize();
    const rows = await reopened.getIncidentBoundaries({ startTime: 0 });
    await reopened.close();

    expect(rows).toEqual([
      { scopeId: 's1', startedAt: 1000, anomalyId: anchor.id, metricType: 'connections', connectionId: 'conn-a' },
    ]);
  });
});

const postgres = adapters.filter(([name]) => name === 'PostgresAdapter');

describe.each<[string, AdapterFactory]>(postgres)('incident boundary anchor migration (%s)', (_name, makeAdapter) => {
  let storage: StoragePort;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ storage, cleanup } = await makeAdapter());
  });

  afterEach(async () => {
    await cleanup();
  });

  it('fills the anchor of a boundary from before the columns from its stored event', async () => {
    const anchor = legacyEvent('conn-a');
    await storage.saveAnomalyEvent(anchor, 'conn-a');
    await storage.saveIncidentBoundaries([
      { scopeId: 's1', startedAt: 1000, anomalyId: anchor.id },
      { scopeId: 's1', startedAt: 2000, anomalyId: 'pruned' },
    ]);
    const internals = storage as unknown as {
      pool: { query: (sql: string) => Promise<unknown> };
      config: ConstructorParameters<typeof PostgresAdapter>[0];
    };
    await internals.pool.query(`
      ALTER TABLE incident_boundaries DROP COLUMN metric_type;
      ALTER TABLE incident_boundaries DROP COLUMN connection_id;
    `);

    const upgraded = new PostgresAdapter(internals.config);
    await upgraded.initialize();
    const rows = await upgraded.getIncidentBoundaries({ startTime: 0 });
    await upgraded.close();

    expect(rows).toEqual([
      { scopeId: 's1', startedAt: 1000, anomalyId: anchor.id, metricType: 'connections', connectionId: 'conn-a' },
      { scopeId: 's1', startedAt: 2000, anomalyId: 'pruned' },
    ]);
  });
});
