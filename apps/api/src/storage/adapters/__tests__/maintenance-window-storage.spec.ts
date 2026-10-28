import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { WebhookEventType, type MaintenanceWindow } from '@betterdb/shared';
import type { MaintenanceWindowRepository } from '../../../common/interfaces/maintenance-window-repository.interface';
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

function window(overrides: Partial<MaintenanceWindow> = {}): MaintenanceWindow {
  return {
    id: randomUUID(),
    name: 'Upgrade',
    reason: 'CHG-1234',
    connectionId: 'conn-1',
    events: [WebhookEventType.INSTANCE_DOWN, WebhookEventType.FAILOVER_STARTED],
    startsAt: 1_000,
    endsAt: 5_000,
    endedAt: null,
    createdBy: 'ops@example.com',
    createdAt: 900,
    updatedAt: 900,
    ...overrides,
  };
}

function describeRepository(
  name: string,
  open: () => Promise<StoragePort>,
  describeFn: jest.Describe = describe,
): void {
  describeFn(`MaintenanceWindowRepository (${name})`, () => {
    let storage: StoragePort;
    let repository: MaintenanceWindowRepository;

    beforeEach(async () => {
      storage = await open();
      repository = storage.getMaintenanceWindowRepository();
    });

    afterEach(async () => {
      await storage.close();
    });

    it('round-trips every field, including nulls and an empty event list', async () => {
      const full = window({ id: 'full' });
      const sparse = window({
        id: 'sparse',
        reason: null,
        connectionId: null,
        events: [],
        createdBy: null,
        startsAt: 500,
      });
      await repository.save(full);
      await repository.save(sparse);

      expect(await repository.get('full')).toEqual(full);
      expect(await repository.get('sparse')).toEqual(sparse);
      expect(await repository.get('missing')).toBeNull();
    });

    it('lists newest start first', async () => {
      await repository.save(window({ id: 'a', startsAt: 100, endsAt: 200 }));
      await repository.save(window({ id: 'c', startsAt: 300, endsAt: 400 }));
      await repository.save(window({ id: 'b', startsAt: 200, endsAt: 300 }));
      expect((await repository.list()).map((row) => row.id)).toEqual(['c', 'b', 'a']);
    });

    it('updates in place on save with the same id', async () => {
      const original = window({ id: 'x' });
      await repository.save(original);
      await repository.save({ ...original, name: 'Renamed', endedAt: 3_000, updatedAt: 3_000 });
      const stored = await repository.get('x');
      expect(stored).toMatchObject({ name: 'Renamed', endedAt: 3_000, updatedAt: 3_000, createdAt: 900 });
      expect(await repository.list()).toHaveLength(1);
    });

    it('deletes by id and reports whether anything was deleted', async () => {
      await repository.save(window({ id: 'x' }));
      expect(await repository.delete('x')).toBe(true);
      expect(await repository.delete('x')).toBe(false);
    });

    it('prunes by effective end, honouring an early end', async () => {
      await repository.save(window({ id: 'ended-early', endsAt: 10_000, endedAt: 2_000 }));
      await repository.save(window({ id: 'ended-on-time', endsAt: 2_500 }));
      await repository.save(window({ id: 'open', endsAt: 10_000 }));

      expect(await repository.prune(3_000)).toBe(2);
      expect((await repository.list()).map((row) => row.id)).toEqual(['open']);
    });

    it('isolates stored rows from caller mutation', async () => {
      const original = window({ id: 'x' });
      await repository.save(original);
      original.events.push(WebhookEventType.MEMORY_CRITICAL);
      const read = await repository.get('x');
      read!.events.push(WebhookEventType.MEMORY_CRITICAL);
      expect((await repository.get('x'))!.events).toEqual([
        WebhookEventType.INSTANCE_DOWN,
        WebhookEventType.FAILOVER_STARTED,
      ]);
    });
  });
}

describeRepository('memory', async () => {
  const adapter = new MemoryAdapter();
  await adapter.initialize();
  return adapter;
});

const sqliteFiles: string[] = [];

describeRepository('sqlite', async () => {
  const filepath = path.join(os.tmpdir(), `maintenance-windows-${randomUUID()}.db`);
  sqliteFiles.push(filepath);
  const adapter = new SqliteAdapter({ filepath });
  await adapter.initialize();
  return adapter;
});

const postgresSchemas: string[] = [];

describeRepository(
  'postgres',
  async () => {
    const schema = `maintenance_windows_${randomUUID().replace(/-/g, '')}`;
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
