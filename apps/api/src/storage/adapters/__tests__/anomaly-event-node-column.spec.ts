import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ClusterNodeRef } from '@betterdb/shared';
import { SqliteAdapter } from '../sqlite.adapter';
import type { StoredAnomalyEvent } from '../../../common/interfaces/storage-port.interface';

describe('SqliteAdapter anomaly event node column', () => {
  const CONN = 'conn-a';
  const NODE: ClusterNodeRef = { nodeId: 'node-a', address: '10.0.1.5:6379', role: 'primary', shardId: 'shard-1' };
  let dbPath: string;

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anomaly-node-'));
    dbPath = path.join(dir, 'anomaly.db');
  });

  afterEach(() => {
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  const event = (id: string, overrides: Partial<StoredAnomalyEvent> = {}): StoredAnomalyEvent => ({
    id,
    timestamp: 1_700_000_000_000,
    metricType: 'memory_used',
    anomalyType: 'spike',
    severity: 'warning',
    value: 900,
    baseline: 300,
    stdDev: 0,
    zScore: 0,
    threshold: 3,
    message: 'spike',
    resolved: false,
    ...overrides,
  });

  async function withAdapter<T>(run: (adapter: SqliteAdapter) => Promise<T>): Promise<T> {
    const adapter = new SqliteAdapter({ filepath: dbPath });
    await adapter.initialize();
    try {
      return await run(adapter);
    } finally {
      await adapter.close();
    }
  }

  const rawly = (sql: string, ...params: unknown[]) => {
    const db = new Database(dbPath);
    try {
      db.prepare(sql).run(...params);
    } finally {
      db.close();
    }
  };

  const nodeOf = async (id: string) =>
    withAdapter(async (adapter) => (await adapter.getAnomalyEvents({ connectionId: CONN })).find((r) => r.id === id));

  describe('on a database made before the column existed', () => {
    beforeEach(async () => {
      await withAdapter((adapter) => adapter.saveAnomalyEvents([event('old-1'), event('old-2')], CONN));
      rawly('ALTER TABLE anomaly_events DROP COLUMN node');
    });

    it('keeps the rows and reads them without a node', async () => {
      const rows = await withAdapter((adapter) => adapter.getAnomalyEvents({ connectionId: CONN }));

      expect(rows.map((r) => r.id).sort()).toEqual(['old-1', 'old-2']);
      expect(rows.every((r) => r.node === undefined)).toBe(true);
    });

    it('stores the node of a new event next to the old rows', async () => {
      await withAdapter((adapter) => adapter.saveAnomalyEvent(event('new-1', { node: NODE }), CONN));

      expect((await nodeOf('new-1'))?.node).toEqual(NODE);
      expect((await nodeOf('old-1'))?.node).toBeUndefined();
    });

    it('fills the node of an old row when the event is saved again with one', async () => {
      await withAdapter((adapter) => adapter.saveAnomalyEvent(event('old-1', { node: NODE }), CONN));

      expect((await nodeOf('old-1'))?.node).toEqual(NODE);
    });

    it('adds the column once and opens the database again unchanged', async () => {
      await withAdapter((adapter) => adapter.saveAnomalyEvent(event('new-1', { node: NODE }), CONN));

      expect((await nodeOf('new-1'))?.node).toEqual(NODE);
      expect((await nodeOf('new-1'))?.node).toEqual(NODE);
    });
  });

  describe('when the column holds something that is not a node', () => {
    it.each([
      ['the word null', 'null'],
      ['a number', '5'],
      ['a string', '"10.0.1.5:6379"'],
      ['a list', '[{"nodeId":"node-a","address":"10.0.1.5:6379","role":"primary"}]'],
      ['an object without an id', '{"address":"10.0.1.5:6379","role":"primary"}'],
      ['an object without an address', '{"nodeId":"node-a","role":"primary"}'],
      ['text that is not JSON', 'node-a'],
      ['an empty string', ''],
    ])('reads %s as no node', async (_name, stored) => {
      await withAdapter((adapter) => adapter.saveAnomalyEvent(event('odd-1', { node: NODE }), CONN));
      rawly('UPDATE anomaly_events SET node = ? WHERE id = ?', stored, 'odd-1');

      const row = await nodeOf('odd-1');

      expect(row).toBeDefined();
      expect(row?.node).toBeUndefined();
    });

    it('reads a node with a role it does not know as unknown', async () => {
      await withAdapter((adapter) => adapter.saveAnomalyEvent(event('odd-1', { node: NODE }), CONN));
      rawly(
        'UPDATE anomaly_events SET node = ? WHERE id = ?',
        '{"nodeId":"node-a","address":"10.0.1.5:6379","role":"master"}',
        'odd-1',
      );

      expect((await nodeOf('odd-1'))?.node).toEqual({ nodeId: 'node-a', address: '10.0.1.5:6379', role: 'unknown' });
    });
  });
});
