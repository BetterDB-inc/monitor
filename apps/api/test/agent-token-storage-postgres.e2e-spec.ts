import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import type { AgentToken } from '@betterdb/shared';
import { PostgresAdapter } from '../src/storage/adapters/postgres.adapter';

const CONNECTION_STRING =
  process.env.AGENT_TOKEN_POSTGRES_TEST_DSN ??
  'postgres://betterdb:devpassword@localhost:5433/betterdb';

const SCHEMA = `agent_token_contract_${process.pid}_${Date.now()}`;

function legacyAgentTokensDdl(schema: string): string {
  return `CREATE TABLE ${schema}.agent_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  revoked_at BIGINT,
  last_used_at BIGINT
)`;
}

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

const reachable = isReachable(CONNECTION_STRING);
const describePostgres = reachable ? describe : describe.skip;

if (reachable === false && postgresRequired() === true) {
  describe('PostgresAdapter agent tokens (live Postgres required)', () => {
    it('has a reachable PostgreSQL', () => {
      throw new Error(
        `PostgreSQL is required here (CI or REQUIRE_POSTGRES_TESTS=true) but ${new URL(CONNECTION_STRING).host} is unreachable`,
      );
    });
  });
}

function token(overrides: Partial<AgentToken> = {}): AgentToken {
  return {
    id: randomUUID(),
    name: 'claude-code',
    type: 'mcp',
    tokenHash: randomUUID(),
    createdAt: 1_700_000_000_000,
    expiresAt: 1_800_000_000_000,
    revokedAt: null,
    lastUsedAt: null,
    userId: 'user-1',
    ...overrides,
  };
}

describePostgres('PostgresAdapter agent tokens (live Postgres)', () => {
  let adminPool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: CONNECTION_STRING });
    await adminPool.query(`CREATE SCHEMA ${SCHEMA}`);
  });

  afterAll(async () => {
    await adminPool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await adminPool.end();
  });

  it('migrates a legacy table and round-trips owners with numeric timestamps', async () => {
    await adminPool.query(legacyAgentTokensDdl(SCHEMA));
    await adminPool.query(
      `INSERT INTO ${SCHEMA}.agent_tokens (id, name, token_hash, created_at, expires_at) VALUES ('t1', 'old', 'hash-1', 1, 2)`,
    );

    const adapter = new PostgresAdapter({ connectionString: CONNECTION_STRING, schema: SCHEMA });
    await adapter.initialize();
    try {
      expect(await adapter.getAgentTokenByHash('hash-1')).toEqual({
        id: 't1',
        name: 'old',
        type: 'agent',
        tokenHash: 'hash-1',
        createdAt: 1,
        expiresAt: 2,
        revokedAt: null,
        lastUsedAt: null,
        userId: null,
      });

      const saved = token();
      await adapter.saveAgentToken(saved);
      expect(await adapter.getAgentTokenByHash(saved.tokenHash)).toEqual(saved);

      await adapter.saveAgentToken({ ...saved, userId: 'user-2' });
      const listed = await adapter.getAgentTokens('mcp');
      expect(listed).toEqual([{ ...saved, userId: 'user-2' }]);
      expect(await adapter.getAgentTokens()).toHaveLength(2);

      await adapter.revokeAgentToken(saved.id);
      await adapter.updateAgentTokenLastUsed(saved.id);
      const found = await adapter.getAgentTokenByHash(saved.tokenHash);
      expect(typeof found?.revokedAt).toBe('number');
      expect(typeof found?.lastUsedAt).toBe('number');

      const isolation = await adminPool.query(
        `SELECT table_schema FROM information_schema.columns WHERE table_name = 'agent_tokens' AND column_name = 'user_id' AND table_schema = $1`,
        [SCHEMA],
      );
      expect(isolation.rows).toHaveLength(1);
    } finally {
      await adapter.close();
    }
  });
});
