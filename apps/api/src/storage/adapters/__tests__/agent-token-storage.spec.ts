import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { AgentToken } from '@betterdb/shared';
import type { StoragePort } from '../../../common/interfaces/storage-port.interface';
import { loadBetterSqlite3 } from '../better-sqlite3-driver';
import { MemoryAdapter } from '../memory.adapter';
import { SqliteAdapter } from '../sqlite.adapter';

const LEGACY_AGENT_TOKENS_DDL = `CREATE TABLE agent_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'agent',
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_used_at INTEGER
)`;

function token(overrides: Partial<AgentToken> = {}): AgentToken {
  return {
    id: randomUUID(),
    name: 'claude-code',
    type: 'mcp',
    tokenHash: randomUUID(),
    createdAt: 1_000,
    expiresAt: 10_000,
    revokedAt: null,
    lastUsedAt: null,
    userId: 'user-1',
    ...overrides,
  };
}

function describeTokens(name: string, open: () => Promise<StoragePort>): void {
  describe(`agent tokens (${name})`, () => {
    let storage: StoragePort;

    beforeEach(async () => {
      storage = await open();
    });

    afterEach(async () => {
      await storage.close();
    });

    it('round-trips the owning user id', async () => {
      const saved = token();
      await storage.saveAgentToken(saved);
      expect(await storage.getAgentTokenByHash(saved.tokenHash)).toEqual(saved);
      expect(await storage.getAgentTokens('mcp')).toEqual([saved]);
    });

    it('keeps a null owner for tokens created without one', async () => {
      const saved = token({ userId: null });
      await storage.saveAgentToken(saved);
      const found = await storage.getAgentTokenByHash(saved.tokenHash);
      expect(found?.userId).toBeNull();
    });

    it('filters by type and lists newest first', async () => {
      const older = token({ createdAt: 1_000 });
      const newer = token({ createdAt: 2_000 });
      const agent = token({ type: 'agent', createdAt: 3_000 });
      await storage.saveAgentToken(older);
      await storage.saveAgentToken(newer);
      await storage.saveAgentToken(agent);
      const ids = (await storage.getAgentTokens('mcp')).map((item) => {
        return item.id;
      });
      expect(ids).toEqual([newer.id, older.id]);
      expect(await storage.getAgentTokens()).toHaveLength(3);
    });

    it('stamps revocation and last use', async () => {
      const saved = token();
      await storage.saveAgentToken(saved);
      await storage.revokeAgentToken(saved.id);
      await storage.updateAgentTokenLastUsed(saved.id);
      const found = await storage.getAgentTokenByHash(saved.tokenHash);
      expect(found?.revokedAt).toEqual(expect.any(Number));
      expect(found?.lastUsedAt).toEqual(expect.any(Number));
    });

    it('returns null for an unknown hash', async () => {
      expect(await storage.getAgentTokenByHash('missing')).toBeNull();
    });
  });
}

const sqliteDirs: string[] = [];

describeTokens('memory', async () => {
  const adapter = new MemoryAdapter();
  await adapter.initialize();
  return adapter;
});

describeTokens('sqlite', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-token-storage-'));
  sqliteDirs.push(dir);
  const adapter = new SqliteAdapter({ filepath: path.join(dir, 'test.db') });
  await adapter.initialize();
  return adapter;
});

describe('agent tokens (sqlite table created before owners existed)', () => {
  it('adds user_id and reads old rows with a null owner', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-token-legacy-'));
    sqliteDirs.push(dir);
    const filepath = path.join(dir, 'legacy.db');
    const Database = await loadBetterSqlite3();
    const legacy = new Database(filepath);
    legacy.exec(LEGACY_AGENT_TOKENS_DDL);
    legacy
      .prepare(
        "INSERT INTO agent_tokens (id, name, type, token_hash, created_at, expires_at) VALUES ('t1', 'old', 'mcp', 'hash-1', 1, 2)",
      )
      .run();
    legacy.close();

    const adapter = new SqliteAdapter({ filepath });
    await adapter.initialize();
    try {
      expect(await adapter.getAgentTokenByHash('hash-1')).toEqual(
        expect.objectContaining({ id: 't1', type: 'mcp', userId: null }),
      );
    } finally {
      await adapter.close();
    }
  });
});

afterAll(() => {
  for (const dir of sqliteDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
