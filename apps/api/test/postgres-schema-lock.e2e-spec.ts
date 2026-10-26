import { execFileSync } from 'child_process';
import { Client, Pool } from 'pg';
import { PostgresAdapter } from '../src/storage/adapters/postgres.adapter';

const DSN =
  process.env.CLIENT_ANALYTICS_POSTGRES_TEST_DSN ??
  'postgres://betterdb:devpassword@localhost:5433/betterdb';
const SCHEMA = `schema_lock_e2e_${process.pid}_${Date.now()}`;
const RETRY_MS = 200;
const ANALYTICS_INDEXES = ['idx_acl_connection_captured', 'idx_client_connection_captured'];

function isReachable(connectionString: string): boolean {
  const { hostname, port } = new URL(connectionString);
  const probe = `
    const socket = require('net').createConnection({
      host: process.env.PROBE_HOST,
      port: Number(process.env.PROBE_PORT),
    });
    socket.setTimeout(1500);
    socket.on('connect', () => { socket.destroy(); process.exit(0); });
    socket.on('timeout', () => { socket.destroy(); process.exit(1); });
    socket.on('error', () => { process.exit(1); });
  `;

  try {
    execFileSync(process.execPath, ['-e', probe], {
      stdio: 'ignore',
      timeout: 3000,
      env: { ...process.env, PROBE_HOST: hostname, PROBE_PORT: port || '5432' },
    });
    return true;
  } catch {
    return false;
  }
}

const describePostgres = isReachable(DSN) ? describe : describe.skip;

async function waitFor(check: () => Promise<boolean>, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return check();
}

describePostgres('postgres schema-setup lock', () => {
  let adminPool: Pool;

  async function validIndexes(schema: string): Promise<string[]> {
    const result = await adminPool.query(
      `SELECT c.relname AS name
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND i.indisvalid AND c.relname = ANY($2)`,
      [schema, ANALYTICS_INDEXES],
    );
    return result.rows.map((r) => r.name).sort();
  }

  /** Drop both analytics indexes so the next initialize() has real builds to run. */
  async function dropAnalyticsIndexes(schema: string): Promise<void> {
    for (const name of ANALYTICS_INDEXES) {
      await adminPool.query(`DROP INDEX IF EXISTS ${schema}.${name}`);
    }
  }

  /** Backends running CREATE INDEX on a table of `schema`. */
  async function indexBuildPids(schema: string): Promise<number[]> {
    const result = await adminPool.query(
      `SELECT a.pid
         FROM pg_stat_activity a
         JOIN pg_stat_progress_create_index p ON p.pid = a.pid
         JOIN pg_class c ON c.oid = p.relid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND a.query ILIKE 'CREATE INDEX%'`,
      [schema],
    );
    return result.rows.map((r) => r.pid);
  }

  async function prepareSchema(schema: string): Promise<void> {
    const setup = new PostgresAdapter({ connectionString: DSN, schema });
    await setup.initialize();
    expect(await waitFor(async () => (await validIndexes(schema)).length === 2)).toBe(true);
    await setup.close();
    // Enough rows that each build takes measurable time.
    await adminPool.query(
      `INSERT INTO ${schema}.client_snapshots
         (client_id, addr, db, age, idle, captured_at, source_host, source_port, connection_id)
       SELECT g::text, '10.0.0.' || (g % 250) || ':6379', 0, 1, 0, g, 'h', 6379, 'c' || (g % 7)
         FROM generate_series(1, 200000) g`,
    );
    await adminPool.query(
      `INSERT INTO ${schema}.acl_audit
         (count, reason, context, object, username, age_seconds, client_info,
          timestamp_created, timestamp_last_updated, captured_at, source_host, source_port, connection_id)
       SELECT 1, 'auth', 'toplevel', 'AUTH', 'u' || (g % 13), 0, 'id=' || g, g, g, g, 'h', 6379, 'c' || (g % 7)
         FROM generate_series(1, 100000) g`,
    );
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: DSN });
    await prepareSchema(SCHEMA);
  });

  afterAll(async () => {
    await adminPool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await adminPool.end();
  });

  it('survives initialize() twice on one adapter while its index build runs (10 rounds)', async () => {
    for (let round = 0; round < 10; round++) {
      await dropAnalyticsIndexes(SCHEMA);
      const adapter = new PostgresAdapter({ connectionString: DSN, schema: SCHEMA, indexLockRetryMs: RETRY_MS });
      try {
        await adapter.initialize();
        await adapter.initialize();
        await adapter['indexBuild'];
        expect(await validIndexes(SCHEMA)).toEqual(ANALYTICS_INDEXES);
      } finally {
        await adapter.close();
      }
    }
  }, 180_000);

  it('a second initialize() reuses the in-flight build instead of starting another', async () => {
    await dropAnalyticsIndexes(SCHEMA);
    // Holding the snapshot index's build lock keeps the builder waiting (in flight).
    const holder = new Client({ connectionString: DSN });
    await holder.connect();
    const lock = await holder.query(
      `SELECT key, pg_try_advisory_lock(key) AS locked FROM (
         SELECT hashtext($1::text || $2::regclass::oid) AS key
       ) k`,
      ['betterdb.idx_client_connection_captured:', `${SCHEMA}.client_snapshots`],
    );
    expect(lock.rows[0].locked).toBe(true);
    const adapter = new PostgresAdapter({ connectionString: DSN, schema: SCHEMA, indexLockRetryMs: RETRY_MS });
    const builds = jest.spyOn(adapter as unknown as { ensureAnalyticsIndexes: () => Promise<void> }, 'ensureAnalyticsIndexes');
    try {
      await adapter.initialize();
      const firstBuild = adapter['indexBuild'];
      await adapter.initialize();
      expect(adapter['indexBuild']).toBe(firstBuild);
      expect(builds).toHaveBeenCalledTimes(1);

      await holder.query('SELECT pg_advisory_unlock($1)', [lock.rows[0].key]);
      await firstBuild;
      expect(await validIndexes(SCHEMA)).toEqual(ANALYTICS_INDEXES);
    } finally {
      await adapter.close();
      await holder.end();
    }
  });

  it('survives two adapters initialising the same schema concurrently (10 rounds)', async () => {
    for (let round = 0; round < 10; round++) {
      await dropAnalyticsIndexes(SCHEMA);
      const a = new PostgresAdapter({ connectionString: DSN, schema: SCHEMA, indexLockRetryMs: RETRY_MS });
      const b = new PostgresAdapter({ connectionString: DSN, schema: SCHEMA, indexLockRetryMs: RETRY_MS });
      try {
        await Promise.all([a.initialize(), b.initialize()]);
        await Promise.all([a['indexBuild'], b['indexBuild']]);
        expect(await validIndexes(SCHEMA)).toEqual(ANALYTICS_INDEXES);
      } finally {
        await Promise.all([a.close(), b.close()]);
      }
    }
  }, 180_000);

  it('waits in initialize() while another session holds the schema-setup lock', async () => {
    const holder = new Client({ connectionString: DSN });
    await holder.connect();
    const adapter = new PostgresAdapter({ connectionString: DSN, schema: SCHEMA, indexLockRetryMs: RETRY_MS });
    try {
      // Same key as the adapter: a constant plus the schema it runs in.
      const lock = await holder.query(
        `SELECT key, pg_try_advisory_lock(key) AS locked FROM (
           SELECT hashtext('betterdb.schema-setup:' || $1::text) AS key
         ) k`,
        [SCHEMA],
      );
      expect(lock.rows[0].locked).toBe(true);
      const key: number = lock.rows[0].key;

      let settled = false;
      const init = adapter.initialize().finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(settled).toBe(false);
      expect(adapter.isReady()).toBe(false);

      await holder.query('SELECT pg_advisory_unlock($1)', [key]);
      await expect(init).resolves.toBeUndefined();
      expect(adapter.isReady()).toBe(true);
      await adapter['indexBuild'];
    } finally {
      await adapter.close();
      await holder.end();
    }
  });

  it('fails initialize() with a clear error when the schema-setup lock wait exceeds its deadline', async () => {
    const holder = new Client({ connectionString: DSN });
    await holder.connect();
    const adapter = new PostgresAdapter({
      connectionString: DSN,
      schema: SCHEMA,
      indexLockRetryMs: RETRY_MS,
      schemaLockWaitMs: 1_500,
    });
    try {
      const lock = await holder.query(
        `SELECT key, pg_try_advisory_lock(key) AS locked FROM (
           SELECT hashtext('betterdb.schema-setup:' || $1::text) AS key
         ) k`,
        [SCHEMA],
      );
      expect(lock.rows[0].locked).toBe(true);
      const key: number = lock.rows[0].key;

      const started = Date.now();
      await expect(adapter.initialize()).rejects.toThrow(
        /Timed out after \d+s waiting for the schema-setup lock \(schema setup\)/,
      );
      expect(Date.now() - started).toBeGreaterThanOrEqual(1_400);
      expect(adapter.isReady()).toBe(false);

      // Once the holder lets go, the same adapter initialises normally.
      await holder.query('SELECT pg_advisory_unlock($1)', [key]);
      await expect(adapter.initialize()).resolves.toBeUndefined();
      expect(adapter.isReady()).toBe(true);
      await adapter['indexBuild'];
    } finally {
      await adapter.close();
      await holder.end();
    }
  });

  it('close() cancels an in-flight build on the server', async () => {
    await dropAnalyticsIndexes(SCHEMA);
    // An open snapshot makes CREATE INDEX CONCURRENTLY wait for it to end, so
    // the build is reliably still running when close() is called.
    const blocker = new Client({ connectionString: DSN });
    await blocker.connect();
    const adapter = new PostgresAdapter({ connectionString: DSN, schema: SCHEMA, indexLockRetryMs: RETRY_MS });
    try {
      await blocker.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await blocker.query('SELECT 1');

      await adapter.initialize();
      expect(await waitFor(async () => (await indexBuildPids(SCHEMA)).length > 0)).toBe(true);
      const build = adapter['indexBuild'] as Promise<void>;

      const buildPid = adapter['indexBuildPid'] as number;

      await adapter.close();
      await expect(build).resolves.toBeUndefined();
      const alive = await adminPool.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [buildPid]);
      expect(alive.rowCount).toBe(0);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      await blocker.end();
    }

    // The next startup drops the INVALID leftover and rebuilds.
    const next = new PostgresAdapter({ connectionString: DSN, schema: SCHEMA, indexLockRetryMs: RETRY_MS });
    try {
      await next.initialize();
      await next['indexBuild'];
      expect(await validIndexes(SCHEMA)).toEqual(ANALYTICS_INDEXES);
    } finally {
      await next.close();
    }
  });
});
