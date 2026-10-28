import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { Pool } from 'pg';
import { WebhookEventType, WebhookPayloadFormat } from '@betterdb/shared';
import type { StoragePort } from '../../../common/interfaces/storage-port.interface';
import { MemoryAdapter } from '../memory.adapter';
import { PostgresAdapter } from '../postgres.adapter';
import { SqliteAdapter } from '../sqlite.adapter';

const POSTGRES_DSN =
  process.env.WEBHOOK_POSTGRES_TEST_DSN ?? 'postgres://betterdb:devpassword@localhost:5433/betterdb';
const ROUTING_KEY = 'R0123456789ABCDEFGHIJKLMNOPQRSTU';
const OTHER_KEY = 'Z9876543210ZYXWVUTSRQPONMLKJIHGF';

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

const baseWebhook = {
  name: 'Pager',
  url: 'https://events.pagerduty.com/v2/enqueue',
  secret: 'whsec_test',
  enabled: true,
  events: [WebhookEventType.INSTANCE_DOWN],
  headers: {},
  retryPolicy: { maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 60000 },
  connectionId: 'conn-1',
};

function describeAdapter(
  name: string,
  open: () => Promise<StoragePort>,
  describeFn: jest.Describe = describe,
): void {
  describeFn(`webhook routing key (${name})`, () => {
    let storage: StoragePort;

    beforeEach(async () => {
      storage = await open();
    });

    afterEach(async () => {
      await storage.close();
    });

    it('round-trips the routing key and the pagerduty format', async () => {
      const created = await storage.createWebhook({
        ...baseWebhook,
        payloadFormat: WebhookPayloadFormat.PAGERDUTY,
        routingKey: ROUTING_KEY,
      });
      expect(created.routingKey).toBe(ROUTING_KEY);
      const read = await storage.getWebhook(created.id);
      expect(read?.payloadFormat).toBe(WebhookPayloadFormat.PAGERDUTY);
      expect(read?.routingKey).toBe(ROUTING_KEY);
      const [byEvent] = await storage.getWebhooksByEvent(WebhookEventType.INSTANCE_DOWN, 'conn-1');
      expect(byEvent.routingKey).toBe(ROUTING_KEY);
    });

    it('stores no routing key for other formats', async () => {
      const created = await storage.createWebhook({ ...baseWebhook, payloadFormat: WebhookPayloadFormat.TEAMS });
      expect((await storage.getWebhook(created.id))?.routingKey).toBeUndefined();
    });

    it('updates the routing key and leaves it alone when the update omits it', async () => {
      const created = await storage.createWebhook({
        ...baseWebhook,
        payloadFormat: WebhookPayloadFormat.PAGERDUTY,
        routingKey: ROUTING_KEY,
      });
      await storage.updateWebhook(created.id, { name: 'Renamed' });
      expect((await storage.getWebhook(created.id))?.routingKey).toBe(ROUTING_KEY);
      await storage.updateWebhook(created.id, { routingKey: OTHER_KEY });
      expect((await storage.getWebhook(created.id))?.routingKey).toBe(OTHER_KEY);
    });
  });
}

describeAdapter('memory', async () => {
  const adapter = new MemoryAdapter();
  await adapter.initialize();
  return adapter;
});

const sqliteFiles: string[] = [];

describeAdapter('sqlite', async () => {
  const filepath = path.join(os.tmpdir(), `webhook-routing-key-${randomUUID()}.db`);
  sqliteFiles.push(filepath);
  const adapter = new SqliteAdapter({ filepath });
  await adapter.initialize();
  return adapter;
});

const postgresSchemas: string[] = [];
const postgresReachable = isReachable(POSTGRES_DSN);

describeAdapter(
  'postgres',
  async () => {
    const schema = `webhook_rk_${randomUUID().replace(/-/g, '')}`;
    postgresSchemas.push(schema);
    const adapter = new PostgresAdapter({ connectionString: POSTGRES_DSN, schema });
    await adapter.initialize();
    return adapter;
  },
  postgresReachable ? describe : describe.skip,
);

describe('webhook routing key column migration', () => {
  it('adds routing_key to a SQLite webhooks table created before it existed', async () => {
    const filepath = path.join(os.tmpdir(), `webhook-routing-key-legacy-${randomUUID()}.db`);
    sqliteFiles.push(filepath);
    const legacy = new Database(filepath);
    legacy.exec(`
      CREATE TABLE webhooks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        secret TEXT,
        enabled INTEGER DEFAULT 1,
        events TEXT NOT NULL,
        headers TEXT DEFAULT '{}',
        retry_policy TEXT NOT NULL,
        payload_format TEXT DEFAULT 'generic',
        connection_id TEXT NOT NULL DEFAULT 'env-default',
        created_at INTEGER,
        updated_at INTEGER
      );
      INSERT INTO webhooks (id, name, url, events, retry_policy, created_at, updated_at)
        VALUES ('legacy', 'Old', 'https://example.com', '["instance.down"]', '{}', 1, 1);
    `);
    legacy.close();

    const adapter = new SqliteAdapter({ filepath });
    await adapter.initialize();
    try {
      expect((await adapter.getWebhook('legacy'))?.routingKey).toBeUndefined();
      await adapter.updateWebhook('legacy', { routingKey: ROUTING_KEY });
      expect((await adapter.getWebhook('legacy'))?.routingKey).toBe(ROUTING_KEY);
    } finally {
      await adapter.close();
    }
  });

  (postgresReachable ? it : it.skip)(
    'adds routing_key to a Postgres webhooks table created before it existed',
    async () => {
      const schema = `webhook_rk_legacy_${randomUUID().replace(/-/g, '')}`;
      postgresSchemas.push(schema);
      const pool = new Pool({ connectionString: POSTGRES_DSN });
      try {
        await pool.query(`CREATE SCHEMA ${schema}`);
        await pool.query(`
          CREATE TABLE ${schema}.webhooks (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            name VARCHAR(255) NOT NULL,
            url TEXT NOT NULL,
            secret TEXT,
            enabled BOOLEAN DEFAULT true,
            events TEXT[] NOT NULL,
            headers JSONB DEFAULT '{}',
            retry_policy JSONB NOT NULL,
            payload_format VARCHAR(20) DEFAULT 'generic',
            connection_id TEXT NOT NULL DEFAULT 'env-default',
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
          )`);
      } finally {
        await pool.end();
      }

      const adapter = new PostgresAdapter({ connectionString: POSTGRES_DSN, schema });
      await adapter.initialize();
      try {
        const created = await adapter.createWebhook({
          ...baseWebhook,
          payloadFormat: WebhookPayloadFormat.PAGERDUTY,
          routingKey: ROUTING_KEY,
        });
        expect((await adapter.getWebhook(created.id))?.routingKey).toBe(ROUTING_KEY);
      } finally {
        await adapter.close();
      }
    },
  );
});

afterAll(async () => {
  for (const filepath of sqliteFiles) {
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
    }
  }
  if (postgresSchemas.length === 0 || !postgresReachable) {
    return;
  }
  const pool = new Pool({ connectionString: POSTGRES_DSN });
  try {
    for (const schema of postgresSchemas) {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  } finally {
    await pool.end();
  }
});
