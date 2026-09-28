import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DatabaseConnectionConfig } from '@betterdb/shared';
import { MemoryAdapter } from '../memory.adapter';
import { SqliteAdapter } from '../sqlite.adapter';
import { loadBetterSqlite3 } from '../better-sqlite3-driver';

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-type-'));
  tempDirs.push(dir);
  return path.join(dir, 'test.db');
}

function config(overrides: Partial<DatabaseConnectionConfig> = {}): DatabaseConnectionConfig {
  return {
    id: 'c1',
    name: 'Pushed',
    host: 'cache.internal',
    port: 6379,
    isDefault: false,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('connection type storage — memory', () => {
  it('round-trips external', async () => {
    const adapter = new MemoryAdapter();
    await adapter.initialize();
    await adapter.saveConnection(config({ connectionType: 'external' }));
    expect((await adapter.getConnection('c1'))?.connectionType).toBe('external');
  });
});

describe('connection type storage — sqlite', () => {
  it('round-trips external through getConnection and getConnections', async () => {
    const adapter = new SqliteAdapter({ filepath: tempDbPath() });
    await adapter.initialize();
    await adapter.saveConnection(config({ connectionType: 'external' }));
    expect((await adapter.getConnection('c1'))?.connectionType).toBe('external');
    expect((await adapter.getConnections())[0].connectionType).toBe('external');
    await adapter.close();
  });

  it('reads a connection saved without a type as direct', async () => {
    const adapter = new SqliteAdapter({ filepath: tempDbPath() });
    await adapter.initialize();
    await adapter.saveConnection(config());
    expect((await adapter.getConnection('c1'))?.connectionType).toBe('direct');
    await adapter.close();
  });

  it('migrates a legacy connections table without connection_type', async () => {
    const filepath = tempDbPath();
    const Database = await loadBetterSqlite3();
    const legacy = new Database(filepath);
    legacy.exec(`
      CREATE TABLE connections (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL,
        username TEXT, password TEXT, password_encrypted INTEGER DEFAULT 0,
        db_index INTEGER DEFAULT 0, tls INTEGER DEFAULT 0, ssh_tunnel TEXT,
        is_default INTEGER DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER
      )
    `);
    legacy
      .prepare('INSERT INTO connections (id, name, host, port, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('legacy', 'Old', 'db.local', 6379, 1);
    legacy.close();

    const adapter = new SqliteAdapter({ filepath });
    await adapter.initialize();
    expect((await adapter.getConnection('legacy'))?.connectionType).toBe('direct');
    await adapter.saveConnection(config({ connectionType: 'external' }));
    await adapter.saveConnection(config({ connectionType: 'external', name: 'Renamed' }));
    const saved = await adapter.getConnection('c1');
    expect(saved?.connectionType).toBe('external');
    expect(saved?.name).toBe('Renamed');
    expect((await adapter.getConnection('legacy'))?.connectionType).toBe('direct');
    await adapter.close();
  });
});
