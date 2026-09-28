import { execFileSync } from 'child_process';
import { Pool } from 'pg';
import { PostgresAdapter } from '../src/storage/adapters/postgres.adapter';

const DSN =
  process.env.CONNECTION_TYPE_POSTGRES_TEST_DSN ??
  'postgres://betterdb:devpassword@localhost:5433/betterdb';

const SCHEMA = `connection_type_contract_${process.pid}_${Date.now()}`;

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
  describe('connection type storage — postgres (live Postgres required)', () => {
    it('has a reachable PostgreSQL', () => {
      throw new Error(
        `PostgreSQL is required here (CI or REQUIRE_POSTGRES_TESTS=true) but ${new URL(DSN).host} is unreachable`,
      );
    });
  });
}

describePostgres('connection type storage — postgres', () => {
  let adapter: PostgresAdapter;

  beforeAll(async () => {
    adapter = new PostgresAdapter({ connectionString: DSN, schema: SCHEMA });
    await adapter.initialize();
  });

  afterAll(async () => {
    await adapter.close();
    const adminPool = new Pool({ connectionString: DSN });
    await adminPool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await adminPool.end();
  });

  it('round-trips external and defaults to direct', async () => {
    await adapter.saveConnection({
      id: 'ext',
      name: 'E',
      host: 'h',
      port: 6379,
      isDefault: false,
      createdAt: 1,
      connectionType: 'external',
    });
    await adapter.saveConnection({ id: 'dir', name: 'D', host: 'h', port: 6380, isDefault: false, createdAt: 2 });
    expect((await adapter.getConnection('ext'))?.connectionType).toBe('external');
    expect((await adapter.getConnection('dir'))?.connectionType).toBe('direct');
    expect((await adapter.getConnections()).map((c) => c.connectionType)).toEqual(['external', 'direct']);
  });

  it('re-runs the schema migration idempotently', async () => {
    const second = new PostgresAdapter({ connectionString: DSN, schema: SCHEMA });
    await expect(second.initialize()).resolves.not.toThrow();
    await second.close();
  });
});
