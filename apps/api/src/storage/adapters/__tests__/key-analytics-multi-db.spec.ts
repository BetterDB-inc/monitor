import { unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { HotKeyEntry, KeyPatternSnapshot } from '@betterdb/shared';
import { SqliteAdapter } from '../sqlite.adapter';

const CONN = 'conn-a';

function snapshot(over: Partial<KeyPatternSnapshot> & { id: string }): KeyPatternSnapshot {
  return {
    timestamp: 1_000,
    pattern: 'user:*',
    keyCount: 10,
    sampledKeyCount: 10,
    keysWithTtl: 0,
    keysExpiringSoon: 0,
    totalMemoryBytes: 100,
    avgMemoryBytes: 10,
    maxMemoryBytes: 20,
    ...over,
  };
}

function hotKey(over: Partial<HotKeyEntry> & { id: string }): HotKeyEntry {
  return {
    keyName: 'user:1',
    connectionId: CONN,
    capturedAt: 1_000,
    signalType: 'lfu',
    rank: 1,
    ...over,
  };
}

describe('SqliteAdapter key analytics per logical database', () => {
  let storage: SqliteAdapter;
  let path: string;

  beforeEach(async () => {
    path = join(tmpdir(), `key-analytics-multi-db-${Date.now()}-${Math.random()}.db`);
    storage = new SqliteAdapter({ filepath: path });
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
    try {
      unlinkSync(path);
    } catch {
      return;
    }
  });

  it('stores and returns the db of each pattern snapshot, defaulting to 0', async () => {
    await storage.saveKeyPatternSnapshots(
      [snapshot({ id: 's0' }), snapshot({ id: 's1', db: 1 })],
      CONN,
    );

    const rows = await storage.getKeyPatternSnapshots({ connectionId: CONN });

    expect(rows.map((row) => [row.id, row.db]).sort()).toEqual([
      ['s0', 0],
      ['s1', 1],
    ]);
  });

  it('filters pattern snapshots by db', async () => {
    await storage.saveKeyPatternSnapshots(
      [snapshot({ id: 's0', db: 0 }), snapshot({ id: 's1', db: 1 }), snapshot({ id: 's2', db: 1 , pattern: 'job:*' })],
      CONN,
    );

    const db1 = await storage.getKeyPatternSnapshots({ connectionId: CONN, db: 1 });

    expect(db1.map((row) => row.id).sort()).toEqual(['s1', 's2']);
  });

  it('aggregates the summary across databases per pattern, and scopes it when filtered', async () => {
    await storage.saveKeyPatternSnapshots(
      [
        snapshot({ id: 's0', db: 0, keyCount: 10, totalMemoryBytes: 100 }),
        snapshot({ id: 's1', db: 1, keyCount: 30, totalMemoryBytes: 300 }),
      ],
      CONN,
    );

    const all = await storage.getKeyAnalyticsSummary(undefined, undefined, CONN);
    expect(all?.totalKeys).toBe(40);
    expect(all?.totalPatterns).toBe(1);
    expect(all?.byPattern['user:*'].keyCount).toBe(40);
    expect(all?.byPattern['user:*'].memoryBytes).toBe(400);

    const db1 = await storage.getKeyAnalyticsSummary(undefined, undefined, CONN, 1);
    expect(db1?.totalKeys).toBe(30);
    expect(db1?.byPattern['user:*'].keyCount).toBe(30);
  });

  it('keeps a sibling database in the summary after a partial collection moved the pattern timestamp', async () => {
    // T1: full collection wrote user:* rows for db0 and db1. T2: db1's scan
    // failed, so the partial collection wrote only db0's row. The summary must
    // combine db0@T2 with db1@T1 instead of dropping db1 entirely.
    await storage.saveKeyPatternSnapshots(
      [
        snapshot({ id: 't1-db0', db: 0, timestamp: 1_000, keyCount: 10, totalMemoryBytes: 100 }),
        snapshot({ id: 't1-db1', db: 1, timestamp: 1_000, keyCount: 30, totalMemoryBytes: 300 }),
        snapshot({ id: 't2-db0', db: 0, timestamp: 2_000, keyCount: 12, totalMemoryBytes: 120 }),
      ],
      CONN,
    );

    const all = await storage.getKeyAnalyticsSummary(undefined, undefined, CONN);
    expect(all?.totalKeys).toBe(42); // 12 (db0 @ T2) + 30 (db1 @ T1)
    expect(all?.byPattern['user:*'].keyCount).toBe(42);

    const db1 = await storage.getKeyAnalyticsSummary(undefined, undefined, CONN, 1);
    expect(db1?.totalKeys).toBe(30);
  });

  it('applies the row limit per database, so a pattern-heavy db0 cannot hide its siblings', async () => {
    // Five db0 patterns and two db1 patterns, all in one collection. A global
    // limit of 3 with db0-first ordering would return only db0 rows; the
    // per-database limit returns 3 of db0's AND both of db1's.
    const rows: KeyPatternSnapshot[] = [];
    for (let i = 0; i < 5; i++) {
      rows.push(snapshot({ id: `db0-${i}`, db: 0, pattern: `a${i}:*` }));
    }
    rows.push(snapshot({ id: 'db1-0', db: 1, pattern: 'z0:*' }));
    rows.push(snapshot({ id: 'db1-1', db: 1, pattern: 'z1:*' }));
    await storage.saveKeyPatternSnapshots(rows, CONN);

    const result = await storage.getKeyPatternSnapshots({ connectionId: CONN, limit: 3 });

    const byDb = new Map<number, number>();
    for (const row of result) {
      byDb.set(row.db ?? 0, (byDb.get(row.db ?? 0) ?? 0) + 1);
    }
    expect(byDb.get(0)).toBe(3);
    expect(byDb.get(1)).toBe(2);

    // With a db filter the limit stays a plain global limit.
    const db0Only = await storage.getKeyPatternSnapshots({ connectionId: CONN, db: 0, limit: 3 });
    expect(db0Only).toHaveLength(3);
  });

  it('summarizes a keyspace with more patterns than the bind-parameter limit allows', async () => {
    // The old implementation expanded one (pattern = ? AND db = ? AND
    // timestamp = ?) OR-term per kept pair — 11k patterns means 33k bind
    // parameters, past SQLite's 32766 limit. The grouped-join keeps the
    // parameter count constant regardless of pattern count.
    const many: KeyPatternSnapshot[] = [];
    for (let i = 0; i < 11_000; i++) {
      many.push(snapshot({ id: `many-${i}`, pattern: `p${i}:*`, keyCount: 1, totalMemoryBytes: 1 }));
    }
    await storage.saveKeyPatternSnapshots(many, CONN);

    const summary = await storage.getKeyAnalyticsSummary(undefined, undefined, CONN);

    expect(summary?.totalPatterns).toBe(11_000);
    expect(summary?.totalKeys).toBe(11_000);
  });

  it('aggregates trends per timestamp across databases and respects the db filter', async () => {
    await storage.saveKeyPatternSnapshots(
      [
        snapshot({ id: 's0', db: 0, keyCount: 10 }),
        snapshot({ id: 's1', db: 1, keyCount: 30 }),
      ],
      CONN,
    );

    const all = await storage.getKeyPatternTrends('user:*', 0, 2_000, CONN);
    expect(all).toEqual([{ timestamp: 1_000, keyCount: 40, memoryBytes: 200, staleCount: 0 }]);

    const db1 = await storage.getKeyPatternTrends('user:*', 0, 2_000, CONN, 1);
    expect(db1).toEqual([{ timestamp: 1_000, keyCount: 30, memoryBytes: 100, staleCount: 0 }]);
  });

  it('orders tied timestamps deterministically and limits per database, never truncating a db away', async () => {
    // One collection across 2 dbs x 2 patterns writes 4 rows at the same
    // timestamp. The limit applies per database (so db1 cannot be truncated
    // away by db0's rows) and ties keep a stable (db ASC, pattern ASC) order
    // rather than whatever order SQLite happens to return them in.
    await storage.saveKeyPatternSnapshots(
      [
        snapshot({ id: 's-0-b', db: 0, pattern: 'b:*' }),
        snapshot({ id: 's-1-a', db: 1, pattern: 'a:*' }),
        snapshot({ id: 's-0-a', db: 0, pattern: 'a:*' }),
        snapshot({ id: 's-1-b', db: 1, pattern: 'b:*' }),
      ],
      CONN,
    );

    const page = await storage.getKeyPatternSnapshots({ connectionId: CONN, limit: 1 });

    expect(page.map((row) => [row.db, row.pattern])).toEqual([
      [0, 'a:*'],
      [1, 'a:*'],
    ]);
  });

  it('keeps trends from different connections as separate series when connectionId is not provided', async () => {
    await storage.saveKeyPatternSnapshots([snapshot({ id: 's0', keyCount: 10 })], CONN);
    await storage.saveKeyPatternSnapshots([snapshot({ id: 's1', keyCount: 30 })], 'conn-b');

    const unscoped = await storage.getKeyPatternTrends('user:*', 0, 2_000);

    expect(unscoped.map((row) => row.keyCount).sort((a, b) => a - b)).toEqual([10, 30]);
  });

  it('lists the distinct databases that have analytics data', async () => {
    await storage.saveKeyPatternSnapshots(
      [snapshot({ id: 's0', db: 0 }), snapshot({ id: 's1', db: 2 }), snapshot({ id: 's2', db: 2, pattern: 'job:*' })],
      CONN,
    );
    await storage.saveKeyPatternSnapshots([snapshot({ id: 'other', db: 5 })], 'conn-b');

    expect(await storage.getKeyAnalyticsDatabases(CONN)).toEqual([0, 2]);
    expect(await storage.getKeyAnalyticsDatabases()).toEqual([0, 2, 5]);
  });

  it('stores and filters hot keys by db, including the latest-snapshot pin', async () => {
    await storage.saveHotKeys(
      [
        hotKey({ id: 'h0', db: 0, keyName: 'user:1' }),
        hotKey({ id: 'h1', db: 1, keyName: 'user:1' }),
        hotKey({ id: 'h2', db: 1, keyName: 'user:2', capturedAt: 2_000 }),
      ],
      CONN,
    );

    const db1 = await storage.getHotKeys({ connectionId: CONN, db: 1 });
    expect(db1.map((entry) => entry.id).sort()).toEqual(['h1', 'h2']);
    expect(db1.every((entry) => entry.db === 1)).toBe(true);

    // latest pin with a db filter looks at that db's newest capture only.
    const latestDb0 = await storage.getHotKeys({ connectionId: CONN, db: 0, latest: true });
    expect(latestDb0.map((entry) => entry.id)).toEqual(['h0']);
  });
});
