import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { SqliteAdapter } from '../sqlite.adapter';
import { MemoryAdapter } from '../memory.adapter';
import type {
  StoragePort,
  StoredCommandStatsSample,
  StoredMemorySnapshot,
} from '../../../common/interfaces/storage-port.interface';

const LEGACY_SCHEMA = `
  CREATE TABLE memory_snapshots (
    id TEXT PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    used_memory INTEGER NOT NULL,
    used_memory_rss INTEGER NOT NULL,
    used_memory_peak INTEGER NOT NULL,
    mem_fragmentation_ratio REAL NOT NULL,
    maxmemory INTEGER NOT NULL DEFAULT 0,
    allocator_frag_ratio REAL NOT NULL DEFAULT 0,
    ops_per_sec INTEGER NOT NULL DEFAULT 0,
    cpu_sys REAL NOT NULL DEFAULT 0,
    cpu_user REAL NOT NULL DEFAULT 0,
    io_threaded_reads INTEGER NOT NULL DEFAULT 0,
    io_threaded_writes INTEGER NOT NULL DEFAULT 0,
    connection_id TEXT NOT NULL DEFAULT 'env-default'
  );
  CREATE INDEX idx_memory_snap_timestamp ON memory_snapshots(timestamp DESC);
  CREATE INDEX idx_memory_snap_connection_id ON memory_snapshots(connection_id);

  CREATE TABLE command_stats_samples (
    id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL,
    command TEXT NOT NULL,
    calls_total INTEGER NOT NULL DEFAULT 0,
    usec_total INTEGER NOT NULL DEFAULT 0,
    usec_per_call REAL NOT NULL DEFAULT 0,
    rejected_calls INTEGER NOT NULL DEFAULT 0,
    failed_calls INTEGER NOT NULL DEFAULT 0,
    calls_delta INTEGER NOT NULL,
    usec_delta INTEGER NOT NULL,
    interval_ms INTEGER NOT NULL,
    captured_at INTEGER NOT NULL
  );
  CREATE INDEX idx_cmdstat_captured_at
    ON command_stats_samples(connection_id, command, captured_at);
  CREATE INDEX idx_cmdstat_captured_at_global
    ON command_stats_samples(captured_at);

  INSERT INTO memory_snapshots VALUES
    ('snap-1', 1000, 100, 200, 300, 1.5, 0, 1.1, 10, 0.5, 0.25, 7, 8, 'conn-a');
  INSERT INTO command_stats_samples VALUES
    ('cs-1', 'conn-a', 'get', 50, 500, 10.0, 1, 2, 5, 50, 60000, 2000);
`;

const MEMORY_NULLABLE = [
  'used_memory_rss',
  'used_memory_peak',
  'mem_fragmentation_ratio',
  'allocator_frag_ratio',
  'io_threaded_reads',
  'io_threaded_writes',
];

const COMMAND_STATS_NULLABLE = [
  'usec_total',
  'usec_per_call',
  'rejected_calls',
  'failed_calls',
  'usec_delta',
];

function rawDb(adapter: SqliteAdapter): Database.Database {
  return (adapter as unknown as { db: Database.Database }).db;
}

function notNullColumns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; notnull: number }[])
    .filter((c) => c.notnull === 1)
    .map((c) => c.name);
}

function indexNames(db: Database.Database, table: string): string[] {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?`)
      .all(table) as { name: string }[]
  ).map((r) => r.name);
}

const pushedSnapshot = (): StoredMemorySnapshot => ({
  id: randomUUID(),
  timestamp: 5000,
  usedMemory: 1024,
  usedMemoryRss: null,
  usedMemoryPeak: null,
  memFragmentationRatio: null,
  maxmemory: 0,
  allocatorFragRatio: null,
  opsPerSec: 3,
  cpuSys: 0,
  cpuUser: 0,
  ioThreadedReads: null,
  ioThreadedWrites: null,
});

const pushedSample = (): Omit<StoredCommandStatsSample, 'id' | 'connectionId'> => ({
  command: 'get',
  callsTotal: 80,
  usecTotal: null,
  usecPerCall: null,
  rejectedCalls: null,
  failedCalls: null,
  callsDelta: 30,
  usecDelta: null,
  intervalMs: 60_000,
  capturedAt: 6000,
});

describe('nullable pushed metrics — sqlite upgrade from NOT NULL columns', () => {
  let dbPath: string;
  let adapter: SqliteAdapter;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `nullable-metrics-${randomUUID()}.db`);
    const legacy = new Database(dbPath);
    legacy.exec(LEGACY_SCHEMA);
    legacy.close();
  });

  afterEach(async () => {
    await adapter?.close();
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(dbPath + suffix)) {
        fs.unlinkSync(dbPath + suffix);
      }
    }
  });

  it('drops NOT NULL from the pushed memory and commandstats columns', async () => {
    adapter = new SqliteAdapter({ filepath: dbPath });
    await adapter.initialize();

    const db = rawDb(adapter);
    const memoryNotNull = notNullColumns(db, 'memory_snapshots');
    const statsNotNull = notNullColumns(db, 'command_stats_samples');
    for (const column of MEMORY_NULLABLE) {
      expect(memoryNotNull).not.toContain(column);
    }
    for (const column of COMMAND_STATS_NULLABLE) {
      expect(statsNotNull).not.toContain(column);
    }
    expect(memoryNotNull).toEqual(
      expect.arrayContaining(['timestamp', 'used_memory', 'maxmemory', 'ops_per_sec', 'connection_id']),
    );
    expect(statsNotNull).toEqual(
      expect.arrayContaining(['connection_id', 'command', 'calls_total', 'calls_delta', 'captured_at']),
    );
  });

  it('preserves existing rows across the rebuild', async () => {
    adapter = new SqliteAdapter({ filepath: dbPath });
    await adapter.initialize();

    const snapshots = await adapter.getMemorySnapshots({ connectionId: 'conn-a' });
    expect(snapshots).toEqual([
      {
        id: 'snap-1',
        timestamp: 1000,
        usedMemory: 100,
        usedMemoryRss: 200,
        usedMemoryPeak: 300,
        memFragmentationRatio: 1.5,
        maxmemory: 0,
        allocatorFragRatio: 1.1,
        opsPerSec: 10,
        cpuSys: 0.5,
        cpuUser: 0.25,
        ioThreadedReads: 7,
        ioThreadedWrites: 8,
        connectionId: 'conn-a',
      },
    ]);

    const history = await adapter.getCommandStatsHistory({
      connectionId: 'conn-a',
      command: 'get',
      startTime: 0,
      endTime: 10_000,
    });
    expect(history).toEqual([
      {
        id: 'cs-1',
        connectionId: 'conn-a',
        command: 'get',
        callsTotal: 50,
        usecTotal: 500,
        usecPerCall: 10,
        rejectedCalls: 1,
        failedCalls: 2,
        callsDelta: 5,
        usecDelta: 50,
        intervalMs: 60000,
        capturedAt: 2000,
      },
    ]);
  });

  it('recreates the table indexes', async () => {
    adapter = new SqliteAdapter({ filepath: dbPath });
    await adapter.initialize();

    const db = rawDb(adapter);
    expect(indexNames(db, 'memory_snapshots')).toEqual(
      expect.arrayContaining(['idx_memory_snap_timestamp', 'idx_memory_snap_connection_id']),
    );
    expect(indexNames(db, 'command_stats_samples')).toEqual(
      expect.arrayContaining(['idx_cmdstat_captured_at', 'idx_cmdstat_captured_at_global']),
    );
  });

  it('is idempotent across restarts and keeps rows written after the upgrade', async () => {
    adapter = new SqliteAdapter({ filepath: dbPath });
    await adapter.initialize();
    await adapter.saveMemorySnapshots([pushedSnapshot()], 'conn-a');
    await adapter.saveCommandStatsSamples([pushedSample()], 'conn-a');
    await adapter.close();

    adapter = new SqliteAdapter({ filepath: dbPath });
    await expect(adapter.initialize()).resolves.toBeUndefined();

    expect(await adapter.getMemorySnapshots({ connectionId: 'conn-a' })).toHaveLength(2);
    expect(
      await adapter.getCommandStatsHistory({
        connectionId: 'conn-a',
        command: 'get',
        startTime: 0,
        endTime: 10_000,
      }),
    ).toHaveLength(2);
    expect(rawDb(adapter).prepare(`SELECT name FROM sqlite_master WHERE name LIKE '%_rebuild'`).all()).toEqual([]);
  });
});

describe.each<[string, () => Promise<StoragePort & { close(): Promise<void> }>]>([
  ['memory', async () => {
    const adapter = new MemoryAdapter();
    await adapter.initialize();
    return adapter;
  }],
  ['sqlite', async () => {
    const adapter = new SqliteAdapter({ filepath: ':memory:' });
    await adapter.initialize();
    return adapter;
  }],
])('nullable pushed metrics — %s adapter round-trip', (_name, create) => {
  let storage: StoragePort & { close(): Promise<void> };

  beforeEach(async () => {
    storage = await create();
  });

  afterEach(async () => {
    await storage.close();
  });

  it('returns null for memory snapshot fields stored as null', async () => {
    const snapshot = pushedSnapshot();
    await storage.saveMemorySnapshots([snapshot], 'conn-x');

    const [stored] = await storage.getMemorySnapshots({ connectionId: 'conn-x' });
    expect(stored).toMatchObject({
      usedMemory: 1024,
      usedMemoryRss: null,
      usedMemoryPeak: null,
      memFragmentationRatio: null,
      allocatorFragRatio: null,
      ioThreadedReads: null,
      ioThreadedWrites: null,
    });
  });

  it('returns null for commandstats fields stored as null', async () => {
    await storage.saveCommandStatsSamples([pushedSample()], 'conn-x');

    const [stored] = await storage.getCommandStatsHistory({
      connectionId: 'conn-x',
      command: 'get',
      startTime: 0,
      endTime: 10_000,
    });
    expect(stored).toMatchObject({
      callsTotal: 80,
      callsDelta: 30,
      usecTotal: null,
      usecPerCall: null,
      rejectedCalls: null,
      failedCalls: null,
      usecDelta: null,
    });
  });
});
