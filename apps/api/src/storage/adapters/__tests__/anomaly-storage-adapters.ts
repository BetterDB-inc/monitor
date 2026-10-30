import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { MemoryAdapter } from '../memory.adapter';
import { SqliteAdapter } from '../sqlite.adapter';
import { PostgresAdapter } from '../postgres.adapter';
import type { StoragePort } from '../../../common/interfaces/storage-port.interface';

const POSTGRES_DSN =
  process.env.ANOMALY_STORAGE_POSTGRES_TEST_DSN ??
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

export type AdapterFactory = () => Promise<{ storage: StoragePort; cleanup: () => Promise<void> }>;

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
          const schema = `anomaly_storage_${randomUUID().replace(/-/g, '')}`;
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

export const adapters: Array<[string, AdapterFactory]> = [
  ['MemoryAdapter', inProcess(() => new MemoryAdapter() as unknown as StoragePort)],
  [
    'SqliteAdapter',
    inProcess(() => new SqliteAdapter({ filepath: ':memory:' }) as unknown as StoragePort),
  ],
  ...postgresAdapters,
];
