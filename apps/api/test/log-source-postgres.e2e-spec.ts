import { execFileSync } from 'child_process';
import { Pool } from 'pg';
import { PostgresAdapter } from '../src/storage/adapters/postgres.adapter';
import { assertLogSourceTracking } from '../src/storage/adapters/__tests__/log-source-assertions';
import { dropSchema } from './postgres-test-utils';

const DSN =
  process.env.LOG_SOURCE_POSTGRES_TEST_DSN ?? 'postgres://betterdb:devpassword@localhost:5433/betterdb';

const SCHEMA = `log_source_${process.pid}_${Date.now()}`;

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

describePostgres('slow/command log source tracking — postgres', () => {
  let adapter: PostgresAdapter;

  beforeAll(async () => {
    adapter = new PostgresAdapter({ connectionString: DSN, schema: SCHEMA });
    await adapter.initialize();
  });

  afterAll(async () => {
    await adapter.close();
    const adminPool = new Pool({ connectionString: DSN });
    await dropSchema(adminPool, SCHEMA);
    await adminPool.end();
  });

  it('filters latest ids by connection and source and keys rows by run id', async () => {
    await assertLogSourceTracking(adapter);
  });

  it('re-runs the log key migration idempotently', async () => {
    const second = new PostgresAdapter({ connectionString: DSN, schema: SCHEMA });
    await expect(second.initialize()).resolves.not.toThrow();
    await second.close();
  });
});

describePostgres('slow log key migration — postgres', () => {
  const legacySchema = `${SCHEMA}_legacy`;
  const adminPool = new Pool({ connectionString: DSN });

  afterAll(async () => {
    await dropSchema(adminPool, legacySchema);
    await adminPool.end();
  });

  it('widens a legacy key and keeps its rows', async () => {
    await adminPool.query(`CREATE SCHEMA ${legacySchema}`);
    await adminPool.query(`
      CREATE TABLE ${legacySchema}.slow_log_entries (
        pk SERIAL PRIMARY KEY,
        slowlog_id BIGINT NOT NULL,
        timestamp BIGINT NOT NULL,
        duration BIGINT NOT NULL,
        command TEXT[] NOT NULL DEFAULT '{}',
        client_address TEXT,
        client_name TEXT,
        captured_at BIGINT NOT NULL,
        source_host TEXT NOT NULL,
        source_port INTEGER NOT NULL,
        connection_id TEXT NOT NULL DEFAULT 'env-default',
        UNIQUE(slowlog_id, source_host, source_port, connection_id)
      );
      INSERT INTO ${legacySchema}.slow_log_entries (slowlog_id, timestamp, duration, captured_at, source_host, source_port, connection_id)
      VALUES (1, 100, 10, 1, '10.0.0.1', 6379, 'c1'), (2, 101, 10, 1, '10.0.0.1', 6379, 'c1');
    `);

    const adapter = new PostgresAdapter({ connectionString: DSN, schema: legacySchema });
    try {
      await adapter.initialize();
      const entry = {
        id: 1, timestamp: 200, duration: 10, command: ['GET'], clientAddress: '', clientName: '',
        capturedAt: 2, sourceHost: '10.0.0.1', sourcePort: 6379, sourceRunId: 'run-new', connectionId: 'c1',
      };
      expect(await adapter.saveSlowLogEntries([entry], 'c1')).toBe(1);
      expect(await adapter.saveSlowLogEntries([{ ...entry, sourceHost: '10.0.1.1' }], 'c1')).toBe(0);
      const rows = await adapter.getSlowLogEntries({ connectionId: 'c1', limit: 10 });
      expect(rows.map((r) => r.timestamp).sort()).toEqual([100, 101, 200]);
    } finally {
      await adapter.close();
    }
  });

  it('collapses duplicates in a legacy table without a unique key before keying it', async () => {
    const keyless = `${legacySchema}_keyless`;
    try {
      await adminPool.query(`CREATE SCHEMA ${keyless}`);
      await adminPool.query(`
        CREATE TABLE ${keyless}.slow_log_entries (
          pk SERIAL PRIMARY KEY,
          slowlog_id BIGINT NOT NULL,
          timestamp BIGINT NOT NULL,
          duration BIGINT NOT NULL,
          command TEXT[] NOT NULL DEFAULT '{}',
          client_address TEXT,
          client_name TEXT,
          captured_at BIGINT NOT NULL,
          source_host TEXT NOT NULL,
          source_port INTEGER NOT NULL,
          connection_id TEXT NOT NULL DEFAULT 'env-default'
        );
        INSERT INTO ${keyless}.slow_log_entries (slowlog_id, timestamp, duration, captured_at, source_host, source_port, connection_id)
        VALUES (1, 100, 10, 1, '10.0.0.1', 6379, 'c1'), (1, 999, 10, 1, '10.0.0.1', 6379, 'c1'),
               (2, 101, 10, 1, '10.0.0.1', 6379, 'c1');
      `);

      const adapter = new PostgresAdapter({ connectionString: DSN, schema: keyless });
      try {
        await adapter.initialize();
        const rows = await adapter.getSlowLogEntries({ connectionId: 'c1', limit: 10 });
        expect(rows.map((r) => r.timestamp).sort()).toEqual([100, 101]);
      } finally {
        await adapter.close();
      }
    } finally {
      await dropSchema(adminPool, keyless);
    }
  });
});
