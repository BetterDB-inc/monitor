import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DatabaseConnectionConfig } from '@betterdb/shared';
import type { StoragePort } from '../../../common/interfaces/storage-port.interface';
import { loadBetterSqlite3 } from '../better-sqlite3-driver';
import { SqliteAdapter } from '../sqlite.adapter';
import { adapters, type AdapterFactory } from './anomaly-storage-adapters';

const zones = { '10.0.0.1:7001': 'us-east-1a', 'node-2.internal:7002': 'us-east-1b' };

function config(overrides: Partial<DatabaseConnectionConfig> = {}): DatabaseConnectionConfig {
  return {
    id: 'seed',
    name: 'Cluster',
    host: '10.0.0.1',
    port: 7001,
    isDefault: false,
    createdAt: 1,
    ...overrides,
  };
}

describe.each<[string, AdapterFactory]>(adapters)(
  'connection node availability zones — %s',
  (_name, makeAdapter) => {
    let storage: StoragePort;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      ({ storage, cleanup } = await makeAdapter());
    });

    afterEach(async () => {
      await cleanup();
    });

    it('round-trips the map through getConnection and getConnections', async () => {
      await storage.saveConnection(config({ nodeAvailabilityZones: zones }));

      expect((await storage.getConnection('seed'))?.nodeAvailabilityZones).toEqual(zones);
      expect((await storage.getConnections())[0].nodeAvailabilityZones).toEqual(zones);
    });

    it('reads a connection without a map with the field absent', async () => {
      await storage.saveConnection(config());

      expect((await storage.getConnection('seed'))?.nodeAvailabilityZones).toBeUndefined();
      expect((await storage.getConnections())[0].nodeAvailabilityZones).toBeUndefined();
    });

    it('sets, replaces and clears the map through updateConnection', async () => {
      await storage.saveConnection(config());

      await storage.updateConnection('seed', { nodeAvailabilityZones: zones });
      expect((await storage.getConnection('seed'))?.nodeAvailabilityZones).toEqual(zones);

      await storage.updateConnection('seed', {
        nodeAvailabilityZones: { '10.0.0.3:7003': 'us-east-1c' },
      });
      expect((await storage.getConnection('seed'))?.nodeAvailabilityZones).toEqual({
        '10.0.0.3:7003': 'us-east-1c',
      });

      await storage.updateConnection('seed', { nodeAvailabilityZones: undefined });
      expect((await storage.getConnection('seed'))?.nodeAvailabilityZones).toBeUndefined();
    });

    it('keeps the map when another field is updated', async () => {
      await storage.saveConnection(config({ nodeAvailabilityZones: zones }));

      await storage.updateConnection('seed', { name: 'Renamed' });

      expect(await storage.getConnection('seed')).toMatchObject({
        name: 'Renamed',
        nodeAvailabilityZones: zones,
      });
    });

    it('keeps the map when the connection is saved again with it', async () => {
      await storage.saveConnection(config({ nodeAvailabilityZones: zones }));

      await storage.saveConnection(config({ name: 'Renamed', nodeAvailabilityZones: zones }));

      expect(await storage.getConnection('seed')).toMatchObject({
        name: 'Renamed',
        nodeAvailabilityZones: zones,
      });
    });
  },
);

describe('connection node availability zones — existing SQLite database', () => {
  const tempDirs: string[] = [];

  function tempDbPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-zones-'));
    tempDirs.push(dir);
    return path.join(dir, 'test.db');
  }

  afterAll(() => {
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads a connection saved before the column existed as having no map, then stores one', async () => {
    const filepath = tempDbPath();
    const Database = await loadBetterSqlite3();
    const legacy = new Database(filepath);
    legacy.exec(`CREATE TABLE connections (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL,
      username TEXT, password TEXT, password_encrypted INTEGER DEFAULT 0, db_index INTEGER DEFAULT 0,
      tls INTEGER DEFAULT 0, ssh_tunnel TEXT, connection_type TEXT, is_default INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER)`);
    legacy
      .prepare('INSERT INTO connections (id, name, host, port, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('old', 'Old', 'h', 6379, 1);
    legacy.close();

    const adapter = new SqliteAdapter({ filepath });
    await adapter.initialize();

    expect((await adapter.getConnection('old'))?.nodeAvailabilityZones).toBeUndefined();
    expect((await adapter.getConnections())[0].nodeAvailabilityZones).toBeUndefined();

    await adapter.updateConnection('old', { nodeAvailabilityZones: zones });
    expect((await adapter.getConnection('old'))?.nodeAvailabilityZones).toEqual(zones);
    await adapter.close();
  });

  it.each([
    ['an empty string', ''],
    ['malformed JSON', '{"10.0.0.1:7001": '],
    ['a JSON array', '["us-east-1a"]'],
    ['an entry that is not host:port', '{"10.0.0.1":"us-east-1a"}'],
  ])('reads a stored value that is %s as no map', async (_label, stored) => {
    const filepath = tempDbPath();
    const adapter = new SqliteAdapter({ filepath });
    await adapter.initialize();
    await adapter.saveConnection(config({ nodeAvailabilityZones: zones }));
    await adapter.close();

    const Database = await loadBetterSqlite3();
    const raw = new Database(filepath);
    raw
      .prepare('UPDATE connections SET node_availability_zones = ? WHERE id = ?')
      .run(stored, 'seed');
    raw.close();

    const reopened = new SqliteAdapter({ filepath });
    await reopened.initialize();
    expect((await reopened.getConnection('seed'))?.nodeAvailabilityZones).toBeUndefined();
    expect(await reopened.getConnection('seed')).toMatchObject({ id: 'seed', host: '10.0.0.1' });
    await reopened.close();
  });
});
