import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import * as os from 'os';
import * as path from 'path';
import {
  DEFAULT_PLACEMENT_SETTINGS,
  type DatabaseConnectionConfig,
  type PlacementSettings,
} from '@betterdb/shared';
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

function stored(
  connectionId: string,
  mode: string,
  updatedAt: number,
  settings = DEFAULT_PLACEMENT_SETTINGS,
  version = 0,
) {
  return { connectionId, mode, settings, version, updatedAt };
}

const tighter: PlacementSettings = {
  ...DEFAULT_PLACEMENT_SETTINGS,
  sustainMinutes: 45,
  excludedSlots: [7],
};

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
  [
    'memory',
    async () => {
      const storage = new MemoryAdapter();
      await storage.initialize();
      return storage as StoragePort;
    },
  ],
  [
    'sqlite',
    async () => {
      const storage = new SqliteAdapter({ filepath: tempDbPath() });
      await storage.initialize();
      return storage as StoragePort;
    },
  ],
  [
    'libsql',
    async () => {
      const storage = new SqliteAdapter({ url: `file:${tempDbPath()}` });
      await storage.initialize();
      return storage as StoragePort;
    },
  ],
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
    await storage.savePlacementMode({
      connectionId: 'conn-a',
      mode: 'recommend',
      updatedAt: 1_000,
    });
    await storage.savePlacementMode({ connectionId: 'conn-b', mode: 'observe', updatedAt: 1_500 });
    await storage.savePlacementMode({ connectionId: 'conn-a', mode: 'observe', updatedAt: 2_000 });
    expect(await storage.getPlacementPolicy('conn-a')).toEqual(stored('conn-a', 'observe', 2_000));
    expect(await storage.getPlacementPolicy('conn-b')).toEqual(stored('conn-b', 'observe', 1_500));
  });

  it('saves settings at the version it read and moves the version on', async () => {
    expect(
      await storage.savePlacementSettings(
        { connectionId: 'conn-a', settings: tighter, updatedAt: 3_000, modeIfNew: 'recommend' },
        0,
      ),
    ).toEqual(stored('conn-a', 'recommend', 3_000, tighter, 1));
    expect(await storage.getPlacementPolicy('conn-a')).toEqual(
      stored('conn-a', 'recommend', 3_000, tighter, 1),
    );
  });

  it('refuses settings saved at a version that is no longer stored', async () => {
    await storage.savePlacementSettings(
      { connectionId: 'conn-a', settings: tighter, updatedAt: 3_000, modeIfNew: 'recommend' },
      0,
    );
    expect(
      await storage.savePlacementSettings(
        {
          connectionId: 'conn-a',
          settings: DEFAULT_PLACEMENT_SETTINGS,
          updatedAt: 4_000,
          modeIfNew: 'recommend',
        },
        0,
      ),
    ).toBeNull();
    expect(
      await storage.savePlacementSettings(
        { connectionId: 'conn-b', settings: tighter, updatedAt: 4_000, modeIfNew: 'recommend' },
        2,
      ),
    ).toBeNull();
    expect(await storage.getPlacementPolicy('conn-a')).toEqual(
      stored('conn-a', 'recommend', 3_000, tighter, 1),
    );
    expect(await storage.getPlacementPolicy('conn-b')).toBeNull();
  });

  it('keeps the settings and version when only the mode changes', async () => {
    await storage.savePlacementMode({ connectionId: 'conn-a', mode: 'observe', updatedAt: 1_000 });
    await storage.savePlacementSettings(
      { connectionId: 'conn-a', settings: tighter, updatedAt: 3_000, modeIfNew: 'recommend' },
      0,
    );
    expect(
      await storage.savePlacementMode({
        connectionId: 'conn-a',
        mode: 'recommend',
        updatedAt: 5_000,
      }),
    ).toEqual(stored('conn-a', 'recommend', 5_000, tighter, 1));
    expect(await storage.getPlacementPolicy('conn-a')).toEqual(
      stored('conn-a', 'recommend', 5_000, tighter, 1),
    );
  });

  it('keeps the stored mode when settings are saved on an existing row', async () => {
    await storage.savePlacementMode({ connectionId: 'conn-a', mode: 'observe', updatedAt: 1_000 });
    await storage.savePlacementSettings(
      { connectionId: 'conn-a', settings: tighter, updatedAt: 3_000, modeIfNew: 'recommend' },
      0,
    );
    expect((await storage.getPlacementPolicy('conn-a'))?.mode).toBe('observe');
  });

  it('drops the policy with its connection', async () => {
    await storage.saveConnection(connection('conn-a'));
    await storage.savePlacementMode({
      connectionId: 'conn-a',
      mode: 'recommend',
      updatedAt: 1_000,
    });
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

  it('reads a row stored before the policy columns with the default settings', async () => {
    const filepath = tempDbPath();
    const first = new SqliteAdapter({ filepath });
    await first.initialize();
    await first.close();

    const Database = await loadBetterSqlite3();
    const raw = new Database(filepath);
    raw.exec('DROP TABLE placement_policies');
    raw.exec(
      'CREATE TABLE placement_policies (connection_id TEXT PRIMARY KEY, mode TEXT NOT NULL, updated_at INTEGER NOT NULL)',
    );
    raw.prepare("INSERT INTO placement_policies VALUES ('conn-a', 'observe', 9)").run();
    raw.close();

    const upgraded = new SqliteAdapter({ filepath });
    await upgraded.initialize();
    expect(await upgraded.getPlacementPolicy('conn-a')).toEqual(stored('conn-a', 'observe', 9));
    expect(
      await upgraded.savePlacementSettings(
        { connectionId: 'conn-a', settings: tighter, updatedAt: 10, modeIfNew: 'recommend' },
        0,
      ),
    ).toEqual(stored('conn-a', 'observe', 10, tighter, 1));
    await upgraded.close();
  });

  async function storedRaw(policy: string) {
    const filepath = tempDbPath();
    const first = new SqliteAdapter({ filepath });
    await first.initialize();
    await first.savePlacementSettings(
      { connectionId: 'conn-a', settings: tighter, updatedAt: 10, modeIfNew: 'recommend' },
      0,
    );
    await first.close();

    const Database = await loadBetterSqlite3();
    const raw = new Database(filepath);
    raw
      .prepare("UPDATE placement_policies SET policy = ? WHERE connection_id = 'conn-a'")
      .run(policy);
    raw.close();

    const again = new SqliteAdapter({ filepath });
    await again.initialize();
    const read = await again.getPlacementPolicy('conn-a');
    await again.close();
    return read;
  }

  it('reads stored settings that no longer validate with the problem, keeping the exclusions', async () => {
    expect(await storedRaw(JSON.stringify({ ...tighter, resolveRatio: 9 }))).toEqual({
      ...stored('conn-a', 'recommend', 10, tighter, 1),
      invalid: { problems: [expect.stringContaining('resolveRatio')], exclusionsReadable: true },
    });
  });

  it('says the exclusions cannot be read from a stored document that is not JSON', async () => {
    expect(await storedRaw('{"excludedSlots":[7')).toEqual({
      ...stored('conn-a', 'recommend', 10, DEFAULT_PLACEMENT_SETTINGS, 1),
      invalid: { problems: [expect.any(String)], exclusionsReadable: false },
    });
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
    await first.savePlacementMode({ connectionId: 'conn-a', mode: 'observe', updatedAt: 5 });
    await first.close();

    const again = new SqliteAdapter({ filepath });
    await again.initialize();
    expect(await again.getPlacementPolicy('conn-a')).toEqual(stored('conn-a', 'observe', 5));
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
    await upgraded.savePlacementMode({ connectionId: 'old-seed', mode: 'observe', updatedAt: 7 });
    await upgraded.close();

    const again = await open();
    expect(
      await again.savePlacementSettings(
        { connectionId: 'old-seed', settings: tighter, updatedAt: 8, modeIfNew: 'recommend' },
        0,
      ),
    ).toEqual(stored('old-seed', 'observe', 8, tighter, 1));
    expect(
      await again.savePlacementSettings(
        {
          connectionId: 'old-seed',
          settings: DEFAULT_PLACEMENT_SETTINGS,
          updatedAt: 9,
          modeIfNew: 'recommend',
        },
        0,
      ),
    ).toBeNull();
    await again.savePlacementMode({ connectionId: 'old-seed', mode: 'observe', updatedAt: 7 });
    await again.savePlacementSettings(
      {
        connectionId: 'old-seed',
        settings: DEFAULT_PLACEMENT_SETTINGS,
        updatedAt: 7,
        modeIfNew: 'recommend',
      },
      1,
    );
    expect(await again.getPlacementPolicy('new-c')).toBeNull();
    expect(await again.getPlacementPolicy('old-seed')).toEqual(
      stored('old-seed', 'observe', 7, DEFAULT_PLACEMENT_SETTINGS, 2),
    );
    await again.close();
  });
});
