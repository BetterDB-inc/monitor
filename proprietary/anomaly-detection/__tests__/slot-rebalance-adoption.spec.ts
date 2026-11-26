import { Logger } from '@nestjs/common';
import { MemoryAdapter } from '@app/storage/adapters/memory.adapter';
import type { DiscoveredNode } from '@app/cluster/cluster-discovery.service';
import { AnomalyService } from '../anomaly.service';
import { hotShardSignature } from '../hot-shard-detector';
import type { RebalancePlan } from '../rebalance-planner';
import { rebalanceRunId } from '../rebalance-run-store';
import { REBALANCE_RUN_KEPT_MS, type RunReport } from '../slot-rebalance-run';

const CONN = 'conn-1';
const ADMIN = { userId: 'u1', email: 'admin@example.com' };
const MOVES = [{ targetShardId: 'tgt', ranges: [[0, 99]] as Array<[number, number]> }];

const PLAN: RebalancePlan = {
  kind: 'plan',
  action: 'spread',
  effect: 'resolves',
  sourceShardId: 'src',
  moves: [
    {
      ...MOVES[0],
      targetAddr: '10.0.0.2:6379',
      slotCount: 100,
      keyCount: 1000,
      cpuUsecPerSecond: 1000,
      shareOfShard: 0.2,
    },
  ],
  pinnedSlots: [],
  projection: [
    {
      shardId: 'src',
      nodeAddr: '10.0.0.1:6379',
      role: 'source',
      before: { cpuUsecPerSecond: 5000, share: 0.5, ratio: 2.5 },
      after: { cpuUsecPerSecond: 3100, share: 0.31, ratio: 1.2 },
    },
  ],
  medianBefore: 2000,
  medianAfter: 2600,
  warnings: [],
  plannedAfter: [],
  support: 'valkey_atomic',
  commands: [],
};

const LISTED = {
  jobName: 'job-1',
  sourceNodeId: 'src',
  targetNodeId: 'tgt',
  slotRange: '0-99',
  phase: 'snapshotting',
};

const node = (id: string, slots: number[][]): DiscoveredNode => ({
  id,
  address: `${id}.internal:6379`,
  role: 'master',
  slots,
  configEpoch: 1,
  state: 'healthy',
  flags: ['master'],
});

/** A collaborator that answers every method it was not given with a mock returning nothing. */
function collaborator(methods: Record<string, unknown> = {}): any {
  return new Proxy(methods, {
    get: (target, key: string) => {
      if (key === 'then') return undefined;
      if (!(key in target)) target[key] = jest.fn();
      return target[key];
    },
  });
}

describe('slot rebalance runs across a monitor restart', () => {
  let storage: MemoryAdapter;
  let report: RunReport & { migrations: Array<{ jobName?: string }> };
  let slots: { src: number[][]; tgt: number[][] };
  let sent: string[][];
  let warn: jest.SpyInstance;

  beforeEach(async () => {
    storage = new MemoryAdapter();
    await storage.initialize();
    report = { jobViews: [], finishedJobs: [], failed: [], complete: true, migrations: [] };
    slots = { src: [[0, 8191]], tgt: [[8192, 16383]] };
    sent = [];
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await storage.close();
  });

  /** A monitor process: nothing but the storage is shared between two of them. */
  function monitor(): AnomalyService {
    const registry = collaborator({
      list: jest.fn(() => []),
      listMembers: jest.fn(() => []),
      getConfig: jest.fn(() => ({ id: CONN, host: 'localhost', connectionType: 'direct' })),
    });
    const discovery = collaborator({
      discoverNodesIsolated: jest.fn(async () => [node('src', slots.src), node('tgt', slots.tgt)]),
      onNodeClientOnce: jest.fn(
        async (_node: unknown, _id: string, _budget: number, write: (client: unknown) => unknown) =>
          write({
            call: jest.fn(async (...args: string[]) => {
              sent.push(args);
              return 'OK';
            }),
          }),
      ),
      releaseConnection: jest.fn(async () => undefined),
      retainAddressConnections: jest.fn(async () => undefined),
    });
    const config = {
      get: jest.fn((key: string, fallback?: unknown) =>
        key === 'BETTERDB_SLOT_MIGRATION' ? 'true' : fallback,
      ),
    };
    const settings = collaborator({
      getCachedSettings: jest.fn(() => ({
        anomalyPollIntervalMs: 1000,
        anomalyCacheTtlMs: 300000,
        anomalyPrometheusIntervalMs: 30000,
      })),
    });
    const metrics = collaborator({ readSlotMigrations: jest.fn(async () => report) });
    const analytics = () => collaborator({ getCachedEntries: jest.fn(() => []) });
    return new AnomalyService(
      registry,
      storage,
      config as any,
      collaborator(),
      settings,
      analytics(),
      analytics(),
      undefined,
      undefined,
      discovery,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      metrics,
    );
  }

  async function poll(service: AnomalyService): Promise<void> {
    await (service as any).pollConnection({
      connectionId: CONN,
      connectionName: 'Test Connection',
      host: 'localhost',
      port: 6379,
      client: collaborator({
        getInfoParsed: jest.fn(async () => ({ server: { role: 'master' } })),
        getAclList: jest.fn(async () => []),
      }),
    });
  }

  const saved = (service: AnomalyService) =>
    Promise.all((service as any).rebalanceRunSaving.values());

  function suggest(service: AnomalyService): void {
    (service as any).hotShardRebalance.set(
      CONN,
      new Map([
        [hotShardSignature('src'), { verdict: { ...PLAN }, computedAt: Date.now(), ownership: '' }],
      ]),
    );
  }

  async function start(service: AnomalyService) {
    suggest(service);
    const result = await service.runRebalance(CONN, 'src', MOVES, ADMIN);
    await saved(service);
    return result;
  }

  async function follow(service: AnomalyService) {
    (service as any).rebalanceFollowedAt.clear();
    const runs = await service.followRebalanceRuns(CONN);
    await saved(service);
    return runs;
  }

  async function restartedWhileRunning(): Promise<AnomalyService> {
    const before = monitor();
    await start(before);
    report.jobViews = [LISTED];
    report.migrations = [{ jobName: 'job-1' }];
    await follow(before);
    const after = monitor();
    await poll(after);
    return after;
  }

  const storedRuns = () => storage.getRebalanceRuns({ connectionId: CONN });

  it('stores a run as it is started', async () => {
    await start(monitor());

    const [row] = await storedRuns();
    expect(row).toMatchObject({ sourceShardId: 'src', state: 'running', endedAt: null });
    expect(JSON.parse(row.payload).startedBy).toEqual(ADMIN);
  });

  it('writes a followed run only when it changed', async () => {
    const service = monitor();
    await start(service);
    const save = jest.spyOn(storage, 'saveRebalanceRun');
    report.jobViews = [LISTED];

    await follow(service);
    await follow(service);
    await follow(service);

    expect(save).toHaveBeenCalledTimes(1);
  });

  it('picks up a running run on the first poll after a restart', async () => {
    const service = await restartedWhileRunning();

    expect(await service.followRebalanceRuns(CONN)).toMatchObject([
      {
        sourceShardId: 'src',
        state: 'running',
        startedBy: ADMIN,
        jobs: [{ jobName: 'job-1', state: 'running' }],
      },
    ]);
  });

  it('follows the adopted run to its end and stores it', async () => {
    const service = await restartedWhileRunning();
    report.jobViews = [];
    report.migrations = [];
    report.finishedJobs = ['job-1'];
    slots = {
      src: [[100, 8191]],
      tgt: [
        [0, 99],
        [8192, 16383],
      ],
    };

    expect(await follow(service)).toMatchObject([
      { state: 'succeeded', jobs: [{ state: 'succeeded' }] },
    ]);
    expect(await storedRuns()).toMatchObject([{ state: 'succeeded', endedAt: expect.any(Number) }]);
  });

  it('cancels an adopted run', async () => {
    const service = await restartedWhileRunning();

    const result = await service.cancelRebalance(CONN, 'src');
    await saved(service);

    expect(result.status).toBe('cancelling');
    expect(sent.at(-1)).toEqual(['CLUSTER', 'CANCELSLOTMIGRATIONS']);
    const [row] = await storedRuns();
    expect(JSON.parse(row.payload).cancelAcceptedAt).toEqual(expect.any(Number));
  });

  it('starts no second migration while an adopted run is running', async () => {
    const service = await restartedWhileRunning();
    const before = sent.length;

    expect(await start(service)).toEqual({ status: 'blocked', blockedBy: 'migration_running' });
    expect(sent).toHaveLength(before);
  });

  it('answers a start although the run cannot be saved, and saves it on the next follow', async () => {
    const service = monitor();
    jest.spyOn(storage, 'saveRebalanceRun').mockRejectedValueOnce(new Error('disk full'));

    expect(await start(service)).toMatchObject({ status: 'started' });
    expect(await storedRuns()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('disk full'));

    await follow(service);

    expect(await storedRuns()).toHaveLength(1);
  });

  it('reads the stored runs again on the next poll after a failed read', async () => {
    await start(monitor());
    const service = monitor();
    jest.spyOn(storage, 'getRebalanceRuns').mockRejectedValueOnce(new Error('database is locked'));

    await poll(service);
    expect(await service.followRebalanceRuns(CONN)).toEqual([]);

    await poll(service);
    expect(await service.followRebalanceRuns(CONN)).toHaveLength(1);
  });

  it('picks the runs up again for a connection that was removed and added back', async () => {
    const service = await restartedWhileRunning();

    (service as any).onConnectionRemoved(CONN);
    expect(await service.followRebalanceRuns(CONN)).toEqual([]);
    await poll(service);

    expect(await service.followRebalanceRuns(CONN)).toHaveLength(1);
  });

  it('lists a run that ended long ago in the history only', async () => {
    const startedAt = Date.now() - 3 * REBALANCE_RUN_KEPT_MS;
    const run = {
      sourceShardId: 'src',
      sourceAddr: '10.0.0.1:6379',
      startedBy: ADMIN,
      startedAt,
      endedAt: startedAt + 1000,
      projectedRatio: 1.2,
      jobs: [],
      jobsBefore: ['old-job'],
      state: 'succeeded' as const,
    };
    await storage.saveRebalanceRun({
      id: rebalanceRunId(CONN, run),
      connectionId: CONN,
      sourceShardId: 'src',
      state: run.state,
      startedAt,
      endedAt: run.endedAt,
      updatedAt: run.endedAt,
      payload: JSON.stringify(run),
    });
    const service = monitor();

    await poll(service);

    expect(await service.followRebalanceRuns(CONN)).toEqual([]);
    const history = await service.getRebalanceRunHistory(CONN, 0, 50);
    expect(history).toMatchObject([{ startedAt, state: 'succeeded' }]);
    expect(history[0]).not.toHaveProperty('jobsBefore');
  });

  it('shows the history of a run in memory as memory has it', async () => {
    const service = monitor();
    await start(service);
    const [row] = await storedRuns();
    await storage.saveRebalanceRun({
      ...row,
      updatedAt: row.updatedAt + 1,
      payload: JSON.stringify({ ...JSON.parse(row.payload), sourceAddr: 'stale' }),
    });

    expect(await service.getRebalanceRunHistory(CONN, 0, 50)).toMatchObject([
      { sourceAddr: '10.0.0.1:6379' },
    ]);
  });
});
