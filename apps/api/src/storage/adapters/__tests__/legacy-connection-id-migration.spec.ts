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
    // The pre-multi-connection shape: no connection_id column, and the UNIQUE
    // constraint predates connection_id (six columns, as shipped before the
    // multi-connection change).
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
        created_at INTEGER,
        UNIQUE(timestamp_created, username, object, reason, source_host, source_port)
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

  it('accepts ACL upserts against a migrated legacy acl_audit', async () => {
    createLegacyAclAudit();

    const adapter = new SqliteAdapter({ filepath: dbPath });
    await adapter.initialize();

    const entry = {
      id: 0,
      count: 1,
      reason: 'auth',
      context: 'toplevel',
      object: 'cmd',
      username: 'default',
      ageSeconds: 5,
      clientInfo: 'addr=127.0.0.1:6379',
      timestampCreated: 1_700_000_000,
      timestampLastUpdated: 1_700_000_000,
      capturedAt: 1_700_000_100,
      sourceHost: '127.0.0.1',
      sourcePort: 6379,
    };

    // The pre-fix migration added connection_id but left the six-column UNIQUE
    // in place, so this upsert's ON CONFLICT(... connection_id) had no matching
    // constraint and threw. It must now succeed, and a repeat must upsert (not
    // duplicate) on the connection_id-inclusive key.
    await expect(adapter.saveAclEntries([entry], 'env-default')).resolves.toBe(1);
    await adapter.saveAclEntries([{ ...entry, count: 2 }], 'env-default');

    const stored = await adapter.getAclEntries({ connectionId: 'env-default' });
    await adapter.close();

    expect(stored).toHaveLength(1);
    expect(stored[0].count).toBe(2);
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
