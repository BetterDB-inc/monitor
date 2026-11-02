import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { MemoryAdapter } from '../memory.adapter';
import { SqliteAdapter } from '../sqlite.adapter';
import { PostgresAdapter } from '../postgres.adapter';
import type { StoragePort, StoredAnomalyEvent } from '../../../common/interfaces/storage-port.interface';

describe.each([
  ['MemoryAdapter', () => new MemoryAdapter()],
  ['SqliteAdapter', () => new SqliteAdapter({ filepath: ':memory:' })],
])('resolveAnomaly idempotency (%s)', (_name, makeAdapter) => {
  let storage: StoragePort;
  const CONN = 'conn-a';

  const event = (id: string): StoredAnomalyEvent => ({
    id,
    timestamp: 1_700_000_000_000,
    metricType: 'dataset_keys',
    anomalyType: 'drop',
    severity: 'critical',
    value: 0,
    baseline: 100,
    stdDev: 0,
    zScore: 0,
    threshold: 0,
    message: 'CRITICAL: data loss',
    resolved: false,
  });

  beforeEach(async () => {
    storage = makeAdapter() as unknown as StoragePort;
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
  });

  it('returns true on first resolve and true again on re-resolve (idempotent)', async () => {
    await storage.saveAnomalyEvent(event('evt-1'), CONN);

    expect(await storage.resolveAnomaly('evt-1', 1_700_000_100_000)).toBe(true);
    // A retry / a second path resolving the same row must still report success,
    // so a group resolve isn't failed by an already-closed member.
    expect(await storage.resolveAnomaly('evt-1', 1_700_000_200_000)).toBe(true);

    const [stored] = await storage.getAnomalyEvents({ connectionId: CONN });
    expect(stored.resolved).toBe(true);
  });

  it('returns false only when no anomaly with that id exists', async () => {
    expect(await storage.resolveAnomaly('does-not-exist', 1_700_000_100_000)).toBe(false);
  });

});

const POSTGRES_DSN =
  process.env.RESOLVE_ANOMALY_POSTGRES_TEST_DSN ?? 'postgres://betterdb:devpassword@localhost:5433/betterdb';

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

const inProcess = (make: () => StoragePort): AdapterFactory => async () => {
  const storage = make();
  await storage.initialize();
  return { storage, cleanup: () => storage.close() };
};

const postgresAdapters: Array<[string, AdapterFactory]> = isReachable(POSTGRES_DSN)
  ? [
      [
        'PostgresAdapter',
        async () => {
          const schema = `resolve_open_${randomUUID().replace(/-/g, '')}`;
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

describe.each<[string, AdapterFactory]>([
  ['MemoryAdapter', inProcess(() => new MemoryAdapter() as unknown as StoragePort)],
  ['SqliteAdapter', inProcess(() => new SqliteAdapter({ filepath: ':memory:' }) as unknown as StoragePort)],
  ...postgresAdapters,
])('resolveOpenAnomaly (%s)', (_name, makeAdapter) => {
  let storage: StoragePort;
  let cleanup: () => Promise<void>;
  const CONN = 'conn-a';

  beforeEach(async () => {
    ({ storage, cleanup } = await makeAdapter());
  });

  afterEach(async () => {
    await cleanup();
  });

  it('reports only the call that resolved the row', async () => {
    const id = randomUUID();
    await storage.saveAnomalyEvent(
      {
        id,
        timestamp: 1_700_000_000_000,
        metricType: 'replication_divergence',
        anomalyType: 'spike',
        severity: 'warning',
        value: 0,
        baseline: 0,
        stdDev: 0,
        zScore: 0,
        threshold: 0,
        message: 'WARNING: Replica 10.0.0.2:6379 is 8.0 MiB behind the primary',
        resolved: false,
      },
      CONN,
    );

    expect(await storage.resolveOpenAnomaly(id, 1_700_000_100_000)).toBe(true);
    expect(await storage.resolveOpenAnomaly(id, 1_700_000_200_000)).toBe(false);
    expect(await storage.resolveOpenAnomaly(randomUUID(), 1_700_000_100_000)).toBe(false);

    const [stored] = await storage.getAnomalyEvents({ connectionId: CONN });
    expect(stored).toMatchObject({ resolved: true, resolvedAt: 1_700_000_100_000 });
  });
});
