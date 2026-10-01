import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { PostgresAdapter } from '../src/storage/adapters/postgres.adapter';

const DSN =
  process.env.NULLABLE_METRICS_POSTGRES_TEST_DSN ??
  'postgres://betterdb:devpassword@localhost:5433/betterdb';

const SCHEMA = `nullable_metrics_contract_${process.pid}_${Date.now()}`;

const LEGACY_SNAPSHOT_ID = randomUUID();

const LEGACY_SCHEMA = `
  CREATE TABLE ${SCHEMA}.memory_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    timestamp BIGINT NOT NULL,
    used_memory BIGINT NOT NULL,
    used_memory_rss BIGINT NOT NULL,
    used_memory_peak BIGINT NOT NULL,
    mem_fragmentation_ratio DOUBLE PRECISION NOT NULL,
    maxmemory BIGINT NOT NULL DEFAULT 0,
    allocator_frag_ratio DOUBLE PRECISION NOT NULL DEFAULT 0,
    ops_per_sec BIGINT NOT NULL DEFAULT 0,
    cpu_sys DOUBLE PRECISION NOT NULL DEFAULT 0,
    cpu_user DOUBLE PRECISION NOT NULL DEFAULT 0,
    io_threaded_reads BIGINT NOT NULL DEFAULT 0,
    io_threaded_writes BIGINT NOT NULL DEFAULT 0,
    connection_id TEXT NOT NULL DEFAULT 'env-default'
  );
  CREATE TABLE ${SCHEMA}.command_stats_samples (
    id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL,
    command TEXT NOT NULL,
    calls_total BIGINT NOT NULL DEFAULT 0,
    usec_total BIGINT NOT NULL DEFAULT 0,
    usec_per_call DOUBLE PRECISION NOT NULL DEFAULT 0,
    rejected_calls BIGINT NOT NULL DEFAULT 0,
    failed_calls BIGINT NOT NULL DEFAULT 0,
    calls_delta BIGINT NOT NULL,
    usec_delta BIGINT NOT NULL,
    interval_ms INTEGER NOT NULL,
    captured_at BIGINT NOT NULL
  );
  INSERT INTO ${SCHEMA}.memory_snapshots VALUES
    ('${LEGACY_SNAPSHOT_ID}', 1000, 100, 200, 300, 1.5, 0, 1.1, 10, 0.5, 0.25, 7, 8, 'conn-a');
  INSERT INTO ${SCHEMA}.command_stats_samples VALUES
    ('cs-1', 'conn-a', 'get', 50, 500, 10.0, 1, 2, 5, 50, 60000, 2000);
`;

const NULLABLE: Record<string, string[]> = {
  memory_snapshots: [
    'used_memory_rss',
    'used_memory_peak',
    'mem_fragmentation_ratio',
    'allocator_frag_ratio',
    'io_threaded_reads',
    'io_threaded_writes',
  ],
  command_stats_samples: [
    'usec_total',
    'usec_per_call',
    'rejected_calls',
    'failed_calls',
    'usec_delta',
  ],
};

function postgresRequired(): boolean {
  const flag = process.env.REQUIRE_POSTGRES_TESTS;
  if (flag === 'true') {
    return true;
  }
  if (flag === 'false') {
    return false;
  }
  return process.env.CI === 'true';
}

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

const reachable = isReachable(DSN);
const describePostgres = reachable ? describe : describe.skip;

if (reachable === false && postgresRequired() === true) {
  describe('nullable pushed metrics — postgres (live Postgres required)', () => {
    it('has a reachable PostgreSQL', () => {
      throw new Error(
        `PostgreSQL is required here (CI or REQUIRE_POSTGRES_TESTS=true) but ${new URL(DSN).host} is unreachable`,
      );
    });
  });
}

describePostgres('nullable pushed metrics — postgres upgrade from NOT NULL columns', () => {
  let adminPool: Pool;
  let adapter: PostgresAdapter;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: DSN });
    await adminPool.query(`CREATE SCHEMA ${SCHEMA}`);
    await adminPool.query(LEGACY_SCHEMA);
    adapter = new PostgresAdapter({ connectionString: DSN, schema: SCHEMA });
    await adapter.initialize();
  });

  afterAll(async () => {
    await adapter.close();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await adminPool.end();
  });

  it('drops NOT NULL from the pushed memory and commandstats columns', async () => {
    for (const [table, columns] of Object.entries(NULLABLE)) {
      const { rows } = await adminPool.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2 AND column_name = ANY($3)`,
        [SCHEMA, table, columns],
      );
      expect(rows).toHaveLength(columns.length);
      for (const row of rows) {
        expect(row.is_nullable).toBe('YES');
      }
    }
  });

  it('preserves existing rows', async () => {
    expect(await adapter.getMemorySnapshots({ connectionId: 'conn-a' })).toEqual([
      expect.objectContaining({
        id: LEGACY_SNAPSHOT_ID,
        usedMemoryRss: 200,
        usedMemoryPeak: 300,
        memFragmentationRatio: 1.5,
        allocatorFragRatio: 1.1,
        ioThreadedReads: 7,
        ioThreadedWrites: 8,
      }),
    ]);
    expect(
      await adapter.getCommandStatsHistory({
        connectionId: 'conn-a',
        command: 'get',
        startTime: 0,
        endTime: 10_000,
      }),
    ).toEqual([
      expect.objectContaining({
        usecTotal: 500,
        usecPerCall: 10,
        rejectedCalls: 1,
        failedCalls: 2,
        usecDelta: 50,
      }),
    ]);
  });

  it('round-trips null for fields that were not pushed', async () => {
    await adapter.saveMemorySnapshots(
      [
        {
          id: randomUUID(),
          timestamp: 5000,
          usedMemory: 1024,
          usedMemoryRss: null,
          usedMemoryPeak: null,
          memFragmentationRatio: null,
          maxmemory: 0,
          allocatorFragRatio: null,
          opsPerSec: 3,
          cpuSys: 0,
          cpuUser: 0,
          ioThreadedReads: null,
          ioThreadedWrites: null,
        },
      ],
      'conn-x',
    );
    await adapter.saveCommandStatsSamples(
      [
        {
          command: 'get',
          callsTotal: 80,
          usecTotal: null,
          usecPerCall: null,
          rejectedCalls: null,
          failedCalls: null,
          callsDelta: 30,
          usecDelta: null,
          intervalMs: 60_000,
          capturedAt: 6000,
        },
      ],
      'conn-x',
    );

    expect(await adapter.getMemorySnapshots({ connectionId: 'conn-x' })).toEqual([
      expect.objectContaining({
        usedMemory: 1024,
        usedMemoryRss: null,
        usedMemoryPeak: null,
        memFragmentationRatio: null,
        allocatorFragRatio: null,
        ioThreadedReads: null,
        ioThreadedWrites: null,
      }),
    ]);
    expect(
      await adapter.getCommandStatsHistory({
        connectionId: 'conn-x',
        command: 'get',
        startTime: 0,
        endTime: 10_000,
      }),
    ).toEqual([
      expect.objectContaining({
        callsDelta: 30,
        usecTotal: null,
        usecPerCall: null,
        rejectedCalls: null,
        failedCalls: null,
        usecDelta: null,
      }),
    ]);
  });

  it('re-runs the schema migration idempotently', async () => {
    const second = new PostgresAdapter({ connectionString: DSN, schema: SCHEMA });
    await expect(second.initialize()).resolves.not.toThrow();
    await second.close();
  });
});
