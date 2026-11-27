import { Logger } from '@nestjs/common';
import { MemoryAdapter } from '@app/storage/adapters/memory.adapter';
import type { DiscoveredNode } from '@app/cluster/cluster-discovery.service';
import { AnomalyService } from '../anomaly.service';
import { hotShardSignature } from '../hot-shard-detector';
import type { RebalancePlan } from '../rebalance-planner';
import { REBALANCE_ADOPT_LIMIT, rebalanceRunId } from '../rebalance-run-store';
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

  async function poll(
    service: AnomalyService,
    sections: Record<string, unknown> = {},
  ): Promise<void> {
    await (service as any).pollConnection({
      connectionId: CONN,
      connectionName: 'Test Connection',
      host: 'localhost',
      port: 6379,
      client: collaborator({
        getInfoParsed: jest.fn(async () => ({ server: { role: 'master' }, ...sections })),
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

  it('reads the stored runs again once the retry delay after a failed read passed', async () => {
    await start(monitor());
    const service = monitor();
    jest
      .spyOn(storage, 'getLatestRebalanceRunPerShard')
      .mockRejectedValueOnce(new Error('database is locked'));

    await poll(service);
    expect(await service.followRebalanceRuns(CONN)).toEqual([]);

    const { delayMs } = (service as any).rebalanceRunsRetry.get(CONN);
    const real = Date.now;
    jest.spyOn(Date, 'now').mockImplementation(() => real() + delayMs + 1);
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

  const storedRun = (sourceShardId: string, startedAt: number, endedAt?: number) => {
    const run = {
      sourceShardId,
      sourceAddr: '10.0.0.1:6379',
      startedBy: ADMIN,
      startedAt,
      ...(endedAt === undefined ? {} : { endedAt }),
      projectedRatio: 1.2,
      jobs: [],
      jobsBefore: [],
      state: endedAt === undefined ? ('running' as const) : ('succeeded' as const),
    };
    return {
      id: rebalanceRunId(CONN, run),
      connectionId: CONN,
      sourceShardId,
      state: run.state,
      startedAt,
      endedAt: endedAt ?? null,
      updatedAt: endedAt ?? startedAt,
      payload: JSON.stringify(run),
    };
  };

  it('picks up a running run although another shard stored more runs than the adopt limit', async () => {
    const now = Date.now();
    await storage.saveRebalanceRun(storedRun('quiet', now - 60 * 60_000));
    for (let i = 0; i < REBALANCE_ADOPT_LIMIT + 20; i++) {
      await storage.saveRebalanceRun(storedRun('busy', now - 30 * 60_000 + i, now - 20 * 60_000));
    }
    const service = monitor();

    await poll(service);

    const runs = (service as any).rebalanceRuns.get(CONN) as Map<string, { state: string }>;
    expect(runs.get('quiet')).toMatchObject({ state: 'running' });
  });

  it('saves the end of a run whose save failed after a new run replaced it', async () => {
    const service = monitor();
    await start(service);
    const [first] = await storedRuns();
    const save = jest.spyOn(storage, 'saveRebalanceRun');
    save.mockRejectedValueOnce(new Error('database is locked'));
    report.finishedJobs = ['job-1'];
    slots = { src: [[100, 8191]], tgt: [[0, 99], [8192, 16383]] };
    await follow(service);
    expect((await storedRuns())[0]).toMatchObject({ id: first.id, state: 'running' });

    // A new run of the same shard replaces the one whose terminal save failed.
    const runs = (service as any).rebalanceRuns.get(CONN);
    const ended = runs.get('src');
    (service as any).putRun(CONN, runs, { ...ended, startedAt: ended.startedAt + 1, state: 'running', endedAt: undefined });
    await saved(service);
    await follow(service);

    const firstNow = (await storedRuns()).find((row) => row.id === first.id);
    expect(firstNow).toMatchObject({ state: 'succeeded', endedAt: expect.any(Number) });
    expect((service as any).rebalanceRunSaved.has(first.id)).toBe(false);
    expect((service as any).rebalanceRunUnsaved.has(first.id)).toBe(false);
  });

  it('saves the end of a run whose save failed after it expired', async () => {
    const service = monitor();
    await start(service);
    const [first] = await storedRuns();
    jest.spyOn(storage, 'saveRebalanceRun').mockRejectedValueOnce(new Error('database is locked'));
    report.finishedJobs = ['job-1'];
    slots = { src: [[100, 8191]], tgt: [[0, 99], [8192, 16383]] };
    await follow(service);

    const real = Date.now;
    jest.spyOn(Date, 'now').mockImplementation(() => real() + 2 * REBALANCE_RUN_KEPT_MS);
    expect(await follow(service)).toEqual([]);

    expect((await storedRuns()).find((row) => row.id === first.id)).toMatchObject({
      state: 'succeeded',
    });
    expect((service as any).rebalanceRunSaved.has(first.id)).toBe(false);
    expect((service as any).rebalanceRunUnsaved.has(first.id)).toBe(false);
  });

  it('saves a failed end on a later poll once no run is left in memory', async () => {
    // Only a poll of a cluster node follows the runs.
    const cluster = { cluster: { cluster_enabled: '1' } };
    const service = monitor();
    await poll(service, cluster);
    await start(service);
    const [first] = await storedRuns();
    const save = jest
      .spyOn(storage, 'saveRebalanceRun')
      .mockRejectedValue(new Error('database is locked'));
    report.finishedJobs = ['job-1'];
    slots = {
      src: [[100, 8191]],
      tgt: [
        [0, 99],
        [8192, 16383],
      ],
    };
    await follow(service);

    const real = Date.now;
    jest.spyOn(Date, 'now').mockImplementation(() => real() + 2 * REBALANCE_RUN_KEPT_MS);
    await poll(service, cluster);
    await saved(service);
    expect((service as any).rebalanceRuns.has(CONN)).toBe(false);
    expect(await storedRuns()).toMatchObject([{ id: first.id, state: 'running' }]);

    save.mockRestore();
    await poll(service, cluster);
    await saved(service);

    expect(await storedRuns()).toMatchObject([{ id: first.id, state: 'succeeded' }]);
    expect((service as any).rebalanceRunSaved.has(first.id)).toBe(false);
    expect((service as any).rebalanceRunUnsaved.has(first.id)).toBe(false);
  });

  it('waits longer between reads of the stored runs while storage keeps failing', async () => {
    const service = monitor();
    const read = jest
      .spyOn(storage, 'getLatestRebalanceRunPerShard')
      .mockRejectedValue(new Error('database is locked'));

    await poll(service);
    await poll(service);
    expect(read).toHaveBeenCalledTimes(1);

    const retry = (service as any).rebalanceRunsRetry.get(CONN);
    const real = Date.now;
    jest.spyOn(Date, 'now').mockImplementation(() => real() + retry.delayMs + 1);
    await poll(service);
    expect(read).toHaveBeenCalledTimes(2);
    expect((service as any).rebalanceRunsRetry.get(CONN).delayMs).toBe(retry.delayMs * 2);
  });

  it('follows a cancel that was sent but not answered before a restart as accepted', async () => {
    const before = monitor();
    await start(before);
    report.jobViews = [LISTED];
    report.migrations = [{ jobName: 'job-1' }];
    await follow(before);
    // The process stopped after it stored the cancel as requested, before the server answered.
    const [row] = await storedRuns();
    const requestedAt = Date.now() - 60_000;
    await storage.saveRebalanceRun({
      ...row,
      updatedAt: row.updatedAt + 1,
      payload: JSON.stringify({
        ...JSON.parse(row.payload),
        cancelRequestedAt: requestedAt,
        failedBeforeCancel: [],
      }),
    });
    const after = monitor();
    await poll(after);
    // The cancel took: the target lists its import as failed and the hot shard still owns the slots.
    report.jobViews = [];
    report.migrations = [];
    report.failed = [
      { jobName: 'job-1', message: 'cancelled', sourceNodeId: 'src', targetNodeId: 'tgt', slotRange: '0-99' },
    ];

    expect(await follow(after)).toMatchObject([
      { state: 'cancelled', jobs: [{ state: 'cancelled' }] },
    ]);
  });

  it('does not keep a failed save to retry for a connection that was removed', async () => {
    const service = monitor();
    await start(service);
    let fail!: (err: Error) => void;
    jest
      .spyOn(storage, 'saveRebalanceRun')
      .mockImplementationOnce(() => new Promise<void>((_, reject) => (fail = reject)));
    report.jobViews = [LISTED];
    (service as any).rebalanceFollowedAt.clear();
    await service.followRebalanceRuns(CONN);

    (service as any).onConnectionRemoved(CONN);
    (service as any).connectionRegistry.getConfig.mockReturnValue(undefined);
    fail(new Error('database is locked'));
    await saved(service);

    expect((service as any).rebalanceRunUnsaved.size).toBe(0);
  });

  it('keeps saving a run when the clock steps back', async () => {
    const service = monitor();
    const real = Date.now;
    jest.spyOn(Date, 'now').mockImplementation(() => real() + 60_000);
    await start(service);
    const [first] = await storedRuns();

    // The clock steps back a minute; the next change of the run must still be stored.
    jest.spyOn(Date, 'now').mockImplementation(real);
    report.jobViews = [LISTED];
    await follow(service);

    const [row] = await storedRuns();
    expect(row.updatedAt).toBeGreaterThan(first.updatedAt);
    expect(JSON.parse(row.payload).jobs[0]).toMatchObject({ jobName: 'job-1', state: 'running' });
  });

  it('drops the save stamp of a run a new run replaced', async () => {
    const service = monitor();
    await start(service);
    const [first] = await storedRuns();
    expect((service as any).rebalanceRunUpdatedAt.has(first.id)).toBe(true);

    const runs = (service as any).rebalanceRuns.get(CONN);
    const current = runs.get('src');
    (service as any).putRun(CONN, runs, { ...current, startedAt: current.startedAt + 1 });
    await saved(service);

    expect((service as any).rebalanceRunUpdatedAt.has(first.id)).toBe(false);
  });

  it('drops the save stamp of a run that expired', async () => {
    const service = monitor();
    await start(service);
    const [first] = await storedRuns();
    report.finishedJobs = ['job-1'];
    slots = { src: [[100, 8191]], tgt: [[0, 99], [8192, 16383]] };
    await follow(service);

    const real = Date.now;
    jest.spyOn(Date, 'now').mockImplementation(() => real() + 2 * REBALANCE_RUN_KEPT_MS);
    expect(await follow(service)).toEqual([]);

    expect((service as any).rebalanceRunUpdatedAt.has(first.id)).toBe(false);
  });

  it('keeps the save stamp of an expired run while its failed save waits to be retried', async () => {
    const service = monitor();
    await start(service);
    const [first] = await storedRuns();
    const save = jest
      .spyOn(storage, 'saveRebalanceRun')
      .mockRejectedValue(new Error('database is locked'));
    report.finishedJobs = ['job-1'];
    slots = { src: [[100, 8191]], tgt: [[0, 99], [8192, 16383]] };
    await follow(service);

    const real = Date.now;
    jest.spyOn(Date, 'now').mockImplementation(() => real() + 2 * REBALANCE_RUN_KEPT_MS);
    await follow(service);
    expect((service as any).rebalanceRunUpdatedAt.has(first.id)).toBe(true);

    save.mockRestore();
    await follow(service);
    expect((service as any).rebalanceRunUpdatedAt.has(first.id)).toBe(false);
    expect((await storedRuns())[0]).toMatchObject({ id: first.id, state: 'succeeded' });
  });

  describe('history of a run whose load was still to be measured', () => {
    const storeSucceeded = async (endedAgoMs: number) => {
      const endedAt = Date.now() - endedAgoMs;
      const run = {
        sourceShardId: 'src',
        sourceAddr: '10.0.0.1:6379',
        startedBy: ADMIN,
        startedAt: endedAt - 1000,
        endedAt,
        projectedRatio: 1.2,
        jobs: [],
        jobsBefore: [],
        state: 'succeeded' as const,
      };
      await storage.saveRebalanceRun({
        id: rebalanceRunId(CONN, run),
        connectionId: CONN,
        sourceShardId: 'src',
        state: run.state,
        startedAt: run.startedAt,
        endedAt,
        updatedAt: endedAt,
        payload: JSON.stringify(run),
      });
    };

    it('says it could not be measured once the wait passed', async () => {
      await storeSucceeded(20 * 60_000);
      const [run] = await monitor().getRebalanceRunHistory(CONN, 0, 50);
      expect(run).toMatchObject({ state: 'succeeded', outcomeUnavailable: true });
      expect(JSON.parse((await storedRuns())[0].payload)).not.toHaveProperty('outcomeUnavailable');
    });

    it('is still measured within the wait', async () => {
      await storeSucceeded(60_000);
      const [run] = await monitor().getRebalanceRunHistory(CONN, 0, 50);
      expect(run).not.toHaveProperty('outcomeUnavailable');
    });

    it('shows a run in memory as memory has it', async () => {
      const service = monitor();
      await start(service);
      report.finishedJobs = ['job-1'];
      slots = { src: [[100, 8191]], tgt: [[0, 99], [8192, 16383]] };
      await follow(service);
      const real = Date.now;
      jest.spyOn(Date, 'now').mockImplementation(() => real() + 20 * 60_000);

      const [run] = await service.getRebalanceRunHistory(CONN, 0, 50);
      const live = (service as any).rebalanceRuns.get(CONN).get('src');
      expect(run.outcomeUnavailable).toBe(live.outcomeUnavailable);
    });
  });
});
