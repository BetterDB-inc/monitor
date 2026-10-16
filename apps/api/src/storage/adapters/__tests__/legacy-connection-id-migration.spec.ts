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

  it('preserves existing rows when rebuilding the legacy table', async () => {
    createLegacyAclAudit();
    const legacy = new Database(dbPath);
    legacy
      .prepare(
        `INSERT INTO acl_audit
           (count, reason, context, object, username, age_seconds, client_info,
            timestamp_created, timestamp_last_updated, captured_at, source_host, source_port, created_at)
         VALUES (1, 'auth', 'toplevel', 'cmd', 'default', 5, 'info', 1, 1, 100, '127.0.0.1', 6379, 0)`,
      )
      .run();
    legacy.close();

    const adapter = new SqliteAdapter({ filepath: dbPath });
    await adapter.initialize();
    const stored = await adapter.getAclEntries({});
    await adapter.close();

    // The row survives the rebuild and is backfilled onto the default connection.
    expect(stored).toHaveLength(1);
    expect(stored[0].username).toBe('default');
    expect(stored[0].connectionId).toBe('env-default');
  });

  it('stores the same logical ACL entry for two connections on one host:port', async () => {
    createLegacyAclAudit();

    const adapter = new SqliteAdapter({ filepath: dbPath });
    await adapter.initialize();

    // Identical on every pre-connection_id column; they differ only by
    // connection_id. The legacy six-column UNIQUE would have rejected the second
    // write (aborting the batch); the rebuilt seven-column constraint keeps them
    // as distinct rows.
    const entry = {
      id: 0,
      count: 1,
      reason: 'auth',
      context: 'toplevel',
      object: 'cmd',
      username: 'default',
      ageSeconds: 5,
      clientInfo: 'info',
      timestampCreated: 1_700_000_000,
      timestampLastUpdated: 1_700_000_000,
      capturedAt: 1_700_000_100,
      sourceHost: '127.0.0.1',
      sourcePort: 6379,
    };

    await expect(adapter.saveAclEntries([entry], 'conn-a')).resolves.toBe(1);
    await expect(adapter.saveAclEntries([entry], 'conn-b')).resolves.toBe(1);

    const a = await adapter.getAclEntries({ connectionId: 'conn-a' });
    const b = await adapter.getAclEntries({ connectionId: 'conn-b' });
    await adapter.close();

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('finishes a partially-migrated table that still carries the stale constraint', async () => {
    // The state left by the earlier index-only fix: connection_id added and a
    // seven-column unique index created, but the legacy six-column constraint
    // never removed. The rebuild must still run so the stale constraint goes.
    createLegacyAclAudit();
    const partial = new Database(dbPath);
    partial.exec(`ALTER TABLE acl_audit ADD COLUMN connection_id TEXT DEFAULT 'env-default'`);
    partial.exec(
      `CREATE UNIQUE INDEX idx_acl_audit_conn_unique ON acl_audit(
         timestamp_created, username, object, reason, source_host, source_port, connection_id)`,
    );
    partial.close();

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
      clientInfo: 'info',
      timestampCreated: 1_700_000_000,
      timestampLastUpdated: 1_700_000_000,
      capturedAt: 1_700_000_100,
      sourceHost: '127.0.0.1',
      sourcePort: 6379,
    };
    await expect(adapter.saveAclEntries([entry], 'conn-a')).resolves.toBe(1);
    await expect(adapter.saveAclEntries([entry], 'conn-b')).resolves.toBe(1);
    await adapter.close();

    const db = new Database(dbPath, { readonly: true });
    // The stale index-only artifact is gone; only the canonical auto-index for
    // the inline constraint remains.
    const leftover = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_acl_audit_conn_unique'")
      .all();
    db.close();
    expect(leftover).toHaveLength(0);
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
