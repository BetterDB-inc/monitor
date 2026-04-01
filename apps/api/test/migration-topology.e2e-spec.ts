import { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import Valkey, { Cluster } from 'iovalkey';
import { execSync } from 'child_process';
import { join } from 'path';
import { createTestApp } from './test-utils';

/**
 * Migration Topology E2E — verifies command-mode migration across all four
 * topology combinations:
 *
 *   standalone → standalone
 *   standalone → cluster
 *   cluster   → standalone
 *   cluster   → cluster
 *
 * Requires Docker.  Skipped unless RUN_TOPOLOGY_TESTS=true is set.
 * Run via:  pnpm test:migration-topology
 */

const RUN = process.env.RUN_TOPOLOGY_TESTS === 'true';

const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const COMPOSE_FILE = join(PROJECT_ROOT, 'docker-compose.migration-e2e.yml');
const COMPOSE_PROJECT = 'migration-e2e';

const SRC_STANDALONE_PORT = 6990;
const TGT_STANDALONE_PORT = 6991;
const SRC_CLUSTER_PORT = 7301; // seed node
const TGT_CLUSTER_PORT = 7401; // seed node

// ── Docker helpers ──────────────────────────────────────────────────

function compose(cmd: string): string {
  return execSync(
    `docker compose -p ${COMPOSE_PROJECT} -f "${COMPOSE_FILE}" ${cmd}`,
    { encoding: 'utf-8', timeout: 120_000, stdio: ['pipe', 'pipe', 'pipe'] },
  );
}

// ── Connection helpers ──────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function waitForStandalone(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const c = new Valkey({ host: '127.0.0.1', port, lazyConnect: true, connectTimeout: 2_000 });
      await c.connect();
      await c.ping();
      await c.quit();
      return;
    } catch { /* retry */ }
    await sleep(500);
  }
  throw new Error(`Standalone on port ${port} not ready after ${timeoutMs}ms`);
}

async function waitForCluster(port: number, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const c = new Valkey({ host: '127.0.0.1', port, lazyConnect: true, connectTimeout: 2_000 });
      await c.connect();
      const info = (await c.call('CLUSTER', 'INFO')) as string;
      await c.quit();
      if (info.includes('cluster_state:ok')) return;
    } catch { /* retry */ }
    await sleep(1_000);
  }
  throw new Error(`Cluster on port ${port} not ready after ${timeoutMs}ms`);
}

// ── Client factories ────────────────────────────────────────────────

async function openClient(port: number, isCluster: boolean): Promise<Valkey> {
  if (isCluster) {
    const cluster = new Cluster(
      [{ host: '127.0.0.1', port }],
      { lazyConnect: true },
    );
    await cluster.connect();
    return cluster as unknown as Valkey;
  }
  const client = new Valkey({ host: '127.0.0.1', port, lazyConnect: true });
  await client.connect();
  return client;
}

// ── Key seed / verify helpers ───────────────────────────────────────

async function seedKeys(client: Valkey, prefix: string): Promise<void> {
  await client.set(`${prefix}:str1`, 'value1');
  await client.set(`${prefix}:str2`, 'value2');
  await client.set(`${prefix}:str3`, 'value3');
  await client.hset(`${prefix}:hash1`, 'f1', 'v1', 'f2', 'v2');
  await client.hset(`${prefix}:hash2`, 'field', 'data');
  await client.rpush(`${prefix}:list1`, 'a', 'b', 'c');
  await client.sadd(`${prefix}:set1`, 'm1', 'm2', 'm3');
  await client.zadd(`${prefix}:zset1`, 1, 'z1', 2, 'z2');
  await client.set(`${prefix}:str4`, 'value4');
  await client.set(`${prefix}:str5`, 'value5');
}

async function verifyKeys(client: Valkey, prefix: string): Promise<void> {
  // 5 strings
  expect(await client.get(`${prefix}:str1`)).toBe('value1');
  expect(await client.get(`${prefix}:str2`)).toBe('value2');
  expect(await client.get(`${prefix}:str3`)).toBe('value3');
  expect(await client.get(`${prefix}:str4`)).toBe('value4');
  expect(await client.get(`${prefix}:str5`)).toBe('value5');

  // 2 hashes
  expect(await client.hgetall(`${prefix}:hash1`)).toEqual({ f1: 'v1', f2: 'v2' });
  expect(await client.hgetall(`${prefix}:hash2`)).toEqual({ field: 'data' });

  // list
  expect(await client.lrange(`${prefix}:list1`, 0, -1)).toEqual(['a', 'b', 'c']);

  // set (order is non-deterministic)
  const members = await client.smembers(`${prefix}:set1`);
  expect(members.sort()).toEqual(['m1', 'm2', 'm3']);

  // sorted set (ordered by score)
  const zset = await client.zrange(`${prefix}:zset1`, '0', '-1');
  expect(zset).toEqual(['z1', 'z2']);
}

// ── Analysis runner ─────────────────────────────────────────────────

async function runAnalysis(
  app: NestFastifyApplication,
  sourceId: string,
  targetId: string,
): Promise<any> {
  const startRes = await request(app.getHttpServer())
    .post('/migration/analysis')
    .send({ sourceConnectionId: sourceId, targetConnectionId: targetId, scanSampleSize: 1000 });

  expect([200, 201]).toContain(startRes.status);

  const analysisId = startRes.body.id;

  let result: any;
  for (let i = 0; i < 60; i++) {
    const poll = await request(app.getHttpServer()).get(`/migration/analysis/${analysisId}`);
    expect(poll.status).toBe(200);
    result = poll.body;
    if (result.status === 'completed' || result.status === 'failed') break;
    await sleep(500);
  }
  return result;
}

// ── Migration runner ────────────────────────────────────────────────

async function runMigration(
  app: NestFastifyApplication,
  sourceId: string,
  targetId: string,
): Promise<{ status: string; keysTransferred?: number; error?: string } | 'skipped'> {
  const startRes = await request(app.getHttpServer())
    .post('/migration/execution')
    .send({ sourceConnectionId: sourceId, targetConnectionId: targetId, mode: 'command' });

  if (startRes.status === 402 || startRes.status === 403) return 'skipped';
  expect([200, 201]).toContain(startRes.status);

  const execId = startRes.body.id;

  let result: any;
  for (let i = 0; i < 120; i++) {
    const poll = await request(app.getHttpServer()).get(`/migration/execution/${execId}`);
    if (poll.status === 402 || poll.status === 403) return 'skipped';
    result = poll.body;
    if (result.status === 'completed' || result.status === 'failed') break;
    await sleep(500);
  }
  return result;
}

// ── Tests ───────────────────────────────────────────────────────────

(RUN ? describe : describe.skip)('Migration Topology E2E', () => {
  let app: NestFastifyApplication;
  const connIds: Record<string, string> = {};
  let licenseLocked = false;

  beforeAll(async () => {
    // 1. Start topology containers (clean slate)
    try { compose('down --remove-orphans --volumes'); } catch { /* ok */ }
    compose('up -d');

    // 2. Wait for standalone instances
    await Promise.all([
      waitForStandalone(SRC_STANDALONE_PORT),
      waitForStandalone(TGT_STANDALONE_PORT),
    ]);

    // 3. Wait for both clusters to form
    await Promise.all([
      waitForCluster(SRC_CLUSTER_PORT),
      waitForCluster(TGT_CLUSTER_PORT),
    ]);

    // 4. Flush all instances to ensure clean state (no leftover data from prior runs)
    for (const { port, isCluster } of [
      { port: SRC_STANDALONE_PORT, isCluster: false },
      { port: TGT_STANDALONE_PORT, isCluster: false },
      { port: SRC_CLUSTER_PORT, isCluster: true },
      { port: TGT_CLUSTER_PORT, isCluster: true },
    ]) {
      const c = await openClient(port, isCluster);
      await c.flushall();
      await c.quit();
    }

    // 5. Seed source standalone (10 keys, prefix "mig:sa")
    const sa = await openClient(SRC_STANDALONE_PORT, false);
    await seedKeys(sa, 'mig:sa');
    await sa.quit();

    // 6. Seed source cluster (10 keys, prefix "mig:cl")
    const cl = await openClient(SRC_CLUSTER_PORT, true);
    await seedKeys(cl, 'mig:cl');
    await cl.quit();

    // 6. Boot NestJS app (default DB comes from global-setup on port 6380)
    app = await createTestApp();

    // 7. Register four connections via the API
    const defs = [
      { key: 'srcSA', name: 'Topo Source Standalone', port: SRC_STANDALONE_PORT },
      { key: 'tgtSA', name: 'Topo Target Standalone', port: TGT_STANDALONE_PORT },
      { key: 'srcCL', name: 'Topo Source Cluster',    port: SRC_CLUSTER_PORT },
      { key: 'tgtCL', name: 'Topo Target Cluster',    port: TGT_CLUSTER_PORT },
    ];
    for (const d of defs) {
      const res = await request(app.getHttpServer())
        .post('/connections')
        .send({ name: d.name, host: '127.0.0.1', port: d.port });
      if (res.status === 200 || res.status === 201) {
        connIds[d.key] = res.body.id;
      }
    }
  }, 120_000);

  afterAll(async () => {
    // Clean up connections
    for (const id of Object.values(connIds)) {
      try { await request(app.getHttpServer()).delete(`/connections/${id}`); } catch { /* ok */ }
    }
    if (app) await app.close();

    // Tear down Docker topology
    try { compose('down --remove-orphans --volumes'); } catch { /* ok */ }
  }, 60_000);

  // ── Shared scenario runner ──

  async function scenario(
    sourceKey: string,
    targetKey: string,
    sourcePrefix: string,
    targetPort: number,
    targetIsCluster: boolean,
  ): Promise<void> {
    const srcId = connIds[sourceKey];
    const tgtId = connIds[targetKey];
    if (!srcId || !tgtId) {
      throw new Error(`Connection not registered: ${sourceKey} / ${targetKey}`);
    }

    // Flush target before migration
    const flushClient = await openClient(targetPort, targetIsCluster);
    await flushClient.flushall();
    await flushClient.quit();

    // Run the migration
    const result = await runMigration(app, srcId, tgtId);
    if (result === 'skipped') {
      licenseLocked = true;
      return;
    }

    expect(result.status).toBe('completed');
    expect(result.keysTransferred).toBeGreaterThanOrEqual(10);

    // Verify all 10 keys arrived on the target
    const target = await openClient(targetPort, targetIsCluster);
    try {
      await verifyKeys(target, sourcePrefix);
    } finally {
      await target.quit();
    }
  }

  // ── 4 topology combinations ──

  it('standalone → standalone', async () => {
    await scenario('srcSA', 'tgtSA', 'mig:sa', TGT_STANDALONE_PORT, false);
    if (licenseLocked) {
      console.warn('Execution requires Pro license — remaining topology tests will be skipped');
    }
  }, 60_000);

  it('standalone → cluster', async () => {
    if (licenseLocked) return;
    await scenario('srcSA', 'tgtCL', 'mig:sa', TGT_CLUSTER_PORT, true);
  }, 60_000);

  it('cluster → standalone', async () => {
    if (licenseLocked) return;
    await scenario('srcCL', 'tgtSA', 'mig:cl', TGT_STANDALONE_PORT, false);
  }, 60_000);

  it('cluster → cluster', async () => {
    if (licenseLocked) return;
    await scenario('srcCL', 'tgtCL', 'mig:cl', TGT_CLUSTER_PORT, true);
  }, 60_000);

  // ── Compatibility analysis ──

  it('analysis: cluster → standalone should report a blocking incompatibility', async () => {
    const srcId = connIds['srcCL'];
    const tgtId = connIds['tgtSA'];
    if (!srcId || !tgtId) throw new Error('Connections not registered');

    const result = await runAnalysis(app, srcId, tgtId);

    expect(result.status).toBe('completed');
    expect(result.incompatibilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'blocking',
          category: 'cluster_topology',
        }),
      ]),
    );
    expect(result.blockingCount).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('analysis: standalone → cluster should report a warning incompatibility', async () => {
    const srcId = connIds['srcSA'];
    const tgtId = connIds['tgtCL'];
    if (!srcId || !tgtId) throw new Error('Connections not registered');

    const result = await runAnalysis(app, srcId, tgtId);

    expect(result.status).toBe('completed');
    expect(result.incompatibilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'warning',
          category: 'cluster_topology',
        }),
      ]),
    );
    expect(result.warningCount).toBeGreaterThanOrEqual(1);
    // Should NOT be blocking — migration is still possible
    const clusterBlocking = (result.incompatibilities ?? []).filter(
      (i: any) => i.category === 'cluster_topology' && i.severity === 'blocking',
    );
    expect(clusterBlocking).toHaveLength(0);
  }, 60_000);
});
