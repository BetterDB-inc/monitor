import { execFileSync } from 'child_process';
import { Client, Pool } from 'pg';
import { MemoryAdapter } from '../src/storage/adapters/memory.adapter';
import { PostgresAdapter } from '../src/storage/adapters/postgres.adapter';
import { foldGroupsIntoRollups, mergeRollupsIntoStats } from '../src/client-analytics/client-rollup-math';
import { clientPairKey } from '@betterdb/shared';
import {
  BATCH_MS,
  COLLIDE_CONNECTION,
  CONNECTIONS,
  EDGE_CONNECTION,
  EDGE_IPS,
  buildCollidingPairFixture,
  buildEdgeFixture,
  PEAK_CASES,
  STATS_RANGES,
  T0,
  buildFixture,
  peakRollups,
  referenceStats,
  rollup,
  seedFixture,
} from '../src/storage/adapters/__tests__/client-analytics-rollups.fixture';

const DSN =
  process.env.CLIENT_ANALYTICS_POSTGRES_TEST_DSN ??
  'postgres://betterdb:devpassword@localhost:5433/betterdb';
const SCHEMA = `client_rollups_e2e_${process.pid}_${Date.now()}`;
const BUCKET = 300_000;

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

describePostgres('client analytics rollups — postgres', () => {
  const rows = buildFixture();
  let adminPool: Pool;
  let pg: PostgresAdapter;
  let memory: MemoryAdapter;

  async function validIndexes(): Promise<string[]> {
    const result = await adminPool.query(
      `SELECT c.relname AS name
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND i.indisvalid
          AND c.relname IN ('idx_client_connection_captured', 'idx_acl_connection_captured')`,
      [SCHEMA],
    );
    return result.rows.map((r) => r.name).sort();
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: DSN });
    pg = new PostgresAdapter({ connectionString: DSN, schema: SCHEMA });
    await pg.initialize();
    memory = new MemoryAdapter();
    await memory.initialize();
    await seedFixture(pg, rows);
    await seedFixture(memory, rows);
  });

  afterAll(async () => {
    // Let the background index build finish before the schema goes away.
    await waitFor(async () => (await validIndexes()).length === 2);
    await pg.close();
    await memory.close();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await adminPool.end();
  });

  describe('background index build', () => {
    it('makes isClientSnapshotIndexReady() true after initialize()', async () => {
      expect(await waitFor(() => pg.isClientSnapshotIndexReady())).toBe(true);
    });

    it('creates both composite indexes in the tenant schema', async () => {
      expect(await waitFor(async () => (await validIndexes()).length === 2)).toBe(true);
      const result = await adminPool.query(
        `SELECT indexname, indexdef FROM pg_indexes
          WHERE schemaname = $1
            AND indexname IN ('idx_client_connection_captured', 'idx_acl_connection_captured')
          ORDER BY indexname`,
        [SCHEMA],
      );
      expect(result.rows.map((r) => r.indexname)).toEqual([
        'idx_acl_connection_captured',
        'idx_client_connection_captured',
      ]);
      expect(result.rows[1].indexdef).toContain('(connection_id, captured_at)');
    });

    it('creates the rollup table with its bucket index', async () => {
      const result = await adminPool.query(
        `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'client_analytics_rollups'`,
        [SCHEMA],
      );
      expect(result.rows.map((r) => r.indexname)).toEqual(
        expect.arrayContaining(['client_analytics_rollups_pkey', 'idx_client_rollups_bucket']),
      );
    });

    it('is idempotent across a second initialize on the same schema', async () => {
      const again = new PostgresAdapter({ connectionString: DSN, schema: SCHEMA });
      await again.initialize();
      expect(await waitFor(() => again.isClientSnapshotIndexReady())).toBe(true);
      await again.close();
    });

    it('close() does not wait for an in-flight build, and the next startup rebuilds the interrupted index', async () => {
      const schema = `${SCHEMA}_close`;
      const indexState = async () => {
        const result = await adminPool.query(
          `SELECT i.indisvalid AS valid
             FROM pg_index i
             JOIN pg_class c ON c.oid = i.indexrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relname = 'idx_client_connection_captured'`,
          [schema],
        );
        return result.rows[0] ? (result.rows[0].valid ? 'valid' : 'invalid') : 'missing';
      };
      const buildPid = async (): Promise<number | null> => {
        const result = await adminPool.query(
          `SELECT pid FROM pg_stat_activity
            WHERE state = 'active'
              AND query LIKE 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_client_connection_captured %'`,
        );
        return result.rows[0]?.pid ?? null;
      };

      const first = new PostgresAdapter({ connectionString: DSN, schema });
      await first.initialize();
      expect(await waitFor(() => first.isClientSnapshotIndexReady())).toBe(true);
      await first.close();
      await adminPool.query(`DROP INDEX ${schema}.idx_client_connection_captured`);

      // An open snapshot makes CREATE INDEX CONCURRENTLY wait for it to end.
      const blocker = new Client({ connectionString: DSN });
      await blocker.connect();
      try {
        await blocker.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await blocker.query('SELECT 1');

        const second = new PostgresAdapter({ connectionString: DSN, schema });
        await second.initialize();
        expect(await waitFor(async () => (await buildPid()) !== null)).toBe(true);
        const pid = await buildPid();
        const build = second['indexBuild'] as Promise<void>;

        const started = Date.now();
        await second.close();
        expect(Date.now() - started).toBeLessThan(5_000);
        // The abandoned build settles quietly (no unhandled rejection).
        await expect(build).resolves.toBeUndefined();

        // Simulate the build dying with the process: it leaves an INVALID index.
        await adminPool.query('SELECT pg_terminate_backend($1)', [pid]);
        expect(await waitFor(async () => (await buildPid()) === null)).toBe(true);
        expect(await indexState()).toBe('invalid');
      } finally {
        await blocker.query('ROLLBACK').catch(() => undefined);
        await blocker.end();
      }

      const third = new PostgresAdapter({ connectionString: DSN, schema });
      try {
        await third.initialize();
        expect(await waitFor(() => third.isClientSnapshotIndexReady())).toBe(true);
        expect(await indexState()).toBe('valid');
      } finally {
        await third.close();
        await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      }
    });
  });

  describe('identity with the memory adapter', () => {
    const windows: Array<[number, number]> = [
      [0, Number.MAX_SAFE_INTEGER],
      [T0, T0 + 10 * BATCH_MS],
      [T0 + 3 * BATCH_MS - 1, T0 + 3 * BATCH_MS],
      [T0 + 50 * BATCH_MS, T0 + 60 * BATCH_MS],
    ];

    for (const connectionId of CONNECTIONS) {
      it(`returns identical groups and bounds for ${connectionId}`, async () => {
        expect(await pg.getClientSnapshotBounds(connectionId)).toEqual(
          await memory.getClientSnapshotBounds(connectionId),
        );
        for (const [start, end] of windows) {
          expect(await pg.getClientSnapshotGroups(connectionId, start, end)).toEqual(
            await memory.getClientSnapshotGroups(connectionId, start, end),
          );
        }
      });
    }

    it('returns null bounds for an unknown connection', async () => {
      expect(await pg.getClientSnapshotBounds('nope')).toBeNull();
    });

    for (const connectionId of CONNECTIONS) {
      it(`returns identical next captures for ${connectionId}`, async () => {
        const bounds = (await memory.getClientSnapshotBounds(connectionId)) as { earliest: number; latest: number };
        const probes = [0, T0 - 1, T0, T0 + 3 * BATCH_MS - 1, T0 + 3 * BATCH_MS, bounds.latest - 1, bounds.latest];
        for (const after of probes) {
          expect(await pg.getClientSnapshotNextCapturedAt(connectionId, after)).toBe(
            await memory.getClientSnapshotNextCapturedAt(connectionId, after),
          );
        }
      });
    }

    it('getClientSnapshotNextCapturedAt is strictly after, numeric, null past the newest row and per connection', async () => {
      const [connectionId] = CONNECTIONS;
      const bounds = (await pg.getClientSnapshotBounds(connectionId)) as { earliest: number; latest: number };
      const first = await pg.getClientSnapshotNextCapturedAt(connectionId, bounds.earliest - 1);
      expect(first).toBe(bounds.earliest);
      expect(typeof first).toBe('number');
      const second = await pg.getClientSnapshotNextCapturedAt(connectionId, bounds.earliest);
      expect(second).toBeGreaterThan(bounds.earliest);
      expect(await pg.getClientSnapshotNextCapturedAt(connectionId, bounds.latest)).toBeNull();
      expect(await pg.getClientSnapshotNextCapturedAt('nope', 0)).toBeNull();
    });

    for (const [label, start, end] of STATS_RANGES) {
      it(`returns identical stats and matches the reference (${label})`, async () => {
        const all = await pg.getClientAnalyticsStats(start, end);
        expect(all).toEqual(await memory.getClientAnalyticsStats(start, end));
        expect(all).toEqual(referenceStats(rows, start, end));
        for (const connectionId of CONNECTIONS) {
          const scoped = await pg.getClientAnalyticsStats(start, end, connectionId);
          expect(scoped).toEqual(await memory.getClientAnalyticsStats(start, end, connectionId));
          expect(scoped).toEqual(referenceStats(rows, start, end, connectionId));
        }
      });
    }

    it('stores empty name/user as NULL and still groups them as empty strings', async () => {
      const nulls = await adminPool.query(
        `SELECT COUNT(*)::int AS n FROM ${SCHEMA}.client_snapshots WHERE name IS NULL`,
      );
      expect(nulls.rows[0].n).toBeGreaterThan(0);
      const groups = await pg.getClientSnapshotGroups('conn-a', 0, Number.MAX_SAFE_INTEGER);
      expect(groups.some((g) => g.name === '')).toBe(true);
      expect(groups.every((g) => typeof g.count === 'number' && typeof g.capturedAt === 'number')).toBe(true);
    });
  });

  describe('rollup rows', () => {
    beforeEach(async () => {
      await adminPool.query(`DELETE FROM ${SCHEMA}.client_analytics_rollups`);
    });

    it('round-trips every field with numbers, objects and the ips array intact', async () => {
      const row = rollup('conn-a', 10 * BUCKET);
      await pg.upsertClientAnalyticsRollups([row]);
      const [read] = await pg.getClientAnalyticsRollups(0, 100 * BUCKET);
      expect(read).toEqual(row);
      expect(typeof read.bucketStart).toBe('number');
      expect(Array.isArray(read.ips)).toBe(true);
    });

    it('replaces on conflict, including duplicate keys within one call', async () => {
      await pg.upsertClientAnalyticsRollups([rollup('conn-a', BUCKET)]);
      const last = rollup('conn-a', BUCKET, { rowCount: 7, ips: [] });
      await pg.upsertClientAnalyticsRollups([rollup('conn-a', BUCKET, { rowCount: 3 }), last]);
      expect(await pg.getClientAnalyticsRollups(0, 10 * BUCKET)).toEqual([last]);
    });

    it('upserts more rows than one statement chunk holds', async () => {
      const many = Array.from({ length: 2_500 }, (_, i) => rollup('conn-bulk', i * BUCKET));
      await pg.upsertClientAnalyticsRollups(many);
      const read = await pg.getClientAnalyticsRollups(0, 3_000 * BUCKET, 'conn-bulk');
      expect(read).toHaveLength(2_500);
      expect(await pg.pruneOldClientAnalyticsRollups(2_000 * BUCKET, 'conn-bulk')).toBe(2_000);
    });

    it('reads inclusive ranges ordered by bucket then connection, and reports watermark/floor', async () => {
      await pg.upsertClientAnalyticsRollups([
        rollup('conn-b', 2 * BUCKET, { lastCapturedAt: 2 * BUCKET + 5 }),
        rollup('conn-a', 3 * BUCKET, { lastCapturedAt: 3 * BUCKET + 9 }),
        rollup('conn-a', 2 * BUCKET, { lastCapturedAt: 2 * BUCKET + 7 }),
        rollup('conn-b', 1 * BUCKET),
      ]);
      const all = await pg.getClientAnalyticsRollups(2 * BUCKET, 3 * BUCKET);
      expect(all.map((r) => [r.bucketStart, r.connectionId])).toEqual([
        [2 * BUCKET, 'conn-a'],
        [2 * BUCKET, 'conn-b'],
        [3 * BUCKET, 'conn-a'],
      ]);
      expect(await pg.getClientAnalyticsRollupWatermark('conn-a')).toBe(3 * BUCKET + 9);
      expect(await pg.getClientAnalyticsRollupFloor('conn-b')).toBe(BUCKET);
      expect(await pg.getClientAnalyticsRollupWatermark('none')).toBeNull();
      expect(await pg.getClientAnalyticsRollupFloor('none')).toBeNull();
      expect(await pg.pruneOldClientAnalyticsRollups(3 * BUCKET)).toBe(3);
    });

    describe('getClientAnalyticsRollupPeak', () => {
      beforeEach(async () => {
        await memory.pruneOldClientAnalyticsRollups(Number.MAX_SAFE_INTEGER);
        await pg.upsertClientAnalyticsRollups(peakRollups());
        await memory.upsertClientAnalyticsRollups(peakRollups());
      });

      for (const [label, connectionId, sinceBucket, expected] of PEAK_CASES) {
        it(`returns numbers matching the reference and the memory adapter (${label})`, async () => {
          const peak = await pg.getClientAnalyticsRollupPeak(connectionId, sinceBucket);
          expect(peak).toEqual(expected);
          expect(peak).toEqual(await memory.getClientAnalyticsRollupPeak(connectionId, sinceBucket));
          if (peak) {
            expect(typeof peak.peak).toBe('number');
            expect(typeof peak.capturedAt).toBe('number');
          }
        });
      }

      it('is null with no rows at all', async () => {
        await adminPool.query(`DELETE FROM ${SCHEMA}.client_analytics_rollups`);
        expect(await pg.getClientAnalyticsRollupPeak('conn-a', 0)).toBeNull();
      });
    });
  });

  describe('address and identity edge cases', () => {
    const edge = buildEdgeFixture();
    const end = Number.MAX_SAFE_INTEGER;

    beforeAll(async () => {
      for (const capturedAt of [...new Set(edge.map((r) => r.capturedAt))]) {
        const batch = edge.filter((r) => r.capturedAt === capturedAt).map((r) => ({ ...r, id: 0 }));
        await pg.saveClientSnapshot(batch, EDGE_CONNECTION);
        await memory.saveClientSnapshot(batch, EDGE_CONNECTION);
      }
    });

    afterAll(async () => {
      await adminPool.query(`DELETE FROM ${SCHEMA}.client_snapshots WHERE connection_id = $1`, [EDGE_CONNECTION]);
      await adminPool.query(`DELETE FROM ${SCHEMA}.client_analytics_rollups WHERE connection_id = $1`, [
        EDGE_CONNECTION,
      ]);
      await memory.pruneOldClientSnapshots(end, EDGE_CONNECTION);
    });

    it('strips only a trailing :<digits> port, identically to the memory adapter', async () => {
      const groups = await pg.getClientSnapshotGroups(EDGE_CONNECTION, 0, end);
      expect([...new Set(groups.map((g) => g.ip))].sort()).toEqual(EDGE_IPS);
      expect(groups).toEqual(await memory.getClientSnapshotGroups(EDGE_CONNECTION, 0, end));

      const stats = await pg.getClientAnalyticsStats(undefined, undefined, EDGE_CONNECTION);
      expect(stats.uniqueIps).toBe(EDGE_IPS.length);
      expect(stats).toEqual(await memory.getClientAnalyticsStats(undefined, undefined, EDGE_CONNECTION));
      expect(stats).toEqual(referenceStats(edge, undefined, undefined, EDGE_CONNECTION));

      const series = await pg.getClientTimeSeries(0, end, 60_000, EDGE_CONNECTION);
      expect(series).toEqual(await memory.getClientTimeSeries(0, end, 60_000, EDGE_CONNECTION));
      expect([...new Set(series.flatMap((p) => Object.keys(p.byAddr)))].sort()).toEqual(EDGE_IPS);
    });

    it('keeps a user containing ":" intact through stored rollups, matching the raw path', async () => {
      const groups = await pg.getClientSnapshotGroups(EDGE_CONNECTION, 0, end);
      await pg.upsertClientAnalyticsRollups(foldGroupsIntoRollups(EDGE_CONNECTION, groups, new Map(), 1));
      const stored = await pg.getClientAnalyticsRollups(0, end, EDGE_CONNECTION);
      expect(stored[0].byUserAndName['["svc:ro","api"]']).toMatchObject({ user: 'svc:ro', name: 'api' });
      const raw = await pg.getClientAnalyticsStats(undefined, undefined, EDGE_CONNECTION);
      expect(raw.connectionsByUserAndName['svc:ro:api']).toMatchObject({ user: 'svc:ro', name: 'api' });
      expect(mergeRollupsIntoStats(stored)).toEqual(raw);
    });

    it('keeps pairs whose `${user}:${name}` collide apart through stored rollups, matching the raw path', async () => {
      const rows = buildCollidingPairFixture();
      try {
        for (const capturedAt of [...new Set(rows.map((r) => r.capturedAt))]) {
          const batch = rows.filter((r) => r.capturedAt === capturedAt).map((r) => ({ ...r, id: 0 }));
          await pg.saveClientSnapshot(batch, COLLIDE_CONNECTION);
          await memory.saveClientSnapshot(batch, COLLIDE_CONNECTION);
        }
        const raw = await pg.getClientAnalyticsStats(undefined, undefined, COLLIDE_CONNECTION);
        expect(raw).toEqual(await memory.getClientAnalyticsStats(undefined, undefined, COLLIDE_CONNECTION));
        expect(raw.connectionsByUserAndName).toEqual({ 'a:b:c': { user: 'a', name: 'b:c', current: 4, peak: 4, avgAge: 22 } });

        const groups = await pg.getClientSnapshotGroups(COLLIDE_CONNECTION, 0, end);
        await pg.upsertClientAnalyticsRollups(foldGroupsIntoRollups(COLLIDE_CONNECTION, groups, new Map(), 1));
        const stored = await pg.getClientAnalyticsRollups(0, end, COLLIDE_CONNECTION);
        expect(Object.keys(stored[0].byUserAndName).sort()).toEqual([clientPairKey('a', 'b:c'), clientPairKey('a:b', 'c')]);
        expect(mergeRollupsIntoStats(stored)).toEqual(raw);
      } finally {
        await adminPool.query(`DELETE FROM ${SCHEMA}.client_snapshots WHERE connection_id = $1`, [COLLIDE_CONNECTION]);
        await adminPool.query(`DELETE FROM ${SCHEMA}.client_analytics_rollups WHERE connection_id = $1`, [
          COLLIDE_CONNECTION,
        ]);
        await memory.pruneOldClientSnapshots(end, COLLIDE_CONNECTION);
      }
    });
  });
});
