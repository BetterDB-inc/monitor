import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { PostgresAdapter } from '../src/storage/adapters/postgres.adapter';
import type { StoredScalingReadinessScore } from '../src/common/interfaces/storage-port.interface';

const DSN =
  process.env.SCALING_READINESS_POSTGRES_TEST_DSN ??
  'postgres://betterdb:devpassword@localhost:5433/betterdb';

const SCHEMA = `scaling_readiness_contract_${process.pid}_${Date.now()}`;

const row = (o: Partial<StoredScalingReadinessScore> = {}): StoredScalingReadinessScore => ({
  id: randomUUID(),
  connectionId: 'conn-a',
  timestamp: 1_000,
  score: 55,
  band: 'yellow',
  bindingDimension: 'memory',
  dimensions: [
    { key: 'memory', score: 40, weight: 30, contribution: 15, detail: '80% of 1 GB', excludedReason: null },
  ],
  ...o,
});

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
  describe('scaling readiness storage — postgres (live Postgres required)', () => {
    it('has a reachable PostgreSQL', () => {
      throw new Error(
        `PostgreSQL is required here (CI or REQUIRE_POSTGRES_TESTS=true) but ${new URL(DSN).host} is unreachable`,
      );
    });
  });
}

describePostgres('scaling readiness storage — postgres', () => {
  let adminPool: Pool;
  let adapter: PostgresAdapter;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: DSN });
    await adminPool.query(`CREATE SCHEMA ${SCHEMA}`);
    adapter = new PostgresAdapter({ connectionString: DSN, schema: SCHEMA });
    await adapter.initialize();
  });

  afterAll(async () => {
    await adapter.close();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await adminPool.end();
  });

  it('stores and reads scores ascending within a range', async () => {
    await adapter.saveScalingReadinessScore(row({ timestamp: 3_000, score: 70, band: 'green' }));
    await adapter.saveScalingReadinessScore(row({ timestamp: 1_000 }));
    await adapter.saveScalingReadinessScore(row({ timestamp: 2_000, bindingDimension: null }));
    await adapter.saveScalingReadinessScore(row({ timestamp: 2_500, connectionId: 'conn-b' }));
    const rows = await adapter.getScalingReadinessScores({
      connectionId: 'conn-a',
      from: 1_500,
      to: 3_000,
    });
    expect(rows.map((r) => r.timestamp)).toEqual([2_000, 3_000]);
    expect(rows[0].bindingDimension).toBeNull();
    expect(rows[1]).toMatchObject({ score: 70, band: 'green', bindingDimension: 'memory' });
    expect(rows[1].dimensions[0]).toMatchObject({ key: 'memory', detail: '80% of 1 GB' });
  });

  it('keeps the newest rows up to the limit, ascending', async () => {
    const rows = await adapter.getScalingReadinessScores({ connectionId: 'conn-a', limit: 2 });
    expect(rows.map((r) => r.timestamp)).toEqual([2_000, 3_000]);
  });

  it('prunes rows older than the cutoff for one connection', async () => {
    expect(await adapter.pruneOldScalingReadinessScores(1_500, 'conn-a')).toBe(1);
    expect(await adapter.getScalingReadinessScores({ connectionId: 'conn-b' })).toHaveLength(1);
  });

  it('upserts settings per connection', async () => {
    expect(await adapter.getScalingReadinessSettings('conn-a')).toBeNull();
    await adapter.saveScalingReadinessSettings({
      connectionId: 'conn-a',
      alertEnabled: true,
      alertThreshold: 40,
      updatedAt: 1,
    });
    await adapter.saveScalingReadinessSettings({
      connectionId: 'conn-a',
      alertEnabled: false,
      alertThreshold: 55,
      updatedAt: 2,
    });
    expect(await adapter.getScalingReadinessSettings('conn-a')).toEqual({
      connectionId: 'conn-a',
      alertEnabled: false,
      alertThreshold: 55,
      updatedAt: 2,
    });
  });

  it('round-trips the snapshot capacity columns', async () => {
    await adapter.saveMemorySnapshots(
      [
        {
          id: randomUUID(),
          timestamp: 9_000,
          usedMemory: 1024,
          usedMemoryRss: null,
          usedMemoryPeak: null,
          memFragmentationRatio: null,
          maxmemory: 4096,
          allocatorFragRatio: null,
          opsPerSec: 3,
          cpuSys: 1,
          cpuUser: 2,
          ioThreadedReads: null,
          ioThreadedWrites: null,
          connectedClients: 12,
          maxclients: 1000,
          totalKeys: 345,
        },
      ],
      'conn-cap',
    );
    expect(await adapter.getMemorySnapshots({ connectionId: 'conn-cap' })).toEqual([
      expect.objectContaining({ connectedClients: 12, maxclients: 1000, totalKeys: 345 }),
    ]);
  });
});
