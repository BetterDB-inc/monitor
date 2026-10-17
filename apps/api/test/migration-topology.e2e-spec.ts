import { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import Valkey, { Cluster } from 'iovalkey';
import { execSync } from 'child_process';
import { join } from 'path';
import type { MigrationValidationResult } from '@betterdb/shared';
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

/** FLUSHALL on a Cluster client reaches one random node, so flush every master. */
async function flushAll(client: Valkey): Promise<void> {
  const maybeCluster: unknown = client;
  if (maybeCluster instanceof Cluster) {
    await Promise.all(maybeCluster.nodes('master').map((node) => node.flushall()));
    return;
  }
  await client.flushall();
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

  // A stream consumed through a group: c1 has read two entries and acked one,
  // so the group has a last-delivered ID and one pending entry to carry over.
  const stream = `${prefix}:stream1`;
  await client.xadd(stream, '1-0', 'job', 'a');
  await client.xadd(stream, '2-0', 'job', 'b');
  await client.xadd(stream, '3-0', 'job', 'c');
  await client.xgroup('CREATE', stream, 'workers', '0');
  await client.xreadgroup('GROUP', 'workers', 'c1', 'COUNT', 2, 'STREAMS', stream, '>');
  await client.xack(stream, 'workers', '1-0');
}

function fieldsToRecord(flat: unknown[]): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (let i = 0; i + 1 < flat.length; i += 2) record[String(flat[i])] = flat[i + 1];
  return record;
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

  // stream: entries, the consumer group, its pending entry, and a consumer that
  // resumes after cutover instead of failing with NOGROUP
  const stream = `${prefix}:stream1`;
  expect(await client.xlen(stream)).toBe(3);
  const groups = ((await client.xinfo('GROUPS', stream)) as unknown[][]).map(fieldsToRecord);
  expect(groups).toEqual([
    expect.objectContaining({ name: 'workers', 'last-delivered-id': '2-0', pending: 1 }),
  ]);
  const pending = (await client.xpending(stream, 'workers', '-', '+', 10)) as unknown[][];
  expect(pending.map(([id, consumer]) => [id, consumer])).toEqual([['2-0', 'c1']]);
  const next = (await client.xreadgroup('GROUP', 'workers', 'c1', 'STREAMS', stream, '>')) as unknown[];
  expect(JSON.stringify(next)).toBe(JSON.stringify([[stream, [['3-0', ['job', 'c']]]]]));
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
  forceReason?: string,
): Promise<{ status: string; keysTransferred?: number; error?: string } | 'skipped'> {
  const startRes = await request(app.getHttpServer())
    .post('/migration/execution')
    .send({
      sourceConnectionId: sourceId,
      targetConnectionId: targetId,
      mode: 'command',
      ...(forceReason ? { force: true, forceReason } : {}),
    });

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

// ── Validation runner ───────────────────────────────────────────────

async function runValidation(
  app: NestFastifyApplication,
  sourceId: string,
  targetId: string,
): Promise<MigrationValidationResult> {
  const startRes = await request(app.getHttpServer())
    .post('/migration/validation')
    .send({ sourceConnectionId: sourceId, targetConnectionId: targetId });

  expect([200, 201]).toContain(startRes.status);

  const validationId = startRes.body.id;

  let result: MigrationValidationResult | undefined;
  for (let i = 0; i < 60; i++) {
    const poll = await request(app.getHttpServer()).get(`/migration/validation/${validationId}`);
    expect(poll.status).toBe(200);
    result = poll.body as MigrationValidationResult;
    if (result.status === 'completed' || result.status === 'failed') break;
    await sleep(500);
  }
  if (!result) throw new Error(`Validation ${validationId} returned no result`);
  return result;
}

// ── Tests ───────────────────────────────────────────────────────────

(RUN ? describe : describe.skip)('Migration Topology E2E', () => {
  let app: NestFastifyApplication;
  const connIds: Record<string, string> = {};

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
      await flushAll(c);
      await c.quit();
    }

    // 5. Seed source standalone (11 keys, prefix "mig:sa")
    const sa = await openClient(SRC_STANDALONE_PORT, false);
    await seedKeys(sa, 'mig:sa');
    await sa.quit();

    // 6. Seed source cluster (11 keys, prefix "mig:cl")
    const cl = await openClient(SRC_CLUSTER_PORT, true);
    await seedKeys(cl, 'mig:cl');
    await cl.quit();

    // 7. Boot NestJS app with Pro license so execution endpoints are unlocked.
    //    The mocked entitlement response is unsigned, which the license service
    //    only accepts with LICENSE_ALLOW_UNSIGNED.
    process.env.BETTERDB_LICENSE_KEY = 'test-topology-key';
    process.env.LICENSE_ALLOW_UNSIGNED = 'true';
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ valid: true, tier: 'pro', expiresAt: null }),
    } as Response);

    app = await createTestApp();

    // 8. Register four connections via the API
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

    // Restore license env / mocks
    delete process.env.BETTERDB_LICENSE_KEY;
    delete process.env.LICENSE_ALLOW_UNSIGNED;
    jest.restoreAllMocks();

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
    await flushAll(flushClient);
    await flushClient.quit();

    // Execution requires a completed analysis for the pair (safety gate).
    // cluster → standalone is blocking by design; it is exercised here on purpose.
    const analysis = await runAnalysis(app, srcId, tgtId);
    expect(analysis.status).toBe('completed');
    const forceReason = analysis.blockingCount > 0
      ? 'topology e2e: exercising a blocked topology on purpose'
      : undefined;

    // Run the migration
    const result = await runMigration(app, srcId, tgtId, forceReason);
    expect(result).not.toBe('skipped');
    if (result === 'skipped') return; // type guard

    expect(result.status).toBe('completed');
    expect(result.keysTransferred).toBe(11);

    // Validation must see the whole dataset on both sides — every master of a
    // cluster, not one node — and pass a complete migration. Runs before
    // verifyKeys, which reads from the stream's group on the target.
    const validation = await runValidation(app, srcId, tgtId);
    expect(validation.status).toBe('completed');
    expect(validation.keyCount).toMatchObject({ sourceKeys: 11, targetKeys: 11, discrepancy: 0 });
    expect(validation.passed).toBe(true);

    // Verify all 11 keys arrived on the target
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
  }, 60_000);

  it('standalone → cluster', async () => {
    await scenario('srcSA', 'tgtCL', 'mig:sa', TGT_CLUSTER_PORT, true);
  }, 60_000);

  it('cluster → standalone', async () => {
    await scenario('srcCL', 'tgtSA', 'mig:cl', TGT_STANDALONE_PORT, false);
  }, 60_000);

  it('cluster → cluster', async () => {
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
