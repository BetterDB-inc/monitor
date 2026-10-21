import { unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { StoragePort } from '../../../common/interfaces/storage-port.interface';
import { MemoryAdapter } from '../memory.adapter';
import { SqliteAdapter } from '../sqlite.adapter';
import {
  BATCH_MS,
  CONNECTIONS,
  PEAK_CASES,
  STATS_RANGES,
  T0,
  buildFixture,
  peakRollups,
  referenceStats,
  rollup,
  seedFixture,
  type FixtureRow,
} from './client-analytics-rollups.fixture';

const BUCKET = 300_000;

interface Harness {
  storage: StoragePort;
  cleanup: () => Promise<void>;
}

async function memoryHarness(): Promise<Harness> {
  const storage = new MemoryAdapter();
  await storage.initialize();
  return { storage, cleanup: () => storage.close() };
}

async function sqliteHarness(): Promise<Harness> {
  const path = join(tmpdir(), `client-analytics-rollups-${Date.now()}-${Math.random()}.db`);
  const storage = new SqliteAdapter({ filepath: path });
  await storage.initialize();
  return {
    storage,
    cleanup: async () => {
      await storage.close();
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          unlinkSync(path + suffix);
        } catch {
          // already gone
        }
      }
    },
  };
}

function client(capturedAt: number, overrides: Partial<FixtureRow> = {}): FixtureRow {
  return {
    clientId: `c-${Math.random()}`,
    addr: '10.1.1.1:5000',
    name: 'api',
    user: 'default',
    db: 0,
    cmd: 'get',
    age: 10,
    idle: 0,
    flags: 'N',
    sub: 0,
    psub: 0,
    qbuf: 0,
    qbufFree: 0,
    obl: 0,
    oll: 0,
    omem: 0,
    capturedAt,
    sourceHost: 'localhost',
    sourcePort: 6379,
    connectionId: 'conn-x',
    ...overrides,
  };
}

async function save(storage: StoragePort, rows: FixtureRow[], connectionId = 'conn-x') {
  await storage.saveClientSnapshot(
    rows.map((r) => ({ ...r, id: 0 })),
    connectionId,
  );
}

describe.each([
  ['MemoryAdapter', memoryHarness],
  ['SqliteAdapter', sqliteHarness],
])('%s client analytics rollups', (_label, makeHarness) => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
  });

  afterEach(async () => {
    await h.cleanup();
  });

  describe('getClientSnapshotBounds', () => {
    it('is null for a connection with no rows', async () => {
      await save(h.storage, [client(1_000)], 'other');
      expect(await h.storage.getClientSnapshotBounds('conn-x')).toBeNull();
    });

    it('returns min and max captured_at for that connection only', async () => {
      await save(h.storage, [client(2_000), client(5_000), client(3_000)]);
      await save(h.storage, [client(1_000), client(9_000)], 'other');
      expect(await h.storage.getClientSnapshotBounds('conn-x')).toEqual({ earliest: 2_000, latest: 5_000 });
    });
  });

  describe('getClientSnapshotGroups', () => {
    it('is exclusive at the start and inclusive at the end', async () => {
      await save(h.storage, [client(1_000), client(2_000), client(3_000), client(4_000)]);
      const groups = await h.storage.getClientSnapshotGroups('conn-x', 1_000, 3_000);
      expect(groups.map((g) => g.capturedAt)).toEqual([2_000, 3_000]);
    });

    it('scopes to the connection', async () => {
      await save(h.storage, [client(2_000)]);
      await save(h.storage, [client(2_000), client(2_000)], 'other');
      const groups = await h.storage.getClientSnapshotGroups('conn-x', 0, 10_000);
      expect(groups).toEqual([
        { capturedAt: 2_000, name: 'api', user: 'default', ip: '10.1.1.1', count: 1, ageSum: 10 },
      ]);
    });

    it('groups by ip with the port stripped and keeps a colon-free addr whole', async () => {
      await save(h.storage, [
        client(2_000, { addr: '10.1.1.1:5000', age: 3 }),
        client(2_000, { addr: '10.1.1.1:6000', age: 4 }),
        client(2_000, { addr: '/tmp/valkey.sock', age: 5 }),
      ]);
      const groups = await h.storage.getClientSnapshotGroups('conn-x', 0, 10_000);
      expect(groups).toEqual([
        { capturedAt: 2_000, name: 'api', user: 'default', ip: '/tmp/valkey.sock', count: 1, ageSum: 5 },
        { capturedAt: 2_000, name: 'api', user: 'default', ip: '10.1.1.1', count: 2, ageSum: 7 },
      ]);
    });

    it('normalises empty name and user to empty strings', async () => {
      await save(h.storage, [client(2_000, { name: '', user: '' })]);
      const groups = await h.storage.getClientSnapshotGroups('conn-x', 0, 10_000);
      expect(groups).toEqual([
        { capturedAt: 2_000, name: '', user: '', ip: '10.1.1.1', count: 1, ageSum: 10 },
      ]);
    });

    it('orders by captured_at, then name, user and ip', async () => {
      await save(h.storage, [
        client(3_000, { name: 'b' }),
        client(1_000, { name: 'z' }),
        client(3_000, { name: 'a', user: 'u2' }),
        client(3_000, { name: 'a', user: 'u1', addr: '10.0.0.9:1' }),
        client(3_000, { name: 'a', user: 'u1', addr: '10.0.0.1:1' }),
        client(2_000, { name: 'm' }),
      ]);
      const groups = await h.storage.getClientSnapshotGroups('conn-x', 0, 10_000);
      expect(groups.map((g) => [g.capturedAt, g.name, g.user, g.ip])).toEqual([
        [1_000, 'z', 'default', '10.1.1.1'],
        [2_000, 'm', 'default', '10.1.1.1'],
        [3_000, 'a', 'u1', '10.0.0.1'],
        [3_000, 'a', 'u1', '10.0.0.9'],
        [3_000, 'a', 'u2', '10.1.1.1'],
        [3_000, 'b', 'default', '10.1.1.1'],
      ]);
    });
  });

  describe('rollup rows', () => {
    it('round-trips every field, JSON included', async () => {
      const row = rollup('conn-a', 10 * BUCKET);
      await h.storage.upsertClientAnalyticsRollups([row]);
      expect(await h.storage.getClientAnalyticsRollups(0, 100 * BUCKET)).toEqual([row]);
    });

    it('replaces a bucket row on conflict', async () => {
      await h.storage.upsertClientAnalyticsRollups([rollup('conn-a', BUCKET)]);
      const replacement = rollup('conn-a', BUCKET, {
        rowCount: 99,
        byName: {},
        byUser: { app: { last: 1, peak: 2 } },
        byUserAndName: {},
        ips: [],
        updatedAt: 5,
      });
      await h.storage.upsertClientAnalyticsRollups([replacement]);
      expect(await h.storage.getClientAnalyticsRollups(0, 10 * BUCKET)).toEqual([replacement]);
    });

    it('accepts an empty batch', async () => {
      await h.storage.upsertClientAnalyticsRollups([]);
      expect(await h.storage.getClientAnalyticsRollups(0, Number.MAX_SAFE_INTEGER)).toEqual([]);
    });

    it('reads an inclusive bucket range ordered by bucket then connection, optionally filtered', async () => {
      await h.storage.upsertClientAnalyticsRollups([
        rollup('conn-b', 2 * BUCKET),
        rollup('conn-a', 3 * BUCKET),
        rollup('conn-a', 2 * BUCKET),
        rollup('conn-b', 1 * BUCKET),
        rollup('conn-a', 4 * BUCKET),
      ]);
      const all = await h.storage.getClientAnalyticsRollups(2 * BUCKET, 3 * BUCKET);
      expect(all.map((r) => [r.bucketStart, r.connectionId])).toEqual([
        [2 * BUCKET, 'conn-a'],
        [2 * BUCKET, 'conn-b'],
        [3 * BUCKET, 'conn-a'],
      ]);
      const onlyB = await h.storage.getClientAnalyticsRollups(0, 10 * BUCKET, 'conn-b');
      expect(onlyB.map((r) => r.bucketStart)).toEqual([BUCKET, 2 * BUCKET]);
    });

    it('reports watermark and floor per connection, null when none', async () => {
      expect(await h.storage.getClientAnalyticsRollupWatermark('conn-a')).toBeNull();
      expect(await h.storage.getClientAnalyticsRollupFloor('conn-a')).toBeNull();
      await h.storage.upsertClientAnalyticsRollups([
        rollup('conn-a', 2 * BUCKET, { lastCapturedAt: 2 * BUCKET + 7 }),
        rollup('conn-a', 5 * BUCKET, { lastCapturedAt: 5 * BUCKET + 9 }),
        rollup('conn-b', 1 * BUCKET, { lastCapturedAt: 9 * BUCKET }),
      ]);
      expect(await h.storage.getClientAnalyticsRollupWatermark('conn-a')).toBe(5 * BUCKET + 9);
      expect(await h.storage.getClientAnalyticsRollupFloor('conn-a')).toBe(2 * BUCKET);
      expect(await h.storage.getClientAnalyticsRollupFloor('conn-b')).toBe(BUCKET);
    });

    it('prunes buckets strictly older than the cutoff, optionally per connection', async () => {
      await h.storage.upsertClientAnalyticsRollups([
        rollup('conn-a', 1 * BUCKET),
        rollup('conn-a', 2 * BUCKET),
        rollup('conn-a', 3 * BUCKET),
        rollup('conn-b', 1 * BUCKET),
        rollup('conn-b', 3 * BUCKET),
      ]);
      expect(await h.storage.pruneOldClientAnalyticsRollups(3 * BUCKET, 'conn-a')).toBe(2);
      expect(
        (await h.storage.getClientAnalyticsRollups(0, 10 * BUCKET)).map((r) => [r.connectionId, r.bucketStart]),
      ).toEqual([
        ['conn-b', BUCKET],
        ['conn-a', 3 * BUCKET],
        ['conn-b', 3 * BUCKET],
      ]);
      expect(await h.storage.pruneOldClientAnalyticsRollups(10 * BUCKET)).toBe(3);
      expect(await h.storage.getClientAnalyticsRollups(0, 10 * BUCKET)).toEqual([]);
    });
  });

  describe('getClientAnalyticsRollupPeak', () => {
    beforeEach(async () => {
      await h.storage.upsertClientAnalyticsRollups(peakRollups());
    });

    for (const [label, connectionId, sinceBucket, expected] of PEAK_CASES) {
      it(`returns the largest peak since the cut-off (${label})`, async () => {
        const peak = await h.storage.getClientAnalyticsRollupPeak(connectionId, sinceBucket);
        expect(peak).toEqual(expected);
        if (peak) {
          expect(typeof peak.peak).toBe('number');
          expect(typeof peak.capturedAt).toBe('number');
        }
      });
    }

    it('is null before any rollup exists', async () => {
      await h.storage.pruneOldClientAnalyticsRollups(Number.MAX_SAFE_INTEGER);
      expect(await h.storage.getClientAnalyticsRollupPeak('conn-a', 0)).toBeNull();
    });
  });

  it('reports the client snapshot index as ready', async () => {
    expect(await h.storage.isClientSnapshotIndexReady()).toBe(true);
  });

  describe('getClientAnalyticsStats parity with the naive reference', () => {
    const rows = buildFixture();

    beforeEach(async () => {
      await seedFixture(h.storage, rows);
    });

    for (const [label, start, end] of STATS_RANGES) {
      it(`matches across all connections (${label})`, async () => {
        expect(await h.storage.getClientAnalyticsStats(start, end)).toEqual(referenceStats(rows, start, end));
      });

      for (const connectionId of CONNECTIONS) {
        it(`matches for ${connectionId} (${label})`, async () => {
          expect(await h.storage.getClientAnalyticsStats(start, end, connectionId)).toEqual(
            referenceStats(rows, start, end, connectionId),
          );
        });
      }
    }

    it('resolves a peak tie to the earliest batch', async () => {
      const stats = await h.storage.getClientAnalyticsStats(undefined, undefined, 'conn-b');
      expect(stats.peakConnections).toBe(12);
      expect(stats.peakTimestamp).toBe(T0 + 3 * BATCH_MS);
    });

    it('excludes empty names and users from the grouped maps', async () => {
      const stats = await h.storage.getClientAnalyticsStats();
      expect(Object.keys(stats.connectionsByName)).not.toContain('');
      expect(Object.keys(stats.connectionsByUser)).not.toContain('');
      for (const entry of Object.values(stats.connectionsByUserAndName)) {
        expect(entry.user).not.toBe('');
        expect(entry.name).not.toBe('');
      }
    });
  });
});

describe('SqliteAdapter client analytics specifics', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await sqliteHarness();
  });

  afterEach(async () => {
    await h.cleanup();
  });

  function db() {
    const handle = (h.storage as SqliteAdapter).getRawDatabaseHandle();
    if (handle.kind !== 'sqlite') throw new Error('expected a better-sqlite3 handle');
    return handle.db;
  }

  it('creates the composite and rollup indexes', () => {
    const names = (db().prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
      name: string;
    }[]).map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'idx_client_connection_captured',
        'idx_acl_connection_captured',
        'idx_client_rollups_bucket',
      ]),
    );
  });

  it('merges NULL and empty name/user into one empty group', async () => {
    await save(h.storage, [client(2_000, { name: '', user: '' })]);
    db()
      .prepare(
        `INSERT INTO client_snapshots (client_id, addr, name, user, db, age, idle, captured_at, source_host, source_port, connection_id)
         VALUES ('n', '10.1.1.1:1', NULL, NULL, 0, 30, 0, 2000, 'localhost', 6379, 'conn-x')`,
      )
      .run();
    expect(await h.storage.getClientSnapshotGroups('conn-x', 0, 10_000)).toEqual([
      { capturedAt: 2_000, name: '', user: '', ip: '10.1.1.1', count: 2, ageSum: 40 },
    ]);
    const stats = await h.storage.getClientAnalyticsStats(undefined, undefined, 'conn-x');
    expect(stats.uniqueClientNames).toBe(0);
    expect(stats.uniqueUsers).toBe(0);
    expect(stats.currentConnections).toBe(2);
  });
});

describe('cross-adapter identity (MemoryAdapter vs SqliteAdapter)', () => {
  const rows = buildFixture();
  let memory: Harness;
  let sqlite: Harness;

  beforeAll(async () => {
    memory = await memoryHarness();
    sqlite = await sqliteHarness();
    await seedFixture(memory.storage, rows);
    await seedFixture(sqlite.storage, rows);
  });

  afterAll(async () => {
    await memory.cleanup();
    await sqlite.cleanup();
  });

  const windows: Array<[number, number]> = [
    [0, Number.MAX_SAFE_INTEGER],
    [T0, T0 + 10 * BATCH_MS],
    [T0 + 3 * BATCH_MS - 1, T0 + 3 * BATCH_MS],
    [T0 + 50 * BATCH_MS, T0 + 60 * BATCH_MS],
  ];

  for (const connectionId of CONNECTIONS) {
    it(`returns identical groups and bounds for ${connectionId}`, async () => {
      expect(await sqlite.storage.getClientSnapshotBounds(connectionId)).toEqual(
        await memory.storage.getClientSnapshotBounds(connectionId),
      );
      for (const [start, end] of windows) {
        const expected = await memory.storage.getClientSnapshotGroups(connectionId, start, end);
        expect(await sqlite.storage.getClientSnapshotGroups(connectionId, start, end)).toEqual(expected);
      }
    });
  }

  it('returns identical rollup peaks', async () => {
    await memory.storage.upsertClientAnalyticsRollups(peakRollups());
    await sqlite.storage.upsertClientAnalyticsRollups(peakRollups());
    for (const [, connectionId, sinceBucket] of PEAK_CASES) {
      expect(await sqlite.storage.getClientAnalyticsRollupPeak(connectionId, sinceBucket)).toEqual(
        await memory.storage.getClientAnalyticsRollupPeak(connectionId, sinceBucket),
      );
    }
  });

  for (const [label, start, end] of STATS_RANGES) {
    it(`returns identical stats (${label})`, async () => {
      expect(await sqlite.storage.getClientAnalyticsStats(start, end)).toEqual(
        await memory.storage.getClientAnalyticsStats(start, end),
      );
      for (const connectionId of CONNECTIONS) {
        expect(await sqlite.storage.getClientAnalyticsStats(start, end, connectionId)).toEqual(
          await memory.storage.getClientAnalyticsStats(start, end, connectionId),
        );
      }
    });
  }
});
