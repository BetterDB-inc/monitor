import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DatabaseConnectionConfig, TlsConfig } from '@betterdb/shared';
import { MemoryAdapter } from '../memory.adapter';
import { SqliteAdapter } from '../sqlite.adapter';
import { loadBetterSqlite3 } from '../better-sqlite3-driver';

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-tls-'));
  tempDirs.push(dir);
  return path.join(dir, 'test.db');
}

const tlsConfig: TlsConfig = {
  source: 'inline',
  ca: '-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----\n',
  cert: '-----BEGIN CERTIFICATE-----\nclient\n-----END CERTIFICATE-----\n',
  key: 'enc(-----BEGIN PRIVATE KEY-----)',
  passphrase: 'enc(pw)',
  secretsEncrypted: true,
};

function config(overrides: Partial<DatabaseConnectionConfig> = {}): DatabaseConnectionConfig {
  return {
    id: 'c1',
    name: 'mTLS',
    host: 'cache.internal',
    port: 6380,
    tls: true,
    isDefault: false,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('TLS material storage — memory', () => {
  it('round-trips tlsConfig and authMode', async () => {
    const adapter = new MemoryAdapter();
    await adapter.initialize();
    await adapter.saveConnection(config({ tlsConfig, authMode: 'certificate' }));
    const saved = await adapter.getConnection('c1');
    expect(saved?.tlsConfig).toEqual(tlsConfig);
    expect(saved?.authMode).toBe('certificate');
  });
});

describe('TLS material storage — sqlite', () => {
  it('round-trips tlsConfig and authMode through getConnection and getConnections', async () => {
    const adapter = new SqliteAdapter({ filepath: tempDbPath() });
    await adapter.initialize();
    await adapter.saveConnection(config({ tlsConfig, authMode: 'certificate' }));
    const one = await adapter.getConnection('c1');
    expect(one?.tlsConfig).toEqual(tlsConfig);
    expect(one?.authMode).toBe('certificate');
    const all = await adapter.getConnections();
    expect(all[0].tlsConfig).toEqual(tlsConfig);
    expect(all[0].authMode).toBe('certificate');
    await adapter.close();
  });

  it('stores no tlsConfig and a password auth mode as absent', async () => {
    const adapter = new SqliteAdapter({ filepath: tempDbPath() });
    await adapter.initialize();
    await adapter.saveConnection(config());
    const saved = await adapter.getConnection('c1');
    expect(saved?.tlsConfig).toBeUndefined();
    expect(saved?.authMode).toBeUndefined();
    await adapter.close();
  });

  it('upserts replace the material', async () => {
    const adapter = new SqliteAdapter({ filepath: tempDbPath() });
    await adapter.initialize();
    await adapter.saveConnection(config({ tlsConfig, authMode: 'certificate' }));
    await adapter.saveConnection(config({ tlsConfig: { source: 'file', caPath: 'ca.pem' } }));
    const saved = await adapter.getConnection('c1');
    expect(saved?.tlsConfig).toEqual({ source: 'file', caPath: 'ca.pem' });
    expect(saved?.authMode).toBeUndefined();
    await adapter.close();
  });

  it('migrates a legacy connections table without tls_config / auth_mode', async () => {
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
      .prepare('INSERT INTO connections (id, name, host, port, tls, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('legacy', 'Old', 'db.local', 6379, 1, 1);
    legacy.close();

    const adapter = new SqliteAdapter({ filepath });
    await adapter.initialize();
    const old = await adapter.getConnection('legacy');
    expect(old?.tls).toBe(true);
    expect(old?.tlsConfig).toBeUndefined();
    expect(old?.authMode).toBeUndefined();
    await adapter.saveConnection(config({ tlsConfig, authMode: 'certificate' }));
    expect((await adapter.getConnection('c1'))?.tlsConfig).toEqual(tlsConfig);
    await adapter.close();
  });
});
