import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { MemoryAdapter } from '../memory.adapter';
import { SqliteAdapter } from '../sqlite.adapter';
import { PostgresAdapter } from '../postgres.adapter';
import type {
  StoragePort,
  StoredCorrelatedGroup,
} from '../../../common/interfaces/storage-port.interface';

const POSTGRES_DSN =
  process.env.CORRELATED_GROUPS_POSTGRES_TEST_DSN ??
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

const inProcess =
  (make: () => StoragePort): AdapterFactory =>
  async () => {
    const storage = make();
    await storage.initialize();
    return { storage, cleanup: () => storage.close() };
  };

const postgresAdapters: Array<[string, AdapterFactory]> = isReachable(POSTGRES_DSN)
  ? [
      [
        'PostgresAdapter',
        async () => {
          const schema = `correlated_by_id_${randomUUID().replace(/-/g, '')}`;
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
  [
    'SqliteAdapter',
    inProcess(() => new SqliteAdapter({ filepath: ':memory:' }) as unknown as StoragePort),
  ],
  ...postgresAdapters,
])('getCorrelatedGroups by correlation id (%s)', (_name, makeAdapter) => {
  let storage: StoragePort;
  let cleanup: () => Promise<void>;
  const CONN = 'conn-a';
  const [ID1, ID2, ID3] = [randomUUID(), randomUUID(), randomUUID()];

  const group = (correlationId: string, timestamp: number): StoredCorrelatedGroup => ({
    correlationId,
    timestamp,
    pattern: 'memory_pressure',
    severity: 'warning',
    diagnosis: 'd',
    recommendations: [],
    anomalyCount: 1,
    metricTypes: ['connections'],
  });

  beforeEach(async () => {
    ({ storage, cleanup } = await makeAdapter());
    await storage.saveCorrelatedGroup(group(ID1, 1000), CONN);
    await storage.saveCorrelatedGroup(group(ID2, 2000), CONN);
    await storage.saveCorrelatedGroup(group(ID3, 3000), CONN);
  });

  afterEach(async () => {
    await cleanup();
  });

  it('returns only the requested groups', async () => {
    const rows = await storage.getCorrelatedGroups({
      connectionId: CONN,
      correlationIds: [ID1, ID3],
    });

    expect(rows.map((g) => g.correlationId)).toEqual([ID3, ID1]);
  });

  it('returns nothing for an empty id list', async () => {
    const rows = await storage.getCorrelatedGroups({ connectionId: CONN, correlationIds: [] });

    expect(rows).toEqual([]);
  });
});
