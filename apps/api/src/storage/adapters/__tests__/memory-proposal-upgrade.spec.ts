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

    let message: string | null = null;
    try {
      await adapter.createMemoryProposal({
        id: 'p2',
        connection_id: 'c1',
        store_name: 's1',
        proposal_type: 'forget',
        proposal_payload: { target_kind: 'id', memory_id: 'm1' },
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toMatch(/unique/i);
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

  it('does not let a malformed legacy payload claim a valid target key', async () => {
    // `{}` falls through to the scope branch and produces the same key as a
    // genuine empty-scope target. Keyed first, it would win the unique index
    // and leave the real row unkeyed — silently unguarded.
    seedLegacy(
      `INSERT INTO memory_proposals VALUES
        ('bad','c1','s1','forget','{}',NULL,'pending',NULL,1,NULL,NULL,NULL,NULL,${FAR_FUTURE}),
        ('good','c1','s1','forget','{"target_kind":"scope"}',NULL,'pending',NULL,2,NULL,NULL,NULL,NULL,${FAR_FUTURE});`,
    );
    adapter = new SqliteAdapter({ filepath: dbPath });
    await adapter.initialize();

    // Read over SQL: a malformed payload cannot round-trip through the row
    // schema, which is pre-existing behaviour and not what this covers.
    const db = (adapter as unknown as { db: Database.Database }).db;
    const keys = db
      .prepare('SELECT id, target_discriminator FROM memory_proposals ORDER BY id')
      .all() as { id: string; target_discriminator: string | null }[];

    expect(keys).toEqual([
      { id: 'bad', target_discriminator: null },
      {
        id: 'good',
        target_discriminator: memoryForgetTargetDiscriminator({ target_kind: 'scope' }),
      },
    ]);
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
  it('finishes a backfill that a crash left half-done', async () => {
    // Every statement in the migration auto-commits, so a crash partway through
    // the backfill leaves the column present and the rest of the rows NULL. The
    // second startup sees the column and used to skip the backfill entirely,
    // stranding those rows outside the partial index and unguarded forever.
    seedLegacy(
      `INSERT INTO memory_proposals VALUES
        ('p1','c1','s1','forget','{"target_kind":"id","memory_id":"m1"}',NULL,'pending',NULL,1,NULL,NULL,NULL,NULL,${FAR_FUTURE}),
        ('p2','c1','s1','forget','{"target_kind":"id","memory_id":"m2"}',NULL,'pending',NULL,1,NULL,NULL,NULL,NULL,${FAR_FUTURE});`,
    );

    const crashed = new Database(dbPath);
    crashed.exec('ALTER TABLE memory_proposals ADD COLUMN applying_at INTEGER');
    crashed.exec('ALTER TABLE memory_proposals ADD COLUMN target_discriminator TEXT');
    crashed
      .prepare("UPDATE memory_proposals SET target_discriminator = ? WHERE id = 'p1'")
      .run(memoryForgetTargetDiscriminator({ target_kind: 'id', memory_id: 'm1' }));
    crashed.close();

    adapter = new SqliteAdapter({ filepath: dbPath });
    await adapter.initialize();

    const stranded = await adapter.getMemoryProposal('p2');
    expect(stranded?.target_discriminator).toBe(
      memoryForgetTargetDiscriminator({ target_kind: 'id', memory_id: 'm2' }),
    );

    // And being keyed, it is now actually guarded.
    await expect(
      adapter.countPendingMemoryProposalsByTarget({
        connection_id: 'c1',
        store_name: 's1',
        target_discriminator: memoryForgetTargetDiscriminator({
          target_kind: 'id',
          memory_id: 'm2',
        }),
      }),
    ).resolves.toBe(1);
  });
});
