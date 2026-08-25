import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { memoryForgetTargetDiscriminator } from '@betterdb/shared';
import { SqliteAdapter } from '../sqlite.adapter';

// Every other spec builds a fresh database, where CREATE TABLE supplies the new
// columns. That hid a startup failure on upgrade: the index DDL lived in
// createSchema and referenced columns only the migration adds, so an existing
// install threw `no such column: applying_at` and the app would not boot.
const LEGACY_SCHEMA = `
  CREATE TABLE memory_proposals (
    id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL,
    store_name TEXT NOT NULL,
    proposal_type TEXT NOT NULL,
    proposal_payload TEXT NOT NULL,
    reasoning TEXT,
    status TEXT NOT NULL,
    proposed_by TEXT,
    proposed_at INTEGER NOT NULL,
    reviewed_by TEXT,
    reviewed_at INTEGER,
    applied_at INTEGER,
    applied_result TEXT,
    expires_at INTEGER NOT NULL
  );
`;

const FAR_FUTURE = 99_999_999_999;

describe('memory_proposals upgrade from a pre-#276 database', () => {
  let dbPath: string;
  let adapter: SqliteAdapter;

  function seedLegacy(rows: string): void {
    dbPath = path.join(os.tmpdir(), `mp-upgrade-${randomUUID()}.db`);
    const legacy = new Database(dbPath);
    legacy.exec(LEGACY_SCHEMA + rows);
    legacy.close();
  }

  afterEach(async () => {
    await adapter?.close();
    try {
      if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
      }
    } catch {
      // teardown only
    }
  });

  it('initializes without throwing', async () => {
    seedLegacy('');
    adapter = new SqliteAdapter({ filepath: dbPath });

    await expect(adapter.initialize()).resolves.toBeUndefined();
  });

  it('creates both new indexes on the upgraded database', async () => {
    seedLegacy('');
    adapter = new SqliteAdapter({ filepath: dbPath });
    await adapter.initialize();

    const db = (adapter as unknown as { db: Database.Database }).db;
    const names = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memory_proposals'",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);

    expect(names).toContain('idx_memory_proposals_pending_target');
    expect(names).toContain('idx_memory_proposals_applying');
  });

  it('backfills the discriminator for existing pending rows', async () => {
    seedLegacy(
      `INSERT INTO memory_proposals VALUES
        ('p1','c1','s1','forget','{"target_kind":"id","memory_id":"m1"}',NULL,'pending',NULL,1,NULL,NULL,NULL,NULL,${FAR_FUTURE});`,
    );
    adapter = new SqliteAdapter({ filepath: dbPath });
    await adapter.initialize();

    const stored = await adapter.getMemoryProposal('p1');

    expect(stored?.target_discriminator).toBe(
      memoryForgetTargetDiscriminator({ target_kind: 'id', memory_id: 'm1' }),
    );
  });

  it('guards a backfilled row against a new duplicate', async () => {
    seedLegacy(
      `INSERT INTO memory_proposals VALUES
        ('p1','c1','s1','forget','{"target_kind":"id","memory_id":"m1"}',NULL,'pending',NULL,1,NULL,NULL,NULL,NULL,${FAR_FUTURE});`,
    );
    adapter = new SqliteAdapter({ filepath: dbPath });
    await adapter.initialize();

    await expect(
      adapter.createMemoryProposal({
        id: 'p2',
        connection_id: 'c1',
        store_name: 's1',
        proposal_type: 'forget',
        proposal_payload: { target_kind: 'id', memory_id: 'm1' },
      }),
    ).rejects.toThrow(/unique/i);
  });

  it('leaves pre-existing duplicates in place rather than failing the migration', async () => {
    // A database that already holds duplicates cannot have all of them keyed.
    seedLegacy(
      `INSERT INTO memory_proposals VALUES
        ('p1','c1','s1','forget','{"target_kind":"id","memory_id":"m1"}',NULL,'pending',NULL,1,NULL,NULL,NULL,NULL,${FAR_FUTURE}),
        ('p2','c1','s1','forget','{"target_kind":"id","memory_id":"m1"}',NULL,'pending',NULL,1,NULL,NULL,NULL,NULL,${FAR_FUTURE});`,
    );
    adapter = new SqliteAdapter({ filepath: dbPath });

    await expect(adapter.initialize()).resolves.toBeUndefined();
    expect(await adapter.getMemoryProposal('p1')).not.toBeNull();
    expect(await adapter.getMemoryProposal('p2')).not.toBeNull();
  });

  it('makes a row already stuck in applying sweepable', async () => {
    // The rows #277 exists to clear are the ones that predate it. Leaving
    // applying_at NULL would skip them forever.
    seedLegacy(
      `INSERT INTO memory_proposals VALUES
        ('p1','c1','s1','forget','{"target_kind":"id","memory_id":"m1"}',NULL,'applying',NULL,500,NULL,700,NULL,NULL,${FAR_FUTURE});`,
    );
    adapter = new SqliteAdapter({ filepath: dbPath });
    await adapter.initialize();

    const swept = await adapter.failStaleApplyingMemoryProposalsBefore(1_000);

    expect(swept.map((p) => p.id)).toEqual(['p1']);
  });

  it('falls back to proposed_at when the stuck row was never reviewed', async () => {
    seedLegacy(
      `INSERT INTO memory_proposals VALUES
        ('p1','c1','s1','forget','{"target_kind":"id","memory_id":"m1"}',NULL,'applying',NULL,500,NULL,NULL,NULL,NULL,${FAR_FUTURE});`,
    );
    adapter = new SqliteAdapter({ filepath: dbPath });
    await adapter.initialize();

    expect((await adapter.failStaleApplyingMemoryProposalsBefore(1_000)).map((p) => p.id)).toEqual([
      'p1',
    ]);
  });
});
