import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DatabaseConnectionConfig } from '@betterdb/shared';
import { MemoryAdapter } from '../memory.adapter';
import { SqliteAdapter } from '../sqlite.adapter';
import { loadBetterSqlite3 } from '../better-sqlite3-driver';

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-membership-'));
  tempDirs.push(dir);
  return path.join(dir, 'test.db');
}

function config(overrides: Partial<DatabaseConnectionConfig> = {}): DatabaseConnectionConfig {
  return { id: 'c1', name: 'Node', host: '10.0.0.1', port: 7001, isDefault: false, createdAt: 1, ...overrides };
}

const membership = { seedId: 'seed', nodeId: 'abc', origin: 'auto' as const, source: 'cluster' as const, retiredAt: 1_700_000_000_000 };

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('connection membership storage — memory', () => {
  it('round-trips membership and the auto-register flag', async () => {
    const adapter = new MemoryAdapter();
    await adapter.initialize();
    await adapter.saveConnection(config({ autoRegisterNodes: true, membership }));
    const stored = await adapter.getConnection('c1');
    expect(stored?.autoRegisterNodes).toBe(true);
    expect(stored?.membership).toEqual(membership);
  });

  it('round-trips data node credentials', async () => {
    const adapter = new MemoryAdapter();
    await adapter.initialize();
    await adapter.saveConnection(config({ nodeUsername: 'app', nodePassword: 'pw', nodePasswordEncrypted: true }));
    expect(await adapter.getConnection('c1')).toMatchObject({ nodeUsername: 'app', nodePassword: 'pw', nodePasswordEncrypted: true });
  });
});

describe('connection membership storage — sqlite', () => {
  it('round-trips membership through getConnection and getConnections', async () => {
    const adapter = new SqliteAdapter({ filepath: tempDbPath() });
    await adapter.initialize();
    await adapter.saveConnection(config({ autoRegisterNodes: false, membership }));
    expect((await adapter.getConnection('c1'))?.membership).toEqual(membership);
    expect((await adapter.getConnection('c1'))?.autoRegisterNodes).toBe(false);
    expect((await adapter.getConnections())[0].membership).toEqual(membership);
    await adapter.close();
  });

  it('round-trips data node credentials through getConnection and getConnections', async () => {
    const adapter = new SqliteAdapter({ filepath: tempDbPath() });
    await adapter.initialize();
    await adapter.saveConnection(config({ nodeUsername: 'app', nodePassword: '{"v":1}', nodePasswordEncrypted: true }));
    const expected = { nodeUsername: 'app', nodePassword: '{"v":1}', nodePasswordEncrypted: true };
    expect(await adapter.getConnection('c1')).toMatchObject(expected);
    expect((await adapter.getConnections())[0]).toMatchObject(expected);
    await adapter.close();
  });

  it('preserves an explicitly empty data node username', async () => {
    const adapter = new SqliteAdapter({ filepath: tempDbPath() });
    await adapter.initialize();
    await adapter.saveConnection(config({ nodeUsername: '' }));
    expect((await adapter.getConnection('c1'))?.nodeUsername).toBe('');
    expect((await adapter.getConnections())[0].nodeUsername).toBe('');
    await adapter.close();
  });

  it('reads a connection without data node credentials with the fields absent', async () => {
    const adapter = new SqliteAdapter({ filepath: tempDbPath() });
    await adapter.initialize();
    await adapter.saveConnection(config());
    const stored = await adapter.getConnection('c1');
    expect(stored?.nodeUsername).toBeUndefined();
    expect(stored?.nodePassword).toBeUndefined();
    expect(stored?.nodePasswordEncrypted).toBeUndefined();
    expect((await adapter.getConnections())[0].nodePasswordEncrypted).toBeUndefined();
    await adapter.close();
  });

  it('reads an unset flag and no membership as undefined', async () => {
    const adapter = new SqliteAdapter({ filepath: tempDbPath() });
    await adapter.initialize();
    await adapter.saveConnection(config());
    const stored = await adapter.getConnection('c1');
    expect(stored?.autoRegisterNodes).toBeUndefined();
    expect(stored?.membership).toBeUndefined();
    await adapter.close();
  });

  it('updates and clears membership and the flag through updateConnection', async () => {
    const adapter = new SqliteAdapter({ filepath: tempDbPath() });
    await adapter.initialize();
    await adapter.saveConnection(config());
    await adapter.updateConnection('c1', { membership, autoRegisterNodes: true });
    expect((await adapter.getConnection('c1'))?.membership).toEqual(membership);
    expect((await adapter.getConnection('c1'))?.autoRegisterNodes).toBe(true);
    await adapter.updateConnection('c1', { membership: undefined, autoRegisterNodes: undefined });
    expect((await adapter.getConnection('c1'))?.membership).toBeUndefined();
    expect((await adapter.getConnection('c1'))?.autoRegisterNodes).toBeUndefined();
    await adapter.close();
  });

  it('migrates a legacy connections table without the new columns', async () => {
    const filepath = tempDbPath();
    const Database = await loadBetterSqlite3();
    const legacy = new Database(filepath);
    legacy.exec(`CREATE TABLE connections (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL,
      username TEXT, password TEXT, password_encrypted INTEGER DEFAULT 0, db_index INTEGER DEFAULT 0,
      tls INTEGER DEFAULT 0, ssh_tunnel TEXT, connection_type TEXT, is_default INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER)`);
    legacy.prepare('INSERT INTO connections (id, name, host, port, created_at) VALUES (?, ?, ?, ?, ?)').run('old', 'Old', 'h', 6379, 1);
    legacy.close();

    const adapter = new SqliteAdapter({ filepath });
    await adapter.initialize();
    expect((await adapter.getConnection('old'))?.membership).toBeUndefined();
    expect((await adapter.getConnection('old'))?.nodeUsername).toBeUndefined();
    await adapter.saveConnection(config({ id: 'new', membership, nodeUsername: 'app', nodePassword: 'pw' }));
    expect((await adapter.getConnection('new'))?.membership).toEqual(membership);
    expect(await adapter.getConnection('new')).toMatchObject({ nodeUsername: 'app', nodePassword: 'pw' });
    await adapter.close();
  });
});
