import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import type { CaptureCounterSnapshots } from '@betterdb/shared';
import type { StoredCaptureSession } from '../src/common/interfaces/storage-port.interface';
import { PostgresAdapter } from '../src/storage/adapters/postgres.adapter';

const DSN =
  process.env.CAPTURE_COUNTER_SNAPSHOTS_POSTGRES_TEST_DSN ??
  'postgres://betterdb:devpassword@localhost:5433/betterdb';

const SCHEMA = `capture_counter_snapshots_${process.pid}_${Date.now()}`;
const LEGACY_SCHEMA = `${SCHEMA}_legacy`;
const CONNECTION_ID = 'conn-counters';

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
  describe('capture counter snapshots — postgres (live Postgres required)', () => {
    it('has a reachable PostgreSQL', () => {
      throw new Error(
        `PostgreSQL is required here (CI or REQUIRE_POSTGRES_TESTS=true) but ${new URL(DSN).host} is unreachable`,
      );
    });
  });
}

function makeSession(overrides: Partial<StoredCaptureSession> = {}): StoredCaptureSession {
  return {
    id: randomUUID(),
    connectionId: CONNECTION_ID,
    status: 'completed',
    source: 'manual',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_005_000,
    byteCount: 10,
    lineCount: 2,
    byteCap: 1_000_000,
    lineCap: 1_000_000,
    ...overrides,
  };
}

const SNAPSHOTS: CaptureCounterSnapshots = {
  version: 1,
  nodes: [
    {
      nodeId: 'A',
      address: 'h1:6379',
      start: { capturedAt: 1_700_000_000_000, counters: { total_commands_processed: 10 } },
      end: { capturedAt: 1_700_000_005_000, counters: { total_commands_processed: 40 } },
    },
    { nodeId: 'B', start: null, end: null, startError: 'timeout', endError: 'no_end_sample' },
  ],
};

describePostgres('capture counter snapshots — postgres', () => {
  let adapter: PostgresAdapter;
  let legacyAdapter: PostgresAdapter | undefined;

  beforeAll(async () => {
    adapter = new PostgresAdapter({ connectionString: DSN, schema: SCHEMA });
    await adapter.initialize();
  });

  afterAll(async () => {
    await adapter.close();
    await legacyAdapter?.close();
    const adminPool = new Pool({ connectionString: DSN });
    await adminPool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await adminPool.query(`DROP SCHEMA IF EXISTS ${LEGACY_SCHEMA} CASCADE`);
    await adminPool.end();
  });

  it('round-trips counterSnapshots through JSONB', async () => {
    const session = makeSession({ counterSnapshots: SNAPSHOTS });
    await adapter.saveCaptureSession(session, CONNECTION_ID);

    const fetched = await adapter.getCaptureSession(session.id);
    expect(fetched?.counterSnapshots).toEqual(SNAPSHOTS);
  });

  it('writes snapshots onto a row saved without them via update', async () => {
    const session = makeSession({ status: 'running', endedAt: undefined });
    await adapter.saveCaptureSession(session, CONNECTION_ID);
    expect((await adapter.getCaptureSession(session.id))?.counterSnapshots).toBeUndefined();

    await adapter.updateCaptureSession(session.id, {
      status: 'completed',
      counterSnapshots: SNAPSHOTS,
    });

    const fetched = await adapter.getCaptureSession(session.id);
    expect(fetched?.status).toBe('completed');
    expect(fetched?.counterSnapshots).toEqual(SNAPSHOTS);
  });

  it('adds the column to a legacy capture_sessions table', async () => {
    const adminPool = new Pool({ connectionString: DSN });
    try {
      await adminPool.query(`CREATE SCHEMA IF NOT EXISTS ${LEGACY_SCHEMA}`);
      await adminPool.query(`
        CREATE TABLE ${LEGACY_SCHEMA}.capture_sessions (
          id UUID PRIMARY KEY,
          connection_id TEXT NOT NULL,
          status VARCHAR(20) NOT NULL,
          source VARCHAR(20) NOT NULL,
          trigger_id UUID,
          schedule_id UUID,
          requested_by TEXT,
          started_at BIGINT NOT NULL,
          ended_at BIGINT,
          duration_ms BIGINT,
          byte_count BIGINT NOT NULL DEFAULT 0,
          line_count BIGINT NOT NULL DEFAULT 0,
          byte_cap BIGINT NOT NULL,
          line_cap BIGINT NOT NULL,
          termination_reason TEXT,
          target_node TEXT,
          node_segments JSONB,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          CHECK (status IN ('running','completed','truncated','failed','skipped')),
          CHECK (source IN ('manual','trigger','schedule'))
        )
      `);
      const legacyId = randomUUID();
      await adminPool.query(
        `INSERT INTO ${LEGACY_SCHEMA}.capture_sessions
           (id, connection_id, status, source, started_at, byte_cap, line_cap)
         VALUES ($1, $2, 'completed', 'manual', 1700000000000, 1000, 1000)`,
        [legacyId, CONNECTION_ID],
      );

      legacyAdapter = new PostgresAdapter({ connectionString: DSN, schema: LEGACY_SCHEMA });
      await legacyAdapter.initialize();

      const columns = await adminPool.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'capture_sessions'`,
        [LEGACY_SCHEMA],
      );
      expect(columns.rows.map((r: { column_name: string }) => r.column_name)).toContain(
        'counter_snapshots',
      );

      const legacy = await legacyAdapter.getCaptureSession(legacyId);
      expect(legacy).not.toBeNull();
      expect(legacy?.counterSnapshots).toBeUndefined();
    } finally {
      await adminPool.end();
    }
  });
});
