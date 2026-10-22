import Valkey from 'iovalkey';
import { UnifiedDatabaseAdapter } from '../src/database/adapters/unified.adapter';

/**
 * Live multi-logical-database key analytics (BetterDB feedback): an instance
 * whose keys live outside the connected database (e.g. everything in db13,
 * nothing in db0) must still be discovered and scanned, with each result
 * tagged by its database index.
 *
 * Uses the shared betterdb-test-valkey container. The seeded databases are
 * high indexes no other e2e suite touches; db0 is deliberately left alone, so
 * assertions check inclusion rather than exact equality.
 */

const HOST = 'localhost';
const PORT = 6390;
const PASSWORD = 'devpassword';

const DB_A = 13;
const DB_B = 14;

describe('Key analytics across logical databases (E2E)', () => {
  let seeder: Valkey;

  beforeAll(async () => {
    seeder = new Valkey({ host: HOST, port: PORT, password: PASSWORD, db: DB_A });
    await seeder.flushdb();
    const pipelineA = seeder.pipeline();
    for (let i = 0; i < 25; i++) {
      pipelineA.set(`e2emulti:user:${i}`, `value-${i}`);
    }
    await pipelineA.exec();

    await seeder.select(DB_B);
    await seeder.flushdb();
    const pipelineB = seeder.pipeline();
    for (let i = 0; i < 10; i++) {
      pipelineB.set(`e2emulti:job:${i}`, `value-${i}`);
    }
    await pipelineB.exec();
    await seeder.select(DB_A);
  });

  afterAll(async () => {
    try {
      await seeder.flushdb();
      await seeder.select(DB_B);
      await seeder.flushdb();
    } finally {
      await seeder.quit();
    }
  });

  it('honors the configured dbIndex when connecting', async () => {
    const adapter = new UnifiedDatabaseAdapter({
      host: HOST,
      port: PORT,
      username: 'default',
      password: PASSWORD,
      dbIndex: DB_A,
    });
    try {
      await adapter.connect();
      // DBSIZE runs against the SELECTed database, not db0.
      expect(await adapter.getDbSize()).toBe(25);
    } finally {
      await adapter.disconnect();
    }
  });

  it('discovers and scans non-empty sibling databases from a db0 connection', async () => {
    const adapter = new UnifiedDatabaseAdapter({
      host: HOST,
      port: PORT,
      username: 'default',
      password: PASSWORD,
      // Connected to db0 — the seeded keys live in db13/db14 only.
      dbIndex: 0,
    });
    try {
      await adapter.connect();
      const results = await adapter.collectKeyAnalytics({
        sampleSize: 1000,
        scanBatchSize: 100,
        fullScan: true,
      });

      const byDb = new Map(results.map((result) => [result.db, result]));
      const dbA = byDb.get(DB_A);
      const dbB = byDb.get(DB_B);

      expect(dbA).toBeDefined();
      expect(dbA?.dbSize).toBe(25);
      expect(dbA?.patterns.some((p) => p.pattern.startsWith('e2emulti:user'))).toBe(true);

      expect(dbB).toBeDefined();
      expect(dbB?.dbSize).toBe(10);
      expect(dbB?.patterns.some((p) => p.pattern.startsWith('e2emulti:job'))).toBe(true);

      // The shared client must still sit on its configured database afterwards
      // (sibling scans go through short-lived clients, never SELECT).
      expect(await adapter.getDbSize()).not.toBe(25);
    } finally {
      await adapter.disconnect();
    }
  });
});
