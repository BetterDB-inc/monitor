import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteAdapter } from '../sqlite.adapter';

/**
 * Regression test for the legacy-upgrade deadlock: on a database created
 * before the multi-connection change, acl_audit &co. exist without
 * connection_id. createSchema's index DDL references that column, and
 * CREATE TABLE IF NOT EXISTS does not add columns to an existing table, so
 * initialize() threw `no such column: connection_id` before the migration
 * that would have added it ever ran.
 */
describe('SqliteAdapter legacy connection_id migration', () => {
  let dbPath: string;

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-conn-id-'));
    dbPath = path.join(dir, 'audit.db');
  });

  afterEach(() => {
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  function createLegacyAclAudit(): void {
    const db = new Database(dbPath);
    // The pre-multi-connection shape: no connection_id column.
    db.exec(`
      CREATE TABLE acl_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        count INTEGER NOT NULL,
        reason TEXT NOT NULL,
        context TEXT NOT NULL,
        object TEXT NOT NULL,
        username TEXT NOT NULL,
        age_seconds REAL NOT NULL,
        client_info TEXT NOT NULL,
        timestamp_created INTEGER NOT NULL,
        timestamp_last_updated INTEGER NOT NULL,
        captured_at INTEGER NOT NULL,
        source_host TEXT NOT NULL,
        source_port INTEGER NOT NULL,
        created_at INTEGER
      );
    `);
    db.close();
  }

  it('initializes a database whose tables predate connection_id', async () => {
    createLegacyAclAudit();

    const adapter = new SqliteAdapter({ filepath: dbPath });
    await adapter.initialize();
    await adapter.close();

    const db = new Database(dbPath, { readonly: true });
    const columns = db.prepare('PRAGMA table_info(acl_audit)').all() as { name: string }[];
    db.close();
    expect(columns.some((c) => c.name === 'connection_id')).toBe(true);
  });

  it('still initializes a brand-new database', async () => {
    const adapter = new SqliteAdapter({ filepath: dbPath });
    await adapter.initialize();
    await adapter.close();

    const db = new Database(dbPath, { readonly: true });
    const columns = db.prepare('PRAGMA table_info(acl_audit)').all() as { name: string }[];
    db.close();
    expect(columns.some((c) => c.name === 'connection_id')).toBe(true);
  });
});
