import { execFileSync } from 'child_process';
import { Pool } from 'pg';
import { PostgresAdapter } from '../src/storage/adapters/postgres.adapter';
import { runNamespaceStorageContract } from '../src/session-explorer/__tests__/namespace-storage-contract';

const DSN =
  process.env.SESSION_NAMESPACE_POSTGRES_TEST_DSN ??
  process.env.SCALING_READINESS_POSTGRES_TEST_DSN ??
  'postgres://betterdb:devpassword@localhost:5433/betterdb';

const SCHEMA = `session_namespace_contract_${process.pid}_${Date.now()}`;

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
  describe('session namespace storage — postgres (live Postgres required)', () => {
    it('has a reachable PostgreSQL', () => {
      throw new Error(
        `PostgreSQL is required here (CI or REQUIRE_POSTGRES_TESTS=true) but ${new URL(DSN).host} is unreachable`,
      );
    });
  });
}

describePostgres('session namespace storage — postgres', () => {
  let adminPool: Pool;
  let adapter: PostgresAdapter;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: DSN });
    await adminPool.query(`CREATE SCHEMA ${SCHEMA}`);
    adapter = new PostgresAdapter({ connectionString: DSN, schema: SCHEMA });
    await adapter.initialize();
  });

  beforeEach(async () => {
    await adminPool.query(`DELETE FROM ${SCHEMA}.session_explorer_namespaces`);
  });

  afterAll(async () => {
    await adapter.close();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await adminPool.end();
  });

  runNamespaceStorageContract(() => adapter);
});
