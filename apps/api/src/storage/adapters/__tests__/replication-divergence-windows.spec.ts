import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { MemoryAdapter } from '../memory.adapter';
import { SqliteAdapter } from '../sqlite.adapter';
import { PostgresAdapter } from '../postgres.adapter';
import type {
  StoragePort,
  StoredReplicationDivergenceWindow,
} from '../../../common/interfaces/storage-port.interface';

const POSTGRES_DSN =
  process.env.REPLICATION_DIVERGENCE_POSTGRES_TEST_DSN ??
  'postgres://betterdb:devpassword@localhost:5433/betterdb';

function isReachable(connectionString: string): boolean {
  const { hostname, port } = new URL(connectionString);
  const probe = `
    const socket = require('net').createConnection({ host: process.env.PROBE_HOST, port: Number(process.env.PROBE_PORT) });
    socket.setTimeout(1500);
    socket.on('connect', () => { socket.destroy(); process.exit(0); });
    socket.on('timeout', () => { socket.destroy(); process.exit(1); });
    socket.on('error', () => { process.exit(1); });
  `;
  try {
    execFileSync(process.execPath, ['-e', probe], {
      stdio: 'ignore',
      timeout: 3000,
      env: { ...process.env, PROBE_HOST: hostname, PROBE_PORT: port || '5432' },
    });
    return true;
  } catch {
    return false;
  }
}

type AdapterFactory = () => Promise<{ storage: StoragePort; cleanup: () => Promise<void> }>;

const postgresAdapters: Array<[string, AdapterFactory]> = isReachable(POSTGRES_DSN)
  ? [
      [
        'postgres',
        async () => {
          const schema = `repl_div_${randomUUID().replace(/-/g, '')}`;
          const storage = new PostgresAdapter({ connectionString: POSTGRES_DSN, schema });
          await storage.initialize();
          return {
            storage: storage as StoragePort,
            cleanup: async () => {
              await storage.close();
              const pool = new Pool({ connectionString: POSTGRES_DSN });
              try {
                await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
              } finally {
                await pool.end();
              }
            },
          };
        },
      ],
    ]
  : [];

const CONN = 'conn-a';
const A = '10.0.0.2:6379';
const B = '10.0.0.3:6379';

const win = (
  o: Partial<Omit<StoredReplicationDivergenceWindow, 'id' | 'connectionId'>> = {},
): Omit<StoredReplicationDivergenceWindow, 'id' | 'connectionId'> => ({
  replicaAddr: A,
  windowStart: 0,
  windowEnd: 30_000,
  gapBytes: 4 * 1024 * 1024,
  bytesPerSec: 524_288.5,
  secondsBehind: 8,
  ...o,
});

describe.each<[string, AdapterFactory]>([
  [
    'memory',
    async () => {
      const storage = new MemoryAdapter();
      await storage.initialize();
      return { storage: storage as StoragePort, cleanup: async () => storage.close() };
    },
  ],
  [
    'sqlite',
    async () => {
      const storage = new SqliteAdapter({ filepath: ':memory:' });
      await storage.initialize();
      return { storage: storage as unknown as StoragePort, cleanup: async () => storage.close() };
    },
  ],
  ...postgresAdapters,
])('%s adapter replication divergence windows', (_name, make) => {
  let storage: StoragePort;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ storage, cleanup } = await make());
  });

  afterEach(async () => {
    await cleanup();
  });

  it('round-trips windows scoped to a connection', async () => {
    await storage.saveReplicationDivergenceWindows([win()], CONN);
    await storage.saveReplicationDivergenceWindows([win({ gapBytes: 1 })], 'conn-b');

    const rows = await storage.getReplicationDivergenceWindows({
      connectionId: CONN,
      startTime: 0,
      endTime: 60_000,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      connectionId: CONN,
      replicaAddr: A,
      windowStart: 0,
      windowEnd: 30_000,
      gapBytes: 4 * 1024 * 1024,
      bytesPerSec: 524_288.5,
      secondsBehind: 8,
    });
    expect(typeof rows[0].id).toBe('string');
  });

  it('ignores a window that was already saved when a batch is retried', async () => {
    const batch = [win({ replicaAddr: A, windowStart: 1_000, windowEnd: 2_000 })];

    expect(await storage.saveReplicationDivergenceWindows(batch, CONN)).toBe(1);
    expect(await storage.saveReplicationDivergenceWindows(batch, CONN)).toBe(0);

    const stored = await storage.getReplicationDivergenceWindows({
      connectionId: CONN,
      startTime: 0,
      endTime: 10_000,
    });
    expect(stored).toHaveLength(1);
  });

  it('keeps a null write rate and seconds-behind as null', async () => {
    await storage.saveReplicationDivergenceWindows([win({ bytesPerSec: null, secondsBehind: null })], CONN);

    const [row] = await storage.getReplicationDivergenceWindows({
      connectionId: CONN,
      startTime: 0,
      endTime: 60_000,
    });

    expect(row.bytesPerSec).toBeNull();
    expect(row.secondsBehind).toBeNull();
  });

  it('filters by replica and time window and returns ascending by window end', async () => {
    await storage.saveReplicationDivergenceWindows(
      [
        win({ windowStart: 60_000, windowEnd: 90_000 }),
        win({ windowStart: 0, windowEnd: 30_000 }),
        win({ windowStart: 30_000, windowEnd: 60_000 }),
        win({ replicaAddr: B, windowEnd: 60_000 }),
      ],
      CONN,
    );

    const ranged = await storage.getReplicationDivergenceWindows({
      connectionId: CONN,
      replicaAddr: A,
      startTime: 30_000,
      endTime: 60_000,
    });
    expect(ranged.map((r) => r.windowEnd)).toEqual([30_000, 60_000]);

    const all = await storage.getReplicationDivergenceWindows({
      connectionId: CONN,
      startTime: 0,
      endTime: 90_000,
    });
    expect(all.map((r) => r.windowEnd)).toEqual([30_000, 60_000, 60_000, 90_000]);
  });

  it('applies the limit per replica, keeping the newest windows', async () => {
    await storage.saveReplicationDivergenceWindows(
      [
        win({ windowEnd: 30_000 }),
        win({ windowEnd: 60_000 }),
        win({ windowEnd: 90_000 }),
        win({ replicaAddr: B, windowEnd: 30_000 }),
      ],
      CONN,
    );

    const rows = await storage.getReplicationDivergenceWindows({
      connectionId: CONN,
      startTime: 0,
      endTime: 90_000,
      limit: 2,
    });

    expect(rows.map((r) => [r.replicaAddr, r.windowEnd])).toEqual([
      [B, 30_000],
      [A, 60_000],
      [A, 90_000],
    ]);
  });

  it('prunes by window end, optionally scoped to a connection', async () => {
    await storage.saveReplicationDivergenceWindows(
      [win({ windowEnd: 10_000 }), win({ windowEnd: 50_000 })],
      CONN,
    );
    await storage.saveReplicationDivergenceWindows([win({ windowEnd: 10_000 })], 'conn-b');

    expect(await storage.pruneOldReplicationDivergenceWindows(20_000, CONN)).toBe(1);
    expect(
      await storage.getReplicationDivergenceWindows({ connectionId: 'conn-b', startTime: 0, endTime: 60_000 }),
    ).toHaveLength(1);

    expect(await storage.pruneOldReplicationDivergenceWindows(20_000)).toBe(1);
    expect(
      await storage.getReplicationDivergenceWindows({ connectionId: CONN, startTime: 0, endTime: 60_000 }),
    ).toHaveLength(1);
  });
});
