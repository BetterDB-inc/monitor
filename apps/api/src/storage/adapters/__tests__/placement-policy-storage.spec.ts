import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DatabaseConnectionConfig } from '@betterdb/shared';
import { SqliteAdapter } from '../sqlite.adapter';
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
