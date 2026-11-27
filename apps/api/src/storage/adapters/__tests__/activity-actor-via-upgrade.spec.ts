import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import type { ActivityRecord } from '../../../common/interfaces/activity-repository.interface';
import { SqliteAdapter } from '../sqlite.adapter';
import { PostgresAdapter } from '../postgres.adapter';
import { loadBetterSqlite3 } from '../better-sqlite3-driver';
import { adapters } from './anomaly-storage-adapters';

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-actor-via-'));
  tempDirs.push(dir);
  return path.join(dir, 'db.sqlite');
}

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function record(id: string, overrides: Partial<ActivityRecord> = {}): ActivityRecord {
  return {
    id,
    occurredAt: 1_000,
    actorUserId: 'owner-id',
    actorEmail: 'owner@example.com',
    actorVia: 'session',
    tokenId: null,
    action: 'connection.create',
    targetType: 'connection',
    targetId: 'conn-1',
    connectionId: 'conn-1',
    statusCode: 201,
    ip: '127.0.0.1',
    details: { method: 'POST' },
    ...overrides,
  };
}

const system = record('system-row', {
  occurredAt: 2_000,
  actorUserId: 'system:placement',
  actorEmail: 'placement-autopilot',
  actorVia: 'system',
  action: 'placement.action.start',
  targetType: 'placement_action',
  targetId: 'a1',
  ip: '',
});

const anonymous = record('anonymous-row', {
  occurredAt: 3_000,
  actorUserId: 'anonymous',
  actorEmail: 'anonymous',
  actorVia: 'anonymous',
  action: 'placement.mode.set',
});

const OLD_ACTIVITY_EVENTS = `
  CREATE TABLE activity_events (
    id TEXT PRIMARY KEY,
    occurred_at INTEGER NOT NULL,
    actor_user_id TEXT NOT NULL,
    actor_email TEXT NOT NULL,
    actor_via TEXT NOT NULL CHECK (actor_via IN ('session', 'token', 'cli')),
    token_id TEXT,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    connection_id TEXT,
    status_code INTEGER NOT NULL,
    ip TEXT NOT NULL,
    details TEXT NOT NULL
  );
  CREATE INDEX idx_activity_events_occurred ON activity_events(occurred_at);
  CREATE INDEX idx_activity_events_actor ON activity_events(actor_user_id, occurred_at);
  CREATE INDEX idx_activity_events_connection ON activity_events(connection_id, occurred_at);
`;

describe.each([
  ['better-sqlite3', (filepath: string) => new SqliteAdapter({ filepath })],
  ['libsql', (filepath: string) => new SqliteAdapter({ url: `file:${filepath}` })],
])('sqlite activity_events upgrade on %s', (_driver, open) => {
  async function oldDatabase(): Promise<string> {
    const filepath = tempDbPath();
    const first = open(filepath);
    await first.initialize();
    await first.close();

    const Database = await loadBetterSqlite3();
    const raw = new Database(filepath);
    raw.exec('DROP TABLE activity_events');
    raw.exec(OLD_ACTIVITY_EVENTS);
    raw
      .prepare(
        `INSERT INTO activity_events VALUES ('old-row', 500, 'u1', 'u1@example.com', 'token', 'tok-1',
          'connection.delete', 'connection', 'conn-1', 'conn-1', 204, '10.0.0.1', '{"method":"DELETE"}')`,
      )
      .run();
    expect(() =>
      raw
        .prepare(
          `INSERT INTO activity_events VALUES ('refused', 1, 'system:placement', 'placement-autopilot',
            'system', NULL, 'x', NULL, NULL, NULL, 200, '', '{}')`,
        )
        .run(),
    ).toThrow();
    raw.close();
    return filepath;
  }

  it('keeps the stored rows and takes system and anonymous rows', async () => {
    const filepath = await oldDatabase();
    const upgraded = open(filepath);
    await upgraded.initialize();
    const repository = upgraded.getActivityRepository();
    await repository.insert(system);
    await repository.insert(anonymous);

    const { items } = await repository.list({ limit: 10 });
    expect(items.map((item) => item.id)).toEqual(['anonymous-row', 'system-row', 'old-row']);
    expect(items[2]).toMatchObject({
      actorVia: 'token',
      tokenId: 'tok-1',
      statusCode: 204,
      details: { method: 'DELETE' },
    });
    await upgraded.close();
  });

  it('keeps the activity indexes and rebuilds only once', async () => {
    const filepath = await oldDatabase();
    const upgraded = open(filepath);
    await upgraded.initialize();
    await upgraded.getActivityRepository().insert(system);
    await upgraded.close();

    const again = open(filepath);
    await again.initialize();
    expect((await again.getActivityRepository().list({ limit: 10 })).items).toHaveLength(2);
    await again.close();

    const Database = await loadBetterSqlite3();
    const raw = new Database(filepath);
    const indexes = raw
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'activity_events'`,
      )
      .all()
      .map((row) => (row as { name: string }).name)
      .sort();
    const tables = raw
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'activity_events%'`,
      )
      .all();
    raw.close();
    expect(indexes).toEqual([
      'idx_activity_events_actor',
      'idx_activity_events_connection',
      'idx_activity_events_occurred',
      'sqlite_autoindex_activity_events_1',
    ]);
    expect(tables).toEqual([{ name: 'activity_events' }]);
  });
});

const POSTGRES_DSN =
  process.env.ANOMALY_STORAGE_POSTGRES_TEST_DSN ??
  'postgres://betterdb:devpassword@localhost:5433/betterdb';
const postgresReachable = adapters.some(([name]) => name === 'PostgresAdapter');

(postgresReachable ? describe : describe.skip)('postgres activity_events upgrade', () => {
  const schema = `activity_via_${randomUUID().replace(/-/g, '')}`;
  const pool = new Pool({ connectionString: POSTGRES_DSN });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  });

  const open = async () => {
    const adapter = new PostgresAdapter({ connectionString: POSTGRES_DSN, schema });
    await adapter.initialize();
    return adapter;
  };

  it('keeps the stored rows and takes system and anonymous rows', async () => {
    const first = await open();
    await first.close();
    await pool.query(
      `ALTER TABLE ${schema}.activity_events DROP CONSTRAINT activity_events_actor_via_check`,
    );
    await pool.query(
      `ALTER TABLE ${schema}.activity_events ADD CONSTRAINT activity_events_actor_via_check
       CHECK (actor_via IN ('session', 'token', 'cli'))`,
    );
    await pool.query(
      `INSERT INTO ${schema}.activity_events VALUES ('old-row', 500, 'u1', 'u1@example.com', 'token',
        'tok-1', 'connection.delete', 'connection', 'conn-1', 'conn-1', 204, '10.0.0.1', '{}')`,
    );

    const upgraded = await open();
    await upgraded.getActivityRepository().insert(system);
    await upgraded.getActivityRepository().insert(anonymous);
    const { items } = await upgraded.getActivityRepository().list({ limit: 10 });
    expect(items.map((item) => item.id)).toEqual(['anonymous-row', 'system-row', 'old-row']);
    await upgraded.close();

    const again = await open();
    const checks = await pool.query(
      `SELECT conname FROM pg_constraint c JOIN pg_class t ON c.conrelid = t.oid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE t.relname = 'activity_events' AND n.nspname = $1 AND c.contype = 'c'`,
      [schema],
    );
    expect(checks.rows).toEqual([{ conname: 'activity_events_actor_via_check' }]);
    await again.close();
  });
});
