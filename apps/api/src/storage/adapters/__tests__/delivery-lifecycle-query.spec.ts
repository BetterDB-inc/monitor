import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { DeliveryStatus, WebhookEventType } from '@betterdb/shared';
import type { StoragePort } from '../../../common/interfaces/storage-port.interface';
import { MemoryAdapter } from '../memory.adapter';
import { PostgresAdapter } from '../postgres.adapter';
import { SqliteAdapter } from '../sqlite.adapter';

const POSTGRES_DSN =
  process.env.MAINTENANCE_POSTGRES_TEST_DSN ??
  'postgres://betterdb:devpassword@localhost:5433/betterdb';

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

const pause = () => new Promise((resolve) => setTimeout(resolve, 10));

function describeQuery(
  name: string,
  open: () => Promise<StoragePort>,
  describeFn: jest.Describe = describe,
): void {
  describeFn(`getDeliveriesForEventsSince (${name})`, () => {
    let storage: StoragePort;
    let webhookId: string;

    beforeEach(async () => {
      storage = await open();
      const webhook = await storage.createWebhook({
        name: 'hook',
        url: 'https://example.com/h',
        enabled: true,
        events: [WebhookEventType.INSTANCE_DOWN, WebhookEventType.INSTANCE_UP],
        headers: {},
        retryPolicy: { maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 60000 },
        connectionId: 'conn-1',
      });
      webhookId = webhook.id;
    });

    afterEach(async () => {
      await storage.close();
    });

    const record = (eventType: WebhookEventType, status: DeliveryStatus, connectionId?: string) =>
      storage.createDelivery({
        webhookId,
        eventType,
        payload: { event: eventType, timestamp: Date.now(), data: { n: 1 } },
        status,
        attempts: 0,
        connectionId,
      });

    it('returns only the requested events at or after `since`, oldest first', async () => {
      const before = Date.now() - 1000;
      await record(WebhookEventType.INSTANCE_DOWN, DeliveryStatus.SUPPRESSED, 'conn-1');
      await pause();
      await record(WebhookEventType.MEMORY_CRITICAL, DeliveryStatus.SUCCESS, 'conn-1');
      await pause();
      await record(WebhookEventType.INSTANCE_UP, DeliveryStatus.SUCCESS, 'conn-1');

      const found = await storage.getDeliveriesForEventsSince(
        [WebhookEventType.INSTANCE_DOWN, WebhookEventType.INSTANCE_UP],
        before,
      );
      expect(found.map((d) => [d.eventType, d.status, d.connectionId])).toEqual([
        [WebhookEventType.INSTANCE_DOWN, DeliveryStatus.SUPPRESSED, 'conn-1'],
        [WebhookEventType.INSTANCE_UP, DeliveryStatus.SUCCESS, 'conn-1'],
      ]);
      expect(found[0].payload.data).toEqual({ n: 1 });
      expect(found[0].createdAt).toBeLessThanOrEqual(found[1].createdAt);

      expect(await storage.getDeliveriesForEventsSince([WebhookEventType.INSTANCE_DOWN], Date.now() + 60_000)).toEqual([]);
      expect(await storage.getDeliveriesForEventsSince([], before)).toEqual([]);
    });
  });
}

describeQuery('memory', async () => {
  const adapter = new MemoryAdapter();
  await adapter.initialize();
  return adapter;
});

const sqliteFiles: string[] = [];

describeQuery('sqlite', async () => {
  const filepath = path.join(os.tmpdir(), `delivery-lifecycle-${randomUUID()}.db`);
  sqliteFiles.push(filepath);
  const adapter = new SqliteAdapter({ filepath });
  await adapter.initialize();
  return adapter;
});

const postgresSchemas: string[] = [];

describeQuery(
  'postgres',
  async () => {
    const schema = `delivery_lifecycle_${randomUUID().replace(/-/g, '')}`;
    postgresSchemas.push(schema);
    const adapter = new PostgresAdapter({ connectionString: POSTGRES_DSN, schema });
    await adapter.initialize();
    return adapter;
  },
  isReachable(POSTGRES_DSN) ? describe : describe.skip,
);

afterAll(async () => {
  for (const filepath of sqliteFiles) {
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
    }
  }
  if (postgresSchemas.length === 0) {
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
