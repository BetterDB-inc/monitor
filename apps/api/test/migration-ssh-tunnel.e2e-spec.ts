import { execFileSync } from 'child_process';
import { lookup } from 'dns/promises';
import { connect } from 'net';
import { join } from 'path';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import Valkey from 'iovalkey';
import type { MigrationValidationResult } from '@betterdb/shared';
import { SshTunnelService } from '../src/database/ssh/ssh-tunnel.service';
import { createTestApp } from './test-utils';

/**
 * Migration SSH tunnel E2E — runs analysis, a command-mode migration and
 * validation against instances that BetterDB can reach only through an SSH
 * bastion. The tunnelled connections are registered under hostnames that
 * resolve only inside the compose network, so a job that dialled the stored
 * host directly could not connect at all.
 *
 * Requires Docker. Skipped unless RUN_SSH_TUNNEL_TESTS=true is set.
 * Run via:  pnpm test:migration-ssh-tunnel
 */

const RUN = process.env.RUN_SSH_TUNNEL_TESTS === 'true';

const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const COMPOSE_FILE = join(PROJECT_ROOT, 'docker-compose.migration-ssh-e2e.yml');
const COMPOSE_PROJECT = 'migration-ssh-e2e';

const BASTION_PORT = 2299;
const BASTION_USER = 'tunnel';
const BASTION_PASSWORD = 'tunnel-e2e';
const INTERNAL_PORT = 6379;
const SOURCE = { internalHost: 'mig-tunnelled-source', publishedPort: 6992 };
const TARGET = { internalHost: 'mig-tunnelled-target', publishedPort: 6993 };
const SEEDED_KEYS = 6;

function compose(...args: string[]): string {
  return execFileSync('docker', ['compose', '-p', COMPOSE_PROJECT, '-f', COMPOSE_FILE, ...args], {
    encoding: 'utf-8',
    timeout: 180_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readSshBanner(): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: BASTION_PORT });
    socket.setTimeout(2_000, () => socket.destroy(new Error('timed out')));
    socket.once('data', (chunk) => {
      socket.destroy();
      resolve(chunk.toString('utf8'));
    });
    socket.once('error', reject);
  });
}

async function waitForBastion(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no attempt';
  while (Date.now() < deadline) {
    try {
      if ((await readSshBanner()).startsWith('SSH-')) return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(1_000);
  }
  throw new Error(`SSH bastion on port ${BASTION_PORT} not ready: ${lastError}`);
}

async function openPublished(port: number): Promise<Valkey> {
  const client = new Valkey({ host: '127.0.0.1', port, lazyConnect: true, connectTimeout: 2_000 });
  await client.connect();
  return client;
}

async function waitForValkey(port: number, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const client = await openPublished(port);
      await client.ping();
      await client.quit();
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error(`Valkey on port ${port} not ready after ${timeoutMs}ms`);
}

async function seedKeys(client: Valkey): Promise<void> {
  await client.set('tun:str1', 'value1');
  await client.set('tun:str2', 'value2');
  await client.hset('tun:hash1', 'f1', 'v1', 'f2', 'v2');
  await client.rpush('tun:list1', 'a', 'b', 'c');
  await client.sadd('tun:set1', 'm1', 'm2', 'm3');
  await client.zadd('tun:zset1', 1, 'z1', 2, 'z2');
}

async function verifyKeys(client: Valkey): Promise<void> {
  expect(await client.get('tun:str1')).toBe('value1');
  expect(await client.get('tun:str2')).toBe('value2');
  expect(await client.hgetall('tun:hash1')).toEqual({ f1: 'v1', f2: 'v2' });
  expect(await client.lrange('tun:list1', 0, -1)).toEqual(['a', 'b', 'c']);
  expect((await client.smembers('tun:set1')).sort()).toEqual(['m1', 'm2', 'm3']);
  expect(await client.zrange('tun:zset1', '0', '-1')).toEqual(['z1', 'z2']);
}

function tunnelInput() {
  return {
    enabled: true,
    host: '127.0.0.1',
    port: BASTION_PORT,
    username: BASTION_USER,
    authMethod: 'password',
    password: BASTION_PASSWORD,
  };
}

interface FinishedJob {
  id: string;
  status: string;
  keysTransferred?: number;
  error?: string;
}

(RUN ? describe : describe.skip)('Migration SSH tunnel E2E', () => {
  let app: NestFastifyApplication;
  const connIds: Record<string, string> = {};

  async function register(key: string, body: Record<string, unknown>): Promise<void> {
    const res = await request(app.getHttpServer()).post('/connections').send(body);
    expect([200, 201]).toContain(res.status);
    connIds[key] = res.body.id;
  }

  async function runAnalysis(sourceId: string, targetId: string): Promise<{ status: string; blockingCount: number }> {
    const start = await request(app.getHttpServer())
      .post('/migration/analysis')
      .send({ sourceConnectionId: sourceId, targetConnectionId: targetId, scanSampleSize: 1000 });
    expect([200, 201]).toContain(start.status);
    for (let i = 0; i < 60; i++) {
      const poll = await request(app.getHttpServer()).get(`/migration/analysis/${start.body.id}`);
      expect(poll.status).toBe(200);
      if (poll.body.status === 'completed' || poll.body.status === 'failed') return poll.body;
      await sleep(500);
    }
    throw new Error(`Analysis ${start.body.id} did not finish`);
  }

  async function runMigration(sourceId: string, targetId: string): Promise<FinishedJob> {
    const start = await request(app.getHttpServer())
      .post('/migration/execution')
      .send({ sourceConnectionId: sourceId, targetConnectionId: targetId, mode: 'command' });
    expect([200, 201]).toContain(start.status);
    for (let i = 0; i < 120; i++) {
      const poll = await request(app.getHttpServer()).get(`/migration/execution/${start.body.id}`);
      expect(poll.status).toBe(200);
      if (poll.body.status === 'completed' || poll.body.status === 'failed') {
        return { ...poll.body, id: start.body.id };
      }
      await sleep(500);
    }
    throw new Error(`Migration ${start.body.id} did not finish`);
  }

  async function runValidation(sourceId: string, targetId: string): Promise<MigrationValidationResult> {
    const start = await request(app.getHttpServer())
      .post('/migration/validation')
      .send({ sourceConnectionId: sourceId, targetConnectionId: targetId });
    expect([200, 201]).toContain(start.status);
    for (let i = 0; i < 60; i++) {
      const poll = await request(app.getHttpServer()).get(`/migration/validation/${start.body.id}`);
      expect(poll.status).toBe(200);
      const result = poll.body as MigrationValidationResult;
      if (result.status === 'completed' || result.status === 'failed') return result;
      await sleep(500);
    }
    throw new Error(`Validation ${start.body.id} did not finish`);
  }

  async function migrateAndVerify(sourceKey: string, targetKey: string): Promise<void> {
    const sourceId = connIds[sourceKey];
    const targetId = connIds[targetKey];

    const flush = await openPublished(TARGET.publishedPort);
    await flush.flushall();
    await flush.quit();

    const analysis = await runAnalysis(sourceId, targetId);
    expect(analysis.status).toBe('completed');
    expect(analysis.blockingCount).toBe(0);

    const migration = await runMigration(sourceId, targetId);
    expect(migration.error).toBeUndefined();
    expect(migration.status).toBe('completed');
    expect(migration.keysTransferred).toBe(SEEDED_KEYS);

    const tunnels = app.get(SshTunnelService);
    expect(tunnels.hasTunnel(`migration:${migration.id}:source`)).toBe(false);
    expect(tunnels.hasTunnel(`migration:${migration.id}:target`)).toBe(false);

    const validation = await runValidation(sourceId, targetId);
    expect(validation.status).toBe('completed');
    expect(validation.keyCount).toMatchObject({
      sourceKeys: SEEDED_KEYS,
      targetKeys: SEEDED_KEYS,
      discrepancy: 0,
    });
    expect(validation.passed).toBe(true);

    const target = await openPublished(TARGET.publishedPort);
    try {
      await verifyKeys(target);
    } finally {
      await target.quit();
    }
  }

  beforeAll(async () => {
    try {
      compose('down', '--remove-orphans', '--volumes');
    } catch {
      // Nothing running yet.
    }
    compose('up', '-d');

    await Promise.all([
      waitForBastion(),
      waitForValkey(SOURCE.publishedPort),
      waitForValkey(TARGET.publishedPort),
    ]);

    const source = await openPublished(SOURCE.publishedPort);
    await source.flushall();
    await seedKeys(source);
    await source.quit();

    process.env.BETTERDB_LICENSE_KEY = 'test-ssh-tunnel-key';
    process.env.LICENSE_ALLOW_UNSIGNED = 'true';
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ valid: true, tier: 'pro', expiresAt: null }),
    } as Response);

    app = await createTestApp();

    await register('tunnelledSource', {
      name: 'Tunnel Source',
      host: SOURCE.internalHost,
      port: INTERNAL_PORT,
      sshTunnel: tunnelInput(),
    });
    await register('tunnelledTarget', {
      name: 'Tunnel Target',
      host: TARGET.internalHost,
      port: INTERNAL_PORT,
      sshTunnel: tunnelInput(),
    });
    await register('directTarget', {
      name: 'Direct Target',
      host: '127.0.0.1',
      port: TARGET.publishedPort,
    });
  }, 300_000);

  afterAll(async () => {
    for (const id of Object.values(connIds)) {
      try {
        await request(app.getHttpServer()).delete(`/connections/${id}`);
      } catch {
        // Best effort.
      }
    }
    if (app) await app.close();

    delete process.env.BETTERDB_LICENSE_KEY;
    delete process.env.LICENSE_ALLOW_UNSIGNED;
    jest.restoreAllMocks();

    try {
      compose('down', '--remove-orphans', '--volumes');
    } catch {
      // Best effort.
    }
  }, 120_000);

  it('cannot resolve the tunnelled hosts without the bastion', async () => {
    await expect(lookup(SOURCE.internalHost)).rejects.toThrow();
    await expect(lookup(TARGET.internalHost)).rejects.toThrow();
  });

  it('migrates a tunnelled source into a directly reachable target', async () => {
    await migrateAndVerify('tunnelledSource', 'directTarget');
  }, 120_000);

  it('migrates when both the source and the target are tunnelled', async () => {
    await migrateAndVerify('tunnelledSource', 'tunnelledTarget');
  }, 120_000);
});
