import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import * as os from 'os';
import * as path from 'path';
import type { DatabaseConnectionConfig } from '@betterdb/shared';
import { SqliteAdapter } from '../sqlite.adapter';
import { PostgresAdapter } from '../postgres.adapter';
import { adapters } from './anomaly-storage-adapters';
import { MemoryAdapter } from '../memory.adapter';
import { loadBetterSqlite3 } from '../better-sqlite3-driver';
import type { StoragePort } from '../../../common/interfaces/storage-port.interface';

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'placement-policy-'));
  tempDirs.push(dir);
  return path.join(dir, 'db.sqlite');
}

function connection(id: string): DatabaseConnectionConfig {
  return { id, name: id, host: '10.0.0.1', port: 7001, isDefault: false, createdAt: 1 };
}

function member(id: string, seedId: string): DatabaseConnectionConfig {
  return {
    ...connection(id),
    membership: { seedId, nodeId: `node-${id}`, origin: 'auto', source: 'cluster', role: 'primary' },
  };
}

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe.each([
  ['memory', async () => {
    const storage = new MemoryAdapter();
    await storage.initialize();
    return storage as StoragePort;
  }],
  ['sqlite', async () => {
    const storage = new SqliteAdapter({ filepath: tempDbPath() });
    await storage.initialize();
    return storage as StoragePort;
  }],
])('%s adapter placement policy storage', (_name, make) => {
  let storage: StoragePort;

  beforeEach(async () => {
    storage = await make();
  });
  afterEach(async () => storage.close());

  it('returns null for a connection with no policy', async () => {
    expect(await storage.getPlacementPolicy('conn-a')).toBeNull();
  });

  it('saves and replaces the mode per connection', async () => {
    await storage.savePlacementPolicy({ connectionId: 'conn-a', mode: 'recommend', updatedAt: 1_000 });
    await storage.savePlacementPolicy({ connectionId: 'conn-b', mode: 'observe', updatedAt: 1_500 });
    await storage.savePlacementPolicy({ connectionId: 'conn-a', mode: 'observe', updatedAt: 2_000 });
    expect(await storage.getPlacementPolicy('conn-a')).toEqual({ connectionId: 'conn-a', mode: 'observe', updatedAt: 2_000 });
    expect(await storage.getPlacementPolicy('conn-b')).toEqual({ connectionId: 'conn-b', mode: 'observe', updatedAt: 1_500 });
  });

  it('drops the policy with its connection', async () => {
    await storage.saveConnection(connection('conn-a'));
    await storage.savePlacementPolicy({ connectionId: 'conn-a', mode: 'recommend', updatedAt: 1_000 });
    await storage.deleteConnection('conn-a');
    expect(await storage.getPlacementPolicy('conn-a')).toBeNull();
  });
});

describe('sqlite placement policy upgrade', () => {
  it('puts connections that existed before the table on recommend', async () => {
    const filepath = tempDbPath();
    const first = new SqliteAdapter({ filepath });
    await first.initialize();
    await first.saveConnection(connection('old-a'));
    await first.saveConnection(connection('old-b'));
    await first.close();

    const Database = await loadBetterSqlite3();
    const raw = new Database(filepath);
    raw.exec('DROP TABLE placement_policies');
    raw.close();

    const upgraded = new SqliteAdapter({ filepath });
    await upgraded.initialize();
    expect((await upgraded.getPlacementPolicy('old-a'))?.mode).toBe('recommend');
    expect((await upgraded.getPlacementPolicy('old-b'))?.mode).toBe('recommend');

    await upgraded.saveConnection(connection('new-c'));
    expect(await upgraded.getPlacementPolicy('new-c')).toBeNull();
    await upgraded.close();
  });

  it('leaves the nodes registered under a cluster without a policy', async () => {
    const filepath = tempDbPath();
    const first = new SqliteAdapter({ filepath });
    await first.initialize();
    await first.saveConnection(connection('seed'));
    await first.saveConnection(member('node-1', 'seed'));
    await first.close();

    const Database = await loadBetterSqlite3();
    const raw = new Database(filepath);
    raw.exec('DROP TABLE placement_policies');
    raw.close();

    const upgraded = new SqliteAdapter({ filepath });
    await upgraded.initialize();
    expect((await upgraded.getPlacementPolicy('seed'))?.mode).toBe('recommend');
    expect(await upgraded.getPlacementPolicy('node-1')).toBeNull();
    await upgraded.close();
  });

  it('upgrades a connections table from before node membership', async () => {
    const filepath = tempDbPath();
    const first = new SqliteAdapter({ filepath });
    await first.initialize();
    await first.saveConnection(connection('old-a'));
    await first.close();

    const Database = await loadBetterSqlite3();
    const raw = new Database(filepath);
    raw.exec('DROP TABLE placement_policies');
    raw.exec('ALTER TABLE connections DROP COLUMN membership');
    raw.close();

    const upgraded = new SqliteAdapter({ filepath });
    await upgraded.initialize();
    expect((await upgraded.getPlacementPolicy('old-a'))?.mode).toBe('recommend');
    await upgraded.close();
  });

  it('seeds again after a start that failed before the seed landed', async () => {
    const filepath = tempDbPath();
    const first = new SqliteAdapter({ filepath });
    await first.initialize();
    await first.saveConnection(connection('old-a'));
    await first.close();

    const Database = await loadBetterSqlite3();
    const raw = new Database(filepath);
    raw.exec('DROP TABLE placement_policies');
    raw.close();

    const failing = new SqliteAdapter({ filepath });
    const prepare = jest
      .spyOn(failing as unknown as { ensureConnectionsSchema: () => void }, 'ensureConnectionsSchema')
      .mockImplementationOnce(() => {
        throw new Error('disk full');
      });
    await expect(failing.initialize()).rejects.toThrow('disk full');
    prepare.mockRestore();
    await failing.close();

    const upgraded = new SqliteAdapter({ filepath });
    await upgraded.initialize();
    expect((await upgraded.getPlacementPolicy('old-a'))?.mode).toBe('recommend');
    await upgraded.close();
  });

  it('leaves a fresh database without policies', async () => {
    const storage = new SqliteAdapter({ filepath: tempDbPath() });
    await storage.initialize();
    await storage.saveConnection(connection('new-a'));
    expect(await storage.getPlacementPolicy('new-a')).toBeNull();
    await storage.close();
  });

  it('does not overwrite policies on a later start', async () => {
    const filepath = tempDbPath();
    const first = new SqliteAdapter({ filepath });
    await first.initialize();
    await first.saveConnection(connection('conn-a'));
    await first.savePlacementPolicy({ connectionId: 'conn-a', mode: 'observe', updatedAt: 5 });
    await first.close();

    const again = new SqliteAdapter({ filepath });
    await again.initialize();
    expect(await again.getPlacementPolicy('conn-a')).toEqual({ connectionId: 'conn-a', mode: 'observe', updatedAt: 5 });
    await again.close();
  });
});

const POSTGRES_DSN =
  process.env.ANOMALY_STORAGE_POSTGRES_TEST_DSN ??
  'postgres://betterdb:devpassword@localhost:5433/betterdb';
const postgresReachable = adapters.some(([name]) => name === 'PostgresAdapter');

(postgresReachable ? describe : describe.skip)('postgres placement policy upgrade', () => {
  const schema = `placement_${randomUUID().replace(/-/g, '')}`;
  const pool = new Pool({ connectionString: POSTGRES_DSN });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  });

  const open = async () => {
    const adapter = new PostgresAdapter({ connectionString: POSTGRES_DSN, schema });
    await adapter.initialize();
    return adapter;
  };

  it('puts clusters that existed before the table on recommend, once', async () => {
    await pool.query(
      'CREATE TABLE IF NOT EXISTS public.placement_policies (connection_id TEXT PRIMARY KEY, mode TEXT NOT NULL, updated_at BIGINT NOT NULL)',
    );
    const first = await open();
    await first.saveConnection(connection('old-seed'));
    await first.saveConnection(member('old-node', 'old-seed'));
    expect(await first.getPlacementPolicy('old-seed')).toBeNull();
    await first.close();

    await pool.query(`DROP TABLE ${schema}.placement_policies`);

    const upgraded = await open();
    expect((await upgraded.getPlacementPolicy('old-seed'))?.mode).toBe('recommend');
    expect(await upgraded.getPlacementPolicy('old-node')).toBeNull();
    await upgraded.saveConnection(connection('new-c'));
    await upgraded.savePlacementPolicy({ connectionId: 'old-seed', mode: 'observe', updatedAt: 7 });
    await upgraded.close();

    const again = await open();
    expect(await again.getPlacementPolicy('new-c')).toBeNull();
    expect(await again.getPlacementPolicy('old-seed')).toEqual({ connectionId: 'old-seed', mode: 'observe', updatedAt: 7 });
    await again.close();
  });
});
