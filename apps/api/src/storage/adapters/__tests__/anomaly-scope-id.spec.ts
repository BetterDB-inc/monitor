import { randomUUID } from 'crypto';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { adapters, type AdapterFactory } from './anomaly-storage-adapters';
import { SqliteAdapter } from '../sqlite.adapter';
import type {
  StoragePort,
  StoredAnomalyEvent,
  StoredCorrelatedGroup,
} from '../../../common/interfaces/storage-port.interface';

const event = (overrides: Partial<StoredAnomalyEvent> = {}): StoredAnomalyEvent => ({
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
  ...overrides,
});

const group = (overrides: Partial<StoredCorrelatedGroup> = {}): StoredCorrelatedGroup => ({
  correlationId: randomUUID(),
  timestamp: 1000,
  pattern: 'memory_pressure',
  severity: 'warning',
  diagnosis: 'd',
  recommendations: [],
  anomalyCount: 1,
  metricTypes: ['connections'],
  ...overrides,
});

describe.each<[string, AdapterFactory]>(adapters)('anomaly scope id (%s)', (_name, makeAdapter) => {
  let storage: StoragePort;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ storage, cleanup } = await makeAdapter());
  });

  afterEach(async () => {
    await cleanup();
  });

  it('round-trips the scope id on events and groups', async () => {
    const saved = event({ scopeId: 'seed-1' });
    const batch = event({ scopeId: 'seed-1', timestamp: 1001 });
    const stored = group({ scopeId: 'seed-1' });
    await storage.saveAnomalyEvent(saved, 'node-1');
    await storage.saveAnomalyEvents([batch], 'node-1');
    await storage.saveCorrelatedGroup(stored, 'node-1');

    const events = await storage.getAnomalyEvents({ connectionId: 'node-1' });
    const groups = await storage.getCorrelatedGroups({ connectionId: 'node-1' });

    expect(events.map((e) => e.scopeId)).toEqual(['seed-1', 'seed-1']);
    expect(groups.map((g) => g.scopeId)).toEqual(['seed-1']);
  });

  it('finds a removed member by the scope id it was stored under', async () => {
    const removed = event({ scopeId: 'seed-1' });
    const unrelated = event({ scopeId: 'seed-2' });
    await storage.saveAnomalyEvent(removed, 'removed-node');
    await storage.saveAnomalyEvent(unrelated, 'other-node');

    const rows = await storage.getAnomalyEvents({
      scope: { id: 'seed-1', connectionIds: ['node-1'] },
    });

    expect(rows.map((e) => e.id)).toEqual([removed.id]);
  });

  it('finds rows saved before the scope existed through the current members', async () => {
    const legacy = event();
    const legacyGroup = group();
    await storage.saveAnomalyEvent(legacy, 'node-1');
    await storage.saveCorrelatedGroup(legacyGroup, 'node-1');
    const scope = { id: 'seed-1', connectionIds: ['node-1'] };

    const events = await storage.getAnomalyEvents({ scope });
    const groups = await storage.getCorrelatedGroups({ scope });

    expect(events.map((e) => e.id)).toEqual([legacy.id]);
    expect(events[0].scopeId).toBeUndefined();
    expect(groups.map((g) => g.correlationId)).toEqual([legacyGroup.correlationId]);
  });

  it('finds a removed member group by scope id and matches nothing else', async () => {
    const removed = group({ scopeId: 'seed-1' });
    await storage.saveCorrelatedGroup(removed, 'removed-node');
    await storage.saveCorrelatedGroup(group({ scopeId: 'seed-2' }), 'other-node');

    const found = await storage.getCorrelatedGroups({
      scope: { id: 'seed-1', connectionIds: [] },
    });
    const none = await storage.getCorrelatedGroups({
      scope: { id: 'seed-9', connectionIds: [] },
    });

    expect(found.map((g) => g.correlationId)).toEqual([removed.correlationId]);
    expect(none).toEqual([]);
  });

  it('keeps the original scope when a later save carries another one', async () => {
    const original = event({ scopeId: 'seed-1' });
    const stored = group({ scopeId: 'seed-1' });
    await storage.saveAnomalyEvent(original, 'node-1');
    await storage.saveAnomalyEvents([{ ...original, scopeId: 'seed-2' }], 'node-1');
    await storage.saveCorrelatedGroup(stored, 'node-1');
    await storage.saveCorrelatedGroup({ ...stored, scopeId: 'seed-2' }, 'node-1');

    const [row] = await storage.getAnomalyEvents({ connectionId: 'node-1' });
    const [storedGroup] = await storage.getCorrelatedGroups({ connectionId: 'node-1' });

    expect(row.scopeId).toBe('seed-1');
    expect(storedGroup.scopeId).toBe('seed-1');
  });

  it('fills the scope on a legacy row when it is saved again', async () => {
    const legacy = event();
    await storage.saveAnomalyEvent(legacy, 'node-1');
    await storage.saveAnomalyEvent({ ...legacy, scopeId: 'seed-1' }, 'node-1');

    const [row] = await storage.getAnomalyEvents({ connectionId: 'node-1' });

    expect(row.scopeId).toBe('seed-1');
  });
});

describe('anomaly scope id migration (sqlite)', () => {
  let dir: string;
  let filepath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'anomaly-scope-'));
    filepath = join(dir, 'legacy.db');
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('adds the column to a database from before it and keeps old rows readable', async () => {
    const first = new SqliteAdapter({ filepath });
    await first.initialize();
    const legacy = event();
    await first.saveAnomalyEvent(legacy, 'node-1');
    await first.close();

    const db = new Database(filepath);
    db.exec(`
      DROP INDEX idx_anomaly_events_scope;
      DROP INDEX idx_correlated_groups_scope;
      ALTER TABLE anomaly_events DROP COLUMN scope_id;
      ALTER TABLE correlated_anomaly_groups DROP COLUMN scope_id;
    `);
    db.close();

    const reopened = new SqliteAdapter({ filepath });
    await reopened.initialize();
    const rows = await reopened.getAnomalyEvents({
      scope: { id: 'seed-1', connectionIds: ['node-1'] },
    });
    await reopened.saveAnomalyEvent(event({ scopeId: 'seed-1' }), 'node-2');
    const scoped = await reopened.getAnomalyEvents({
      scope: { id: 'seed-1', connectionIds: [] },
    });
    await reopened.close();

    expect(rows.map((e) => e.id)).toEqual([legacy.id]);
    expect(rows[0].scopeId).toBeUndefined();
    expect(scoped).toHaveLength(1);
  });
});
