import { unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MemoryAdapter } from '../memory.adapter';
import { SqliteAdapter } from '../sqlite.adapter';
import { hasRawDatabaseHandle } from '../../raw-database-handle';

describe('raw database handle', () => {
  it('memory adapter reports kind memory', async () => {
    const storage = new MemoryAdapter();
    await storage.initialize();
    expect(hasRawDatabaseHandle(storage)).toBe(true);
    expect(storage.getRawDatabaseHandle()).toEqual({ kind: 'memory' });
    await storage.close();
  });

  it('sqlite adapter exposes the open better-sqlite3 database', async () => {
    const path = join(tmpdir(), `raw-handle-${Date.now()}-${Math.random()}.db`);
    const storage = new SqliteAdapter({ filepath: path });
    await storage.initialize();
    const handle = storage.getRawDatabaseHandle();
    expect(handle.kind).toBe('sqlite');
    if (handle.kind === 'sqlite') {
      const row = handle.db.prepare('SELECT 1 AS one').get() as { one: number };
      expect(row.one).toBe(1);
    }
    await storage.close();
    unlinkSync(path);
  });

  it('sqlite adapter configured with a url reports kind libsql', async () => {
    const path = join(tmpdir(), `raw-handle-libsql-${Date.now()}-${Math.random()}.db`);
    const storage = new SqliteAdapter({ url: `file:${path}` });
    await storage.initialize();
    expect(storage.getRawDatabaseHandle().kind).toBe('libsql');
    await storage.close();
    unlinkSync(path);
  });

  it('sqlite adapter throws before initialize', () => {
    const storage = new SqliteAdapter({ filepath: join(tmpdir(), 'never-opened.db') });
    expect(() => {
      return storage.getRawDatabaseHandle();
    }).toThrow('SQLite storage is not initialized');
  });
});
