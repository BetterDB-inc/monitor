import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SqliteAdapter } from '../sqlite.adapter';
import { MemoryAdapter } from '../memory.adapter';
import type { StoragePort, StoredMemorySnapshot } from '../../../common/interfaces/storage-port.interface';

const snapshot = (overrides: Partial<StoredMemorySnapshot> = {}): StoredMemorySnapshot => ({
  id: `snap-${Math.random()}`,
  timestamp: 1_000,
  usedMemory: 100,
  usedMemoryRss: 200,
  usedMemoryPeak: 300,
  memFragmentationRatio: 1.5,
  maxmemory: 1_000,
  allocatorFragRatio: 1.1,
  opsPerSec: 10,
  cpuSys: 0.5,
  cpuUser: 0.25,
  ioThreadedReads: 7,
  ioThreadedWrites: 8,
  ...overrides,
});

describe.each([
  ['memory', async () => {
    const storage = new MemoryAdapter();
    await storage.initialize();
    return { storage: storage as StoragePort, cleanup: async () => storage.close() };
  }],
  ['sqlite', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-cols-'));
    const storage = new SqliteAdapter({ filepath: path.join(dir, 'db.sqlite') });
    await storage.initialize();
    return {
      storage: storage as StoragePort,
      cleanup: async () => {
        await storage.close();
        fs.rmSync(dir, { recursive: true, force: true });
      },
    };
  }],
])('%s adapter capacity columns', (_name, make) => {
  let storage: StoragePort;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ storage, cleanup } = await make());
  });
  afterEach(async () => cleanup());

  it('round-trips connected clients, maxclients and total keys', async () => {
    await storage.saveMemorySnapshots(
      [snapshot({ connectedClients: 42, maxclients: 10_000, totalKeys: 1_234 })],
      'conn-a',
    );
    const [row] = await storage.getMemorySnapshots({ connectionId: 'conn-a' });
    expect(row.connectedClients).toBe(42);
    expect(row.maxclients).toBe(10_000);
    expect(row.totalKeys).toBe(1_234);
  });

  it('returns null when the capacity fields are absent', async () => {
    await storage.saveMemorySnapshots([snapshot()], 'conn-a');
    const [row] = await storage.getMemorySnapshots({ connectionId: 'conn-a' });
    expect(row.connectedClients ?? null).toBeNull();
    expect(row.maxclients ?? null).toBeNull();
    expect(row.totalKeys ?? null).toBeNull();
  });
});

describe('sqlite migration of an existing memory_snapshots table', () => {
  it('adds the capacity columns as nullable to a pre-existing table', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-cols-legacy-'));
    const file = path.join(dir, 'db.sqlite');
    const legacy = new Database(file);
    legacy.exec(`
      CREATE TABLE memory_snapshots (
        id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, used_memory INTEGER NOT NULL,
        used_memory_rss INTEGER, used_memory_peak INTEGER, mem_fragmentation_ratio REAL,
        maxmemory INTEGER NOT NULL DEFAULT 0, allocator_frag_ratio REAL DEFAULT 0,
        ops_per_sec INTEGER NOT NULL DEFAULT 0, cpu_sys REAL NOT NULL DEFAULT 0,
        cpu_user REAL NOT NULL DEFAULT 0, io_threaded_reads INTEGER DEFAULT 0,
        io_threaded_writes INTEGER DEFAULT 0, connection_id TEXT NOT NULL DEFAULT 'env-default'
      );
      INSERT INTO memory_snapshots (id, timestamp, used_memory, connection_id) VALUES ('old', 1, 5, 'conn-a');
    `);
    legacy.close();

    const storage = new SqliteAdapter({ filepath: file });
    await storage.initialize();
    const [row] = await storage.getMemorySnapshots({ connectionId: 'conn-a' });
    expect(row.id).toBe('old');
    expect(row.totalKeys ?? null).toBeNull();
    await storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
