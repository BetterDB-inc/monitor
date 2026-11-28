import { Logger } from '@nestjs/common';
import {
  DEFAULT_PLACEMENT_SETTINGS,
  type DatabaseConnectionConfig,
  type PlacementPolicy,
} from '@betterdb/shared';
import { MemoryAdapter } from '@app/storage/adapters/memory.adapter';
import type { ShardLoadSample } from '@app/cluster/shard-load';
import type { ClusterNode } from '@app/common/types/metrics.types';
import type { ShardLoadListener } from '@app/cluster/shard-load.service';
import {
  PlacementService,
  PlacementModeError,
  PlacementPolicyConflictError,
  PlacementPolicyError,
  PlacementPolicyUnreadableError,
  rebalancePolicyOf,
} from '../placement.service';
import { DEFAULT_REBALANCE_POLICY } from '../../anomaly-detection/rebalance-planner';
import type { PlacementPrimaryRead } from '../placement-support';
import type { ServedHotShardDetail } from '../../anomaly-detection/hot-shard-detector';
import type { RebalanceNoPlan, RebalancePlan } from '../../anomaly-detection/rebalance-planner';
import type { PlacementNodeFacts } from '../placement-facts';
import type { PlacementGateSignal } from '../placement-gate';

const valkey9 = { dbType: 'valkey' as const, version: '9.0.0' };

function healthyNodes(): PlacementNodeFacts {
  const ids = ['a', 'b', 'c'];
  const each = <T>(value: T) => Object.fromEntries(ids.map((id) => [id, value]));
  return {
    nodes: ids.map((id) => ({
      id,
      address: `${id}:7000`,
      role: 'master' as const,
      state: 'healthy' as const,
      shardId: id,
      collected: true,
      configEpoch: 1,
    })),
    clusterStateOk: true,
    migrations: 'none',
    persistence: each({ forkRunning: false }),
    replication: each({ replicasInSync: true }),
    pingP50Ms: each(1),
  };
}

function withUncollectedReplica(epoch: number): PlacementNodeFacts {
  const facts = healthyNodes();
  facts.nodes.push({
    id: 'b2',
    address: 'b2:7000',
    role: 'replica',
    state: 'healthy',
    shardId: 'b',
    collected: false,
    configEpoch: epoch,
  });
  facts.persistence.b2 = { forkRunning: false };
  facts.pingP50Ms.b2 = 1;
  return facts;
}

function polledNodes(replicaEpoch: number): ClusterNode[] {
  const primary = (id: string) => ({ id, flags: ['master'], master: '-', configEpoch: 1 });
  return [
    primary('a'),
    primary('b'),
    primary('c'),
    { id: 'b2', flags: ['slave'], master: 'b', configEpoch: replicaEpoch },
  ] as unknown as ClusterNode[];
}

function primaries(): PlacementPrimaryRead[] {
  return [
    { address: '10.0.0.1:7001', server: valkey9, migrateSlotsCommand: true },
    { address: '10.0.0.2:7002', server: valkey9, migrateSlotsCommand: true },
    { address: '10.0.0.3:7003', server: valkey9, migrateSlotsCommand: true },
  ];
}

const sample: ShardLoadSample = {
  timestamp: Date.now(),
  settling: false,
  shards: ['a', 'b', 'c'].map((nodeId, index) => ({
    nodeId,
    address: `${nodeId}:7000`,
    slotCount: 5461,
    measuredSlots: 5461,
    cpuUsecPerSecond: index === 0 ? 900_000 : 300_000,
    sustainCpuUsecPerSecond: index === 0 ? 900_000 : 300_000,
    baselineCpuUsecPerSecond: 300_000,
    sustainReset: false,
    networkBytesInPerSecond: 0,
    networkBytesOutPerSecond: 0,
    cpuShare: null,
    networkShare: null,
  })),
};

interface Setup {
  configs?: Record<string, Partial<DatabaseConnectionConfig>>;
  clusterEnabled?: boolean;
  env?: Record<string, string>;
  signIn?: boolean;
  primaries?: PlacementPrimaryRead[] | null;
}

async function setup(options: Setup = {}) {
  const storage = new MemoryAdapter();
  await storage.initialize();
  const configs: Record<string, Partial<DatabaseConnectionConfig>> = options.configs ?? {
    seed: { id: 'seed', host: '10.0.0.1', port: 7001 },
  };
  const registry = {
    getConfig: jest.fn((id: string) => (configs[id] ? ({ name: id, ...configs[id] } as DatabaseConnectionConfig) : null)),
    get: jest.fn(() => ({
      getCapabilities: (): { clusterEnabled: boolean; hasClusterSlotStats: boolean } => ({
        clusterEnabled: options.clusterEnabled ?? true,
        hasClusterSlotStats: true,
      }),
    })),
  };
  const anomaly = {
    readPlacementPrimaries: jest.fn(async () => (options.primaries === undefined ? primaries() : options.primaries)),
    runRebalance: jest.fn(),
    setRebalancePolicyResolver: jest.fn(),
    setClusterNodesObserver: jest.fn(),
    placementPlans: jest.fn((): RebalancePlan[] => []),
    placementMovedShardsSince: jest.fn((): string[] => []),
    placementJobsSince: jest.fn(() => 0),
    placementOpenEvents: jest.fn(async (): Promise<PlacementGateSignal[]> => []),
    placementIncidents: jest.fn(async () => ({ incidents: [], historyFrom: null })),
    readPlacementNodeFacts: jest.fn(async () => healthyNodes()),
  };
  const env = { BETTERDB_SLOT_MIGRATION: 'true', STORAGE_TYPE: 'sqlite', ...options.env };
  const config = { get: jest.fn((key: string) => env[key as keyof typeof env]) };
  const prometheus = { collectsClusterSlotStats: jest.fn(() => true), shardLoadStalenessMs: 90_000 };
  const listeners: ShardLoadListener[] = [];
  const shardLoad = {
    getLatest: jest.fn((): ShardLoadSample | null => sample),
    reportsUsage: jest.fn((): boolean | null => true),
    setSustainMinutes: jest.fn(),
    addListener: jest.fn((listener: ShardLoadListener) => {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    }),
  };
  const clusterMetrics = { usesClusterWideSlotStats: jest.fn(async () => true) };
  const service = new PlacementService(
    storage,
    registry as never,
    anomaly as never,
    config as never,
    prometheus as never,
    { enabled: options.signIn ?? true } as never,
    shardLoad as never,
    clusterMetrics as never,
  );
  service.onModuleInit();
  const feed = (
    seedId: string,
    from: number,
    to: number,
    at = (timestamp: number) => ({ ...sample, timestamp }),
  ) => {
    for (let timestamp = from; timestamp <= to; timestamp += 5_000) {
      for (const listener of listeners) listener.sample(seedId, at(timestamp));
    }
  };
  return {
    service,
    storage,
    registry,
    anomaly,
    prometheus,
    shardLoad,
    clusterMetrics,
    configs,
    listeners,
    feed,
  };
}

const withMember: Record<string, Partial<DatabaseConnectionConfig>> = {
  seed: { id: 'seed', host: '10.0.0.1', port: 7001 },
  member: {
    id: 'member',
    host: '10.0.0.2',
    port: 7002,
    membership: { seedId: 'seed', nodeId: 'n2', origin: 'auto', source: 'cluster' },
  },
};

async function settled(): Promise<void> {
  await new Promise((done) => setImmediate(done));
}

describe('PlacementService', () => {
  it('starts a connection with no stored policy in Observe', async () => {
    const { service } = await setup();
    const status = await service.getStatus('seed');
    expect(status).toMatchObject({ connectionId: 'seed', mode: 'observe', effectiveMode: 'observe' });
    expect(status.selectableModes).toEqual(['observe', 'recommend']);
  });

  it('reads the stored mode and the balance from the latest sample', async () => {
    const { service, storage } = await setup();
    await storage.savePlacementMode({ connectionId: 'seed', mode: 'recommend', updatedAt: 1 });
    const status = await service.getStatus('seed');
    expect(status.mode).toBe('recommend');
    expect(status.effectiveMode).toBe('recommend');
    expect(status.balance?.shards[0]).toMatchObject({ shardId: 'a', ratio: 3, overTrigger: true });
    expect(status.support.issues).toEqual([]);
  });

  it('lists each held plan with its safety checks outside Observe', async () => {
    const { service, storage, anomaly } = await setup();
    anomaly.placementPlans.mockReturnValue([
      {
        kind: 'plan',
        sourceShardId: 'a',
        moves: [
          { targetShardId: 'b', ranges: [[0, 5]] },
          { targetShardId: 'c', ranges: [[6, 9]] },
          { targetShardId: 'b', ranges: [[10, 12]] },
        ],
        execution: { available: false, blockedBy: 'plan_outdated' },
      } as unknown as RebalancePlan,
    ]);
    anomaly.placementOpenEvents.mockResolvedValue([
      { metricType: 'persistence_child', nodeId: 'c', openedAt: Date.now() },
    ]);
    expect((await service.getStatus('seed')).recommendations).toEqual([]);
    expect(anomaly.readPlacementNodeFacts).not.toHaveBeenCalled();

    await storage.savePlacementMode({ connectionId: 'seed', mode: 'recommend', updatedAt: 1 });
    expect((await service.getStatus('seed')).recommendations).toEqual([
      {
        sourceShardId: 'a',
        targetShardIds: ['b', 'c'],
        gate: {
          allowed: false,
          blockers: [expect.objectContaining({ kind: 'fork', scope: 'target', nodeId: 'c' })],
          warnings: [],
        },
        execution: { available: false, blockedBy: 'plan_outdated' },
      },
    ]);
    expect(anomaly.placementPlans).toHaveBeenCalledWith('seed');
  });

  it('reads the cluster once for every plan it lists', async () => {
    const { service, storage, anomaly } = await setup();
    await storage.savePlacementMode({ connectionId: 'seed', mode: 'recommend', updatedAt: 1 });
    const plan = (sourceShardId: string, from: number) =>
      ({
        kind: 'plan',
        sourceShardId,
        moves: [{ targetShardId: 'c', ranges: [[from, from + 3]] }],
        execution: { available: true },
      }) as unknown as RebalancePlan;
    anomaly.placementPlans.mockReturnValue([plan('a', 0), plan('b', 10)]);
    const { recommendations } = await service.getStatus('seed');
    expect(recommendations.map((each) => each.gate.allowed)).toEqual([true, true]);
    expect(anomaly.readPlacementNodeFacts).toHaveBeenCalledTimes(1);
    expect(anomaly.readPlacementNodeFacts).toHaveBeenCalledWith('seed', ['a', 'c', 'b']);
    expect(anomaly.placementOpenEvents).toHaveBeenCalledTimes(1);
    expect(anomaly.placementIncidents).toHaveBeenCalledTimes(1);
  });

  it('reads the sustained trigger of each shard from the samples it was handed', async () => {
    const { service, feed } = await setup();
    const now = Date.now();
    await service.settingsOf('seed');
    feed('seed', now - 30 * 60_000, now);

    const shards = (await service.getStatus('seed')).balance?.shards;

    expect(shards?.find((each) => each.shardId === 'a')).toMatchObject({
      sustainRatio: 3,
      baselineRatio: 1,
      trigger: 'over',
      warmUntil: null,
    });
    expect(shards?.find((each) => each.shardId === 'b')).toMatchObject({ trigger: 'under' });
  });

  it('shows a shard as warming up while its load history is short', async () => {
    const { service, feed } = await setup();
    const now = Date.now();
    await service.settingsOf('seed');
    feed('seed', now - 60_000, now);

    const row = (await service.getStatus('seed')).balance?.shards[0];

    expect(row?.trigger).toBe('short_history');
    expect(row?.warmUntil).toBeGreaterThanOrEqual(now + 23 * 60_000);
  });

  it('shows a shard with no samples yet as warming up with no end time', async () => {
    const { service } = await setup();

    const row = (await service.getStatus('seed')).balance?.shards[0];

    expect(row).toMatchObject({ trigger: 'short_history', warmUntil: null });
  });

  it('reads the policy when a connection starts tracking load, and fires with no one reading', async () => {
    const { service, shardLoad, storage, listeners, feed } = await setup();
    await storage.savePlacementSettings(
      {
        connectionId: 'seed',
        settings: { ...DEFAULT_PLACEMENT_SETTINGS, sustainMinutes: 20 },
        updatedAt: 1,
        modeIfNew: 'observe',
      },
      0,
    );
    for (const listener of listeners) listener.tracking('seed');
    await settled();
    expect(shardLoad.setSustainMinutes).toHaveBeenLastCalledWith('seed', 20);

    const start = Date.now() - 30 * 60_000;
    feed('seed', start, start + 30 * 60_000);

    expect(service.triggerOf('seed', 'a', start + 30 * 60_000)).toMatchObject({
      state: 'over',
      firedAt: start + 16 * 60_000,
    });
    expect(service.triggerOf('seed', 'b', start + 30 * 60_000)?.firedAt).toBeNull();
  });

  it('reads the policy on the first sample when nothing has read it yet', async () => {
    const { shardLoad, listeners } = await setup();
    for (const listener of listeners) listener.sample('seed', sample);
    await settled();

    expect(shardLoad.setSustainMinutes).toHaveBeenLastCalledWith('seed', 30);
  });

  it('reads a trigger whose samples stopped longer ago than the staleness bound as short', async () => {
    const { service, feed } = await setup();
    const start = Date.now() - 40 * 60_000;
    await service.settingsOf('seed');
    feed('seed', start, start + 30 * 60_000);

    expect(service.triggerOf('seed', 'a', start + 30 * 60_000 + 90_000)?.state).toBe('over');
    expect(service.triggerOf('seed', 'a', start + 30 * 60_000 + 90_001)).toMatchObject({
      state: 'short_history',
      firedAt: null,
      warmUntil: null,
    });
  });

  it('starts the warm-up again when the load tracker resets or the trigger settings change', async () => {
    const { service, listeners, feed } = await setup();
    const start = Date.now() - 30 * 60_000;
    const end = start + 30 * 60_000;
    await service.settingsOf('seed');
    feed('seed', start, end);
    expect(service.triggerOf('seed', 'a', end)?.state).toBe('over');

    for (const listener of listeners) listener.reset('seed');
    expect(service.triggerOf('seed', 'a', end)).toMatchObject({
      state: 'short_history',
      coveredMs: 0,
    });

    feed('seed', start, end);
    await service.setSettings('seed', { ...DEFAULT_PLACEMENT_SETTINGS, resolveRatio: 1.4 }, 0);
    expect(service.triggerOf('seed', 'a', end)?.state).toBe('over');
    await service.setSettings('seed', { ...DEFAULT_PLACEMENT_SETTINGS, triggerRatio: 2.5 }, 1);
    expect(service.triggerOf('seed', 'a', end)).toMatchObject({
      state: 'short_history',
      coveredMs: 0,
    });
  });

  it('stops listening to the load tracker when the module is destroyed', async () => {
    const { service, listeners } = await setup();
    service.onModuleDestroy();
    expect(listeners).toHaveLength(0);
  });

  it('hands the sustain minutes of the policy to the load tracker', async () => {
    const { service, shardLoad } = await setup();
    await service.getStatus('seed');
    expect(shardLoad.setSustainMinutes).toHaveBeenLastCalledWith('seed', 30);

    await service.setSettings('seed', { ...DEFAULT_PLACEMENT_SETTINGS, sustainMinutes: 45 }, 0);
    expect(shardLoad.setSustainMinutes).toHaveBeenLastCalledWith('seed', 45);
  });

  it('keeps the saved sustain minutes when an older read finishes after the save', async () => {
    const { service, shardLoad, storage } = await setup();
    const before = await storage.getPlacementPolicy('seed');
    let finish: (policy: PlacementPolicy | null) => void = () => undefined;
    jest
      .spyOn(storage, 'getPlacementPolicy')
      .mockImplementationOnce(() => new Promise((done) => (finish = done)));
    const slow = service.settingsOf('seed');
    await service.setSettings('seed', { ...DEFAULT_PLACEMENT_SETTINGS, sustainMinutes: 45 }, 0);
    finish(before);
    await slow;
    expect(shardLoad.setSustainMinutes).toHaveBeenLastCalledWith('seed', 45);
  });

  it('leaves the balance out once the latest sample is older than the staleness bound', async () => {
    const { service, shardLoad } = await setup();
    shardLoad.getLatest.mockReturnValue({ ...sample, timestamp: Date.now() - 90_001 });
    expect((await service.getStatus('seed')).balance).toBeNull();
  });

  it('counts slot stats as off when the readings carry no usage counters', async () => {
    const { service, storage, shardLoad } = await setup();
    await storage.savePlacementMode({ connectionId: 'seed', mode: 'recommend', updatedAt: 1 });
    shardLoad.reportsUsage.mockReturnValue(false);
    const status = await service.getStatus('seed');
    expect(status.effectiveMode).toBe('observe');
    expect(status.support.modes.recommend.blockedBy).toBe('slot_stats_off');
  });

  it('answers for a member with its seed', async () => {
    const { service, storage, anomaly } = await setup({
      configs: {
        seed: { id: 'seed', host: '10.0.0.1', port: 7001 },
        member: { id: 'member', host: '10.0.0.2', port: 7002, membership: { seedId: 'seed', nodeId: 'n2', origin: 'auto', source: 'cluster' } },
      },
    });
    await storage.savePlacementMode({ connectionId: 'seed', mode: 'recommend', updatedAt: 1 });
    const status = await service.getStatus('member');
    expect(status.connectionId).toBe('seed');
    expect(status.mode).toBe('recommend');
    expect(anomaly.readPlacementPrimaries).toHaveBeenCalledWith('seed');
  });

  it('writes the mode on the seed when set through a member', async () => {
    const { service, storage } = await setup({
      configs: {
        seed: { id: 'seed', host: '10.0.0.1', port: 7001 },
        member: { id: 'member', host: '10.0.0.2', port: 7002, membership: { seedId: 'seed', nodeId: 'n2', origin: 'auto', source: 'cluster' } },
      },
    });
    await service.setMode('member', 'recommend');
    expect((await storage.getPlacementPolicy('seed'))?.mode).toBe('recommend');
    expect(await storage.getPlacementPolicy('member')).toBeNull();
  });

  describe('policy', () => {
    const tighter = {
      ...DEFAULT_PLACEMENT_SETTINGS,
      sustainMinutes: 45,
      excludedSlots: [7],
      excludedShardIds: ['c'],
    };

    it('reads the default policy at version 0 when none is stored', async () => {
      const { service } = await setup();
      expect(await service.getStatus('seed')).toMatchObject({
        settings: DEFAULT_PLACEMENT_SETTINGS,
        policyVersion: 0,
      });
    });

    it('saves a valid policy at the version it read, keeping the mode', async () => {
      const { service, storage } = await setup();
      await storage.savePlacementMode({ connectionId: 'seed', mode: 'recommend', updatedAt: 1 });
      const status = await service.setSettings('seed', tighter, 0);
      expect(status).toMatchObject({ mode: 'recommend', settings: tighter, policyVersion: 1 });
      expect(await storage.getPlacementPolicy('seed')).toMatchObject({
        mode: 'recommend',
        settings: tighter,
        version: 1,
      });
    });

    it('stores every node of an excluded shard, and an unknown ID as given', async () => {
      const { service, storage, registry } = await setup();
      registry.get.mockReturnValue({
        getCapabilities: () => ({ clusterEnabled: true, hasClusterSlotStats: true }),
        getClusterNodes: async () => [
          { id: 'c', master: '-' },
          { id: 'c-replica', master: 'c' },
          { id: 'd', master: '-' },
        ],
      } as never);
      const status = await service.setSettings(
        'seed',
        { ...tighter, excludedShardIds: ['c', 'gone'] },
        0,
      );
      expect(status.settings.excludedShardIds).toEqual(['c', 'gone', 'c-replica']);
      expect(status).toMatchObject({ exclusionsExpanded: true, exclusionsExpandProblem: null });
      expect((await storage.getPlacementPolicy('seed'))?.settings.excludedShardIds).toEqual([
        'c',
        'gone',
        'c-replica',
      ]);
    });

    it('stores the excluded shards as given when the topology cannot be read', async () => {
      const { service, storage, registry } = await setup();
      registry.get.mockReturnValue({
        getCapabilities: () => ({ clusterEnabled: true, hasClusterSlotStats: true }),
        getClusterNodes: async () => {
          throw new Error('connection lost');
        },
      } as never);
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        const status = await service.setSettings('seed', tighter, 0);
        expect((await storage.getPlacementPolicy('seed'))?.settings.excludedShardIds).toEqual([
          'c',
        ]);
        expect(status).toMatchObject({
          policyVersion: 1,
          exclusionsExpanded: false,
          exclusionsExpandProblem: 'connection lost',
        });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('were not added (connection lost)'));
      } finally {
        warn.mockRestore();
      }
    });

    it('does not warn about the excluded shards of a save refused at an old version', async () => {
      const { service, registry } = await setup();
      await service.setSettings('seed', DEFAULT_PLACEMENT_SETTINGS, 0);
      registry.get.mockReturnValue({
        getCapabilities: () => ({ clusterEnabled: true, hasClusterSlotStats: true }),
        getClusterNodes: async () => {
          throw new Error('connection lost');
        },
      } as never);
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        await expect(service.setSettings('seed', tighter, 0)).rejects.toThrow(
          PlacementPolicyConflictError,
        );
        expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('were not added'));
      } finally {
        warn.mockRestore();
      }
    });

    it('saves the excluded shards as typed and says so when CLUSTER NODES takes over 2 s', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        const { service, storage, registry } = await setup();
        registry.get.mockReturnValue({
          getCapabilities: () => ({ clusterEnabled: true, hasClusterSlotStats: true }),
          getClusterNodes: () => new Promise(() => undefined),
        } as never);
        const saving = service.setSettings('seed', tighter, 0);
        await jest.advanceTimersByTimeAsync(2_000);
        expect(await saving).toMatchObject({
          exclusionsExpanded: false,
          exclusionsExpandProblem: 'CLUSTER NODES did not answer within 2 s',
        });
        expect((await storage.getPlacementPolicy('seed'))?.settings.excludedShardIds).toEqual([
          'c',
        ]);
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
        jest.useRealTimers();
      }
    });

    it('says nothing was left out when no shard is excluded', async () => {
      const { service } = await setup();
      expect(
        await service.setSettings('seed', { ...tighter, excludedShardIds: [] }, 0),
      ).toMatchObject({ exclusionsExpanded: true, exclusionsExpandProblem: null });
    });

    it('stores the mode a connection runs in when its first policy is saved', async () => {
      const { service, storage } = await setup({ env: { STORAGE_TYPE: 'memory' } });
      await service.setSettings('seed', tighter, 0);
      expect((await storage.getPlacementPolicy('seed'))?.mode).toBe('recommend');
    });

    it('writes the policy on the seed when saved through a member', async () => {
      const { service, storage } = await setup({
        configs: {
          seed: { id: 'seed', host: '10.0.0.1', port: 7001 },
          member: {
            id: 'member',
            host: '10.0.0.2',
            port: 7002,
            membership: { seedId: 'seed', nodeId: 'n2', origin: 'auto', source: 'cluster' },
          },
        },
      });
      await service.setSettings('member', tighter, 0);
      expect((await storage.getPlacementPolicy('seed'))?.settings).toEqual(tighter);
      expect(await storage.getPlacementPolicy('member')).toBeNull();
    });

    it('refuses an inconsistent policy with every error', async () => {
      const { service, storage } = await setup();
      const saving = service.setSettings(
        'seed',
        { ...tighter, resolveRatio: 3, verifyTolerance: 2 },
        0,
      );
      await expect(saving).rejects.toThrow(PlacementPolicyError);
      await expect(saving).rejects.toMatchObject({
        errors: [
          expect.stringContaining('verifyTolerance'),
          expect.stringContaining('resolveRatio'),
        ],
      });
      expect(await storage.getPlacementPolicy('seed')).toBeNull();
    });

    it('refuses a policy saved at a version that is no longer stored', async () => {
      const { service } = await setup();
      await service.setSettings('seed', tighter, 0);
      await expect(service.setSettings('seed', DEFAULT_PLACEMENT_SETTINGS, 0)).rejects.toThrow(
        PlacementPolicyConflictError,
      );
      expect((await service.getStatus('seed')).settings).toEqual(tighter);
    });

    it('draws the balance lines from the policy', async () => {
      const { service } = await setup();
      await service.setSettings('seed', { ...DEFAULT_PLACEMENT_SETTINGS, triggerRatio: 4 }, 0);
      const status = await service.getStatus('seed');
      expect(status.balance).toMatchObject({ triggerRatio: 4 });
      expect(status.balance?.shards[0]).toMatchObject({
        shardId: 'a',
        ratio: 3,
        overTrigger: false,
      });
    });

    it('hands the planner the policy of the seed, on top of the planner defaults', async () => {
      const { service, anomaly } = await setup();
      service.onModuleInit();
      const resolve = anomaly.setRebalancePolicyResolver.mock.calls[0][0] as (
        seedId: string,
      ) => Promise<unknown>;
      expect(await resolve('seed')).toEqual(DEFAULT_REBALANCE_POLICY);

      await service.setSettings(
        'seed',
        { ...tighter, nodeCpuLimitUsecPerSecond: 600_000, resolveRatio: 1.4 },
        0,
      );

      expect(await resolve('seed')).toEqual({
        ...DEFAULT_REBALANCE_POLICY,
        nodeCpuLimitUsecPerSecond: 600_000,
        resolveRatio: 1.4,
        excludedShardIds: ['c'],
        excludedSlots: [7],
      });
    });

    it('lets the planner read the policy once per half minute', async () => {
      const { service, anomaly, storage } = await setup();
      service.onModuleInit();
      const resolve = anomaly.setRebalancePolicyResolver.mock.calls[0][0] as (
        seedId: string,
      ) => Promise<unknown>;
      const read = jest.spyOn(storage, 'getPlacementPolicy');
      await resolve('seed');
      await resolve('seed');
      expect(read).toHaveBeenCalledTimes(1);
    });

    it('gives the planner a policy saved on another instance after half a minute', async () => {
      jest.useFakeTimers({ now: 1_000_000 });
      try {
        const { service, anomaly, storage } = await setup();
        service.onModuleInit();
        const resolve = anomaly.setRebalancePolicyResolver.mock.calls[0][0] as (
          seedId: string,
        ) => Promise<{ excludedSlots: readonly number[] }>;
        await resolve('seed');
        await storage.savePlacementSettings(
          { connectionId: 'seed', settings: tighter, updatedAt: 2, modeIfNew: 'observe' },
          0,
        );
        expect((await resolve('seed')).excludedSlots).toEqual([]);
        jest.setSystemTime(1_030_001);
        expect((await resolve('seed')).excludedSlots).toEqual([7]);
      } finally {
        jest.useRealTimers();
      }
    });

    it('holds the planner when the cached policy is old and the storage cannot be read', async () => {
      jest.useFakeTimers({ now: 1_000_000 });
      try {
        const { service, anomaly, storage } = await setup();
        service.onModuleInit();
        const resolve = anomaly.setRebalancePolicyResolver.mock.calls[0][0] as (
          seedId: string,
        ) => Promise<unknown>;
        await resolve('seed');
        jest.spyOn(storage, 'getPlacementPolicy').mockRejectedValue(new Error('db down'));
        jest.setSystemTime(1_030_001);
        await expect(resolve('seed')).rejects.toThrow('db down');
      } finally {
        jest.useRealTimers();
      }
    });

    it('keeps a saved policy in the cache when an older read finishes after the save', async () => {
      const { service, anomaly, storage } = await setup();
      service.onModuleInit();
      const resolve = anomaly.setRebalancePolicyResolver.mock.calls[0][0] as (
        seedId: string,
      ) => Promise<{ excludedSlots: readonly number[] }>;
      const before = await storage.getPlacementPolicy('seed');
      let finish: (policy: PlacementPolicy | null) => void = () => undefined;
      jest
        .spyOn(storage, 'getPlacementPolicy')
        .mockImplementationOnce(() => new Promise((done) => (finish = done)));
      const slow = service.getStatus('seed');
      await service.setSettings('seed', tighter, 0);
      finish(before);
      expect((await slow).policyVersion).toBe(0);
      expect((await resolve('seed')).excludedSlots).toEqual([7]);
    });

    it('answers a save from the row it wrote, even when a read after it fails', async () => {
      const { service, storage } = await setup();
      const settings = { ...tighter, excludedShardIds: [] };
      jest
        .spyOn(storage, 'getPlacementPolicy')
        .mockResolvedValueOnce(null)
        .mockRejectedValue(new Error('db down'));
      await expect(service.setSettings('seed', settings, 0)).resolves.toMatchObject({
        settings,
        policyVersion: 1,
      });
    });

    it('publishes no policy read that finishes after its seed was removed', async () => {
      const { service, storage, configs, shardLoad } = await setup();
      let finish: (policy: PlacementPolicy | null) => void = () => undefined;
      jest
        .spyOn(storage, 'getPlacementPolicy')
        .mockImplementationOnce(() => new Promise((done) => (finish = done)));
      const slow = service.getStatus('seed');
      delete configs.seed;
      finish({
        connectionId: 'seed',
        mode: 'recommend',
        settings: { ...DEFAULT_PLACEMENT_SETTINGS, sustainMinutes: 45 },
        version: 1,
        updatedAt: 1,
      });
      await slow.catch(() => undefined);
      expect(shardLoad.setSustainMinutes).not.toHaveBeenCalledWith('seed', 45);
    });

    it('reads the settings with their version from the half-minute cache', async () => {
      const { service, storage } = await setup();
      expect(await service.settingsOf('seed')).toEqual({
        settings: DEFAULT_PLACEMENT_SETTINGS,
        version: 0,
        invalid: null,
      });
      await storage.savePlacementSettings(
        { connectionId: 'seed', settings: tighter, updatedAt: 2, modeIfNew: 'observe' },
        0,
      );

      expect((await service.settingsOf('seed')).version).toBe(0);
      expect((await service.getStatus('seed')).policyVersion).toBe(1);
      expect(await service.settingsOf('seed')).toEqual({
        settings: tighter,
        version: 1,
        invalid: null,
      });
    });

    it('maps the settings the planner uses over the planner defaults', () => {
      expect(rebalancePolicyOf({ ...tighter, resolveRatio: 1.5 })).toEqual({
        ...DEFAULT_REBALANCE_POLICY,
        resolveRatio: 1.5,
        excludedShardIds: ['c'],
        excludedSlots: [7],
      });
    });

    describe('a stored policy that does not validate', () => {
      function storedInvalid(exclusionsReadable: boolean): PlacementPolicy {
        return {
          connectionId: 'seed',
          mode: 'recommend',
          settings: { ...tighter, sustainMinutes: DEFAULT_PLACEMENT_SETTINGS.sustainMinutes },
          version: 5,
          updatedAt: 1,
          invalid: { problems: ['sustainMinutes: Too big'], exclusionsReadable },
        };
      }

      afterEach(() => jest.restoreAllMocks());

      it('shows the problem on the status, warns once, and plans with the exclusions it read', async () => {
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        const { service, anomaly, storage } = await setup();
        jest.spyOn(storage, 'getPlacementPolicy').mockResolvedValue(storedInvalid(true));
        service.onModuleInit();
        const resolve = anomaly.setRebalancePolicyResolver.mock.calls[0][0] as (
          seedId: string,
        ) => Promise<unknown>;

        expect(await service.getStatus('seed')).toMatchObject({
          policyVersion: 5,
          policyInvalid: { problems: ['sustainMinutes: Too big'], exclusionsReadable: true },
          settings: { excludedShardIds: ['c'], excludedSlots: [7] },
        });
        await service.getStatus('seed');
        expect(await resolve('seed')).toMatchObject({
          excludedShardIds: ['c'],
          excludedSlots: [7],
        });

        const warnings = warn.mock.calls.filter(([message]) =>
          String(message).includes('does not validate'),
        );
        expect(warnings).toHaveLength(1);
        expect(String(warnings[0][0])).toContain('version 5');
      });

      it('plans nothing while its exclusions cannot be read', async () => {
        jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        const { service, anomaly, storage } = await setup();
        jest.spyOn(storage, 'getPlacementPolicy').mockResolvedValue(storedInvalid(false));
        service.onModuleInit();
        const resolve = anomaly.setRebalancePolicyResolver.mock.calls[0][0] as (
          seedId: string,
        ) => Promise<unknown>;

        await expect(resolve('seed')).rejects.toThrow(PlacementPolicyUnreadableError);
        expect((await service.getStatus('seed')).policyInvalid).toEqual({
          problems: ['sustainMinutes: Too big'],
          exclusionsReadable: false,
        });
      });
    });

    it('fails the planner read when storage fails and nothing was read before', async () => {
      const { service, anomaly, storage } = await setup();
      service.onModuleInit();
      const resolve = anomaly.setRebalancePolicyResolver.mock.calls[0][0] as (
        seedId: string,
      ) => Promise<unknown>;
      jest.spyOn(storage, 'getPlacementPolicy').mockRejectedValue(new Error('db down'));
      await expect(resolve('seed')).rejects.toThrow('db down');
    });
  });

  it('refuses Approve and Auto in this phase', async () => {
    const { service } = await setup();
    await expect(service.setMode('seed', 'approve')).rejects.toThrow(PlacementModeError);
    await expect(service.setMode('seed', 'auto')).rejects.toThrow(PlacementModeError);
  });

  it('refuses Recommend where the support verdict blocks it, naming the reason', async () => {
    const { service } = await setup({ clusterEnabled: false, primaries: null });
    await expect(service.setMode('seed', 'recommend')).rejects.toMatchObject({ blockedBy: 'not_cluster' });
  });

  it('shows Observe as the effective mode when Recommend is no longer supported', async () => {
    const { service, storage, prometheus } = await setup();
    await storage.savePlacementMode({ connectionId: 'seed', mode: 'recommend', updatedAt: 1 });
    prometheus.collectsClusterSlotStats.mockReturnValue(false);
    const status = await service.getStatus('seed');
    expect(status).toMatchObject({ mode: 'recommend', effectiveMode: 'observe', selectableModes: ['observe'] });
    expect(status.support.modes.recommend.blockedBy).toBe('slot_stats_off');
  });

  it('keeps a clean Recommend on memory storage and without sign-in', async () => {
    const { service } = await setup({ env: { STORAGE_TYPE: 'memory' }, signIn: false });
    const status = await service.getStatus('seed');
    expect(status.support.modes.recommend).toEqual({ available: true, blockedBy: null });
    expect(status.support.modes.approve.blockedBy).toBe('memory_storage');
    expect(status.support.modes.auto.blockedBy).toBe('memory_storage');
  });

  it('marks the slot migration flag, a managed host and a per-node registration', async () => {
    const { service, clusterMetrics } = await setup({
      env: { BETTERDB_SLOT_MIGRATION: 'false' },
      configs: { seed: { id: 'seed', host: 'cfg.abc.use1.cache.amazonaws.com', port: 6379 } },
    });
    clusterMetrics.usesClusterWideSlotStats.mockResolvedValue(false);
    const reasons = (await service.getStatus('seed')).support.issues.map((issue) => issue.reason);
    expect(reasons).toEqual(['provider_managed', 'per_node_connections', 'flag_off']);
  });

  it('reads no nodes for an agent connection', async () => {
    const { service, anomaly } = await setup({
      configs: { seed: { id: 'seed', host: 'agent', port: 0, connectionType: 'agent' } as never },
    });
    const status = await service.getStatus('seed');
    expect(anomaly.readPlacementPrimaries).not.toHaveBeenCalled();
    expect(status.support.modes.recommend.blockedBy).toBe('not_dialed');
  });

  describe('running a plan', () => {
    const moves = [{ targetShardId: 'b', ranges: [[0, 10]] as [number, number][] }];
    const actor = { userId: 'u1', email: null };
    const noperm = 'NOPERM User monitor has no permissions to run the cluster|migrateslots command';

    it('runs no plan in Observe', async () => {
      const { service, anomaly } = await setup();
      await expect(service.runRebalance('seed', 'a', moves, actor)).resolves.toEqual({
        status: 'blocked',
        blockedBy: 'observe_mode',
      });
      expect(anomaly.runRebalance).not.toHaveBeenCalled();
    });

    it('passes the run on in Recommend', async () => {
      const { service, storage, anomaly } = await setup();
      await storage.savePlacementMode({ connectionId: 'seed', mode: 'recommend', updatedAt: 1 });
      anomaly.runRebalance.mockResolvedValue({ status: 'blocked', blockedBy: 'flag_off' });
      await expect(service.runRebalance('seed', 'a', moves, actor)).resolves.toEqual({
        status: 'blocked',
        blockedBy: 'flag_off',
      });
      expect(anomaly.runRebalance).toHaveBeenCalledWith('seed', 'a', moves, actor);
    });

    it('runs no plan once another instance stored Observe, though the cache still says Recommend', async () => {
      const { service, storage, anomaly } = await setup();
      await storage.savePlacementMode({ connectionId: 'seed', mode: 'recommend', updatedAt: 1 });
      expect((await service.getStatus('seed')).mode).toBe('recommend');
      await storage.savePlacementMode({ connectionId: 'seed', mode: 'observe', updatedAt: 2 });
      await expect(service.runRebalance('seed', 'a', moves, actor)).resolves.toEqual({
        status: 'blocked',
        blockedBy: 'observe_mode',
      });
      expect(anomaly.runRebalance).not.toHaveBeenCalled();
    });

    describe('the gate', () => {
      const failover = { metricType: 'failover_churn', nodeId: 'b', openedAt: Date.now() };

      it('blocks the run while an event is open on a target node, and runs it once it closes', async () => {
        const { service, storage, anomaly } = await setup();
        await storage.savePlacementMode({ connectionId: 'seed', mode: 'recommend', updatedAt: 1 });
        anomaly.placementOpenEvents.mockResolvedValue([failover]);
        await expect(service.runRebalance('seed', 'a', moves, actor)).resolves.toEqual({
          status: 'blocked',
          blockedBy: 'gate',
          blockers: [expect.objectContaining({ kind: 'failover', scope: 'target', nodeId: 'b' })],
        });
        expect(anomaly.readPlacementNodeFacts).toHaveBeenCalledWith('seed', ['a', 'b']);
        expect(anomaly.runRebalance).not.toHaveBeenCalled();

        anomaly.placementOpenEvents.mockResolvedValue([]);
        anomaly.runRebalance.mockResolvedValue({ status: 'started', run: {} });
        await expect(service.runRebalance('seed', 'a', moves, actor)).resolves.toMatchObject({
          status: 'started',
        });
        expect(anomaly.runRebalance).toHaveBeenCalledWith('seed', 'a', moves, actor);
      });

      const listing = (sourceShardId: string, targetShardId: string) => [
        {
          eventId: 'evt',
          shardId: sourceShardId,
          nodeAddr: `${sourceShardId}:7000`,
          rebalance: {
            kind: 'plan',
            sourceShardId,
            moves: [{ targetShardId, ranges: [[0, 10]] }],
            execution: { available: true },
          },
        } as unknown as ServedHotShardDetail,
      ];

      it.each([
        ['the same connection', 'seed'],
        ['a member', 'member'],
      ])(
        'drops the listed gate of a plan once a run of it was refused, also when listed through %s',
        async (_, listedThrough) => {
          const { service, storage, anomaly } = await setup({ configs: withMember });
          await storage.savePlacementMode({
            connectionId: 'seed',
            mode: 'recommend',
            updatedAt: 1,
          });
          const listed = listing('a', 'b');
          const [before] = await service.withPlacementBlocker(listedThrough, listed);
          expect(before.rebalance).toMatchObject({ execution: { available: true } });

          anomaly.placementOpenEvents.mockResolvedValue([failover]);
          await expect(service.runRebalance('seed', 'a', moves, actor)).resolves.toMatchObject({
            status: 'blocked',
            blockedBy: 'gate',
          });

          const [after] = await service.withPlacementBlocker(listedThrough, listed);
          expect(after.rebalance).toMatchObject({
            execution: { available: false, blockedBy: 'gate' },
            gate: {
              allowed: false,
              blockers: [expect.objectContaining({ kind: 'failover', nodeId: 'b' })],
            },
          });
        },
      );

      it('keeps the listed gates of another shard and of another cluster when a run is refused', async () => {
        const { service, storage, anomaly } = await setup({
          configs: { ...withMember, other: { id: 'other', host: '10.0.0.9', port: 7009 } },
        });
        await storage.savePlacementMode({ connectionId: 'seed', mode: 'recommend', updatedAt: 1 });
        await storage.savePlacementMode({ connectionId: 'other', mode: 'recommend', updatedAt: 1 });
        await service.withPlacementBlocker('seed', listing('c', 'd'));
        await service.withPlacementBlocker('other', listing('a', 'b'));
        anomaly.placementOpenEvents.mockResolvedValue([failover]);
        await service.runRebalance('seed', 'a', moves, actor);
        const reads = anomaly.readPlacementNodeFacts.mock.calls.length;
        await service.withPlacementBlocker('seed', listing('c', 'd'));
        await service.withPlacementBlocker('other', listing('a', 'b'));
        expect(anomaly.readPlacementNodeFacts).toHaveBeenCalledTimes(reads);
      });

      it('keeps a list read that started before a refused run out of the cache', async () => {
        const { service, storage, anomaly } = await setup();
        await storage.savePlacementMode({ connectionId: 'seed', mode: 'recommend', updatedAt: 1 });
        let finish: (facts: PlacementNodeFacts) => void = () => {};
        anomaly.readPlacementNodeFacts.mockReturnValueOnce(
          new Promise<PlacementNodeFacts>((resolve) => {
            finish = resolve;
          }),
        );
        const early = service.withPlacementBlocker('seed', listing('a', 'b'));
        await settled();
        anomaly.placementOpenEvents.mockResolvedValue([failover]);
        await service.runRebalance('seed', 'a', moves, actor);
        finish(healthyNodes());
        await early;

        const [after] = await service.withPlacementBlocker('seed', listing('a', 'b'));
        expect(after.rebalance).toMatchObject({
          execution: { available: false, blockedBy: 'gate' },
        });
      });

      it('gates a run started through a member on the events and the budget of its seed', async () => {
        const { service, storage, anomaly } = await setup({ configs: withMember });
        await storage.savePlacementMode({ connectionId: 'seed', mode: 'recommend', updatedAt: 1 });
        anomaly.placementOpenEvents.mockImplementation(async (...args: unknown[]) =>
          args[0] === 'seed' ? [failover] : [],
        );
        await expect(service.runRebalance('member', 'a', moves, actor)).resolves.toEqual({
          status: 'blocked',
          blockedBy: 'gate',
          blockers: [expect.objectContaining({ kind: 'failover', scope: 'target', nodeId: 'b' })],
        });
        expect(anomaly.readPlacementNodeFacts).toHaveBeenCalledWith('seed', ['a', 'b']);
        expect(anomaly.placementJobsSince).toHaveBeenCalledWith('seed', expect.any(Number));
        expect(anomaly.placementMovedShardsSince).toHaveBeenCalledWith('seed', expect.any(Number));
        expect(anomaly.runRebalance).not.toHaveBeenCalled();
      });

      it('counts the slot jobs of the last hour against the budget', async () => {
        const { service, storage, anomaly } = await setup();
        await storage.savePlacementMode({ connectionId: 'seed', mode: 'recommend', updatedAt: 1 });
        anomaly.placementJobsSince.mockReturnValue(4);
        const result = await service.runRebalance('seed', 'a', moves, actor);
        expect(result).toMatchObject({ status: 'blocked', blockedBy: 'gate' });
        expect(anomaly.placementJobsSince).toHaveBeenCalledWith('seed', expect.any(Number));
      });

      it('counts every move against the budget, even two to one target', async () => {
        const { service, storage, anomaly } = await setup();
        await storage.savePlacementMode({ connectionId: 'seed', mode: 'recommend', updatedAt: 1 });
        anomaly.placementJobsSince.mockReturnValue(3);
        anomaly.runRebalance.mockResolvedValue({ status: 'started', run: {} });
        const one = [{ targetShardId: 'b', ranges: [[0, 10]] as [number, number][] }];
        const two = [...one, { targetShardId: 'b', ranges: [[20, 30]] as [number, number][] }];
        await expect(service.runRebalance('seed', 'a', one, actor)).resolves.toMatchObject({
          status: 'started',
        });
        await expect(service.runRebalance('seed', 'a', two, actor)).resolves.toEqual({
          status: 'blocked',
          blockedBy: 'gate',
          blockers: [expect.objectContaining({ kind: 'budget', scope: 'cluster' })],
        });
      });

      it('gates the moves it was asked to run, not the plan it holds', async () => {
        const { service, storage, anomaly } = await setup();
        await storage.savePlacementMode({ connectionId: 'seed', mode: 'recommend', updatedAt: 1 });
        anomaly.placementPlans.mockReturnValue([
          { kind: 'plan', sourceShardId: 'a', moves } as unknown as RebalancePlan,
        ]);
        anomaly.placementOpenEvents.mockResolvedValue([{ ...failover, nodeId: 'c' }]);
        const toC = [{ targetShardId: 'c', ranges: [[0, 10]] as [number, number][] }];
        await expect(service.runRebalance('seed', 'a', toC, actor)).resolves.toEqual({
          status: 'blocked',
          blockedBy: 'gate',
          blockers: [expect.objectContaining({ kind: 'failover', scope: 'target', nodeId: 'c' })],
        });
        expect(anomaly.readPlacementNodeFacts).toHaveBeenCalledWith('seed', ['a', 'c']);
        expect(anomaly.runRebalance).not.toHaveBeenCalled();
      });

      it('holds a run back while the stored policy does not validate', async () => {
        const { service, storage, anomaly } = await setup();
        jest.spyOn(storage, 'getPlacementPolicy').mockResolvedValue({
          connectionId: 'seed',
          mode: 'recommend',
          settings: DEFAULT_PLACEMENT_SETTINGS,
          version: 5,
          updatedAt: 1,
          invalid: { problems: ['maintenanceWindows: expected array'], exclusionsReadable: true },
        });
        await expect(service.runRebalance('seed', 'a', moves, actor)).resolves.toEqual({
          status: 'blocked',
          blockedBy: 'gate',
          blockers: [
            { kind: 'unknown', scope: 'cluster', detail: 'Could not read the placement policy.' },
          ],
        });
        expect(anomaly.runRebalance).not.toHaveBeenCalled();
      });

      it('answers an unknown gate and runs nothing when the safety checks cannot be read', async () => {
        const { service, storage, anomaly } = await setup();
        await storage.savePlacementMode({ connectionId: 'seed', mode: 'recommend', updatedAt: 1 });
        jest
          .spyOn(storage, 'getPlacementPolicy')
          .mockResolvedValueOnce(await storage.getPlacementPolicy('seed'))
          .mockRejectedValue(new Error('db down'));
        await expect(service.runRebalance('seed', 'a', moves, actor)).resolves.toEqual({
          status: 'blocked',
          blockedBy: 'gate',
          blockers: [
            { kind: 'unknown', scope: 'cluster', detail: 'Could not run the safety checks.' },
          ],
        });
        expect(anomaly.runRebalance).not.toHaveBeenCalled();
      });

      it('checks a run against the hourly limit saved on another instance', async () => {
        const { service, storage, anomaly } = await setup();
        await storage.savePlacementMode({ connectionId: 'seed', mode: 'recommend', updatedAt: 1 });
        anomaly.placementJobsSince.mockReturnValue(1);
        await service.getStatus('seed');
        await storage.savePlacementSettings(
          {
            connectionId: 'seed',
            settings: { ...DEFAULT_PLACEMENT_SETTINGS, maxMigrationsPerHour: 1 },
            updatedAt: 2,
            modeIfNew: 'recommend',
          },
          0,
        );
        await expect(service.runRebalance('seed', 'a', moves, actor)).resolves.toEqual({
          status: 'blocked',
          blockedBy: 'gate',
          blockers: [expect.objectContaining({ kind: 'budget', scope: 'cluster' })],
        });
        expect(anomaly.runRebalance).not.toHaveBeenCalled();
      });

      it('reads the gate again once the policy is saved, not the verdict from before', async () => {
        const { service, storage, anomaly } = await setup();
        await storage.savePlacementMode({ connectionId: 'seed', mode: 'recommend', updatedAt: 1 });
        anomaly.placementJobsSince.mockReturnValue(1);
        anomaly.placementPlans.mockReturnValue([
          { kind: 'plan', sourceShardId: 'a', moves } as unknown as RebalancePlan,
        ]);
        const before = await service.getStatus('seed');
        expect(before.recommendations[0].gate.allowed).toBe(true);
        const saved = await service.setSettings(
          'seed',
          { ...DEFAULT_PLACEMENT_SETTINGS, maxMigrationsPerHour: 1 },
          0,
        );
        expect(saved.recommendations[0].gate).toMatchObject({
          allowed: false,
          blockers: [expect.objectContaining({ kind: 'budget' })],
        });
      });

      it('takes the trigger time of a stored action over the live trigger', async () => {
        const { service, anomaly } = await setup();
        const now = Date.now();
        anomaly.placementOpenEvents.mockResolvedValue([
          { metricType: 'command_p99', nodeId: 'a', openedAt: now - 1_000 },
        ]);
        const subject = { sourceShardId: 'a', targetShardIds: ['b'], moveCount: 1 };
        const live = await service.gateFor('seed', subject, 'approve', { now });
        expect(live.blockers).toEqual([
          expect.objectContaining({ kind: 'latency', scope: 'source', nodeId: 'a' }),
        ]);
        const pinned = await service.gateFor('seed', subject, 'approve', {
          now,
          sourceTriggerFiredAt: now - 60_000,
        });
        expect(pinned.allowed).toBe(true);
      });

      it('dates a config epoch raise by the poll that saw it', async () => {
        const { service, anomaly } = await setup();
        const now = Date.now();
        const subject = { sourceShardId: 'a', targetShardIds: ['b'], moveCount: 1 };
        anomaly.readPlacementNodeFacts.mockResolvedValue(withUncollectedReplica(1));
        await service.gateFor('seed', subject, 'approve', { now: now - 30 * 60_000 });
        const observe = anomaly.setClusterNodesObserver.mock.calls[0][0] as (
          connectionId: string,
          nodes: ClusterNode[],
          at: number,
        ) => void;
        observe('seed', polledNodes(1), now - 25 * 60_000);
        observe('seed', polledNodes(2), now - 19 * 60_000);

        anomaly.readPlacementNodeFacts.mockResolvedValue(withUncollectedReplica(2));
        const later = await service.gateFor('seed', subject, 'approve', { now });
        expect(later.blockers).toEqual([]);
      });

      it('dates a config epoch raise read through a member by the poll of its seed', async () => {
        const { service, anomaly } = await setup({ configs: withMember });
        const now = Date.now();
        const subject = { sourceShardId: 'a', targetShardIds: ['b'], moveCount: 1 };
        anomaly.readPlacementNodeFacts.mockResolvedValue(withUncollectedReplica(1));
        await service.gateFor('member', subject, 'approve', { now: now - 30 * 60_000 });
        const observe = anomaly.setClusterNodesObserver.mock.calls[0][0] as (
          connectionId: string,
          nodes: ClusterNode[],
          at: number,
        ) => void;
        observe('seed', polledNodes(1), now - 25 * 60_000);
        observe('seed', polledNodes(2), now - 19 * 60_000);

        anomaly.readPlacementNodeFacts.mockResolvedValue(withUncollectedReplica(2));
        const later = await service.gateFor('member', subject, 'approve', { now });
        expect(later.blockers).toEqual([]);
      });

      it('follows no polls of a connection whose checks were never read', async () => {
        const { service, anomaly } = await setup();
        const now = Date.now();
        const observe = anomaly.setClusterNodesObserver.mock.calls[0][0] as (
          connectionId: string,
          nodes: ClusterNode[],
          at: number,
        ) => void;
        observe('seed', polledNodes(1), now - 10 * 60_000);
        anomaly.readPlacementNodeFacts.mockResolvedValue(withUncollectedReplica(1));
        const first = await service.gateFor(
          'seed',
          { sourceShardId: 'a', targetShardIds: ['b'], moveCount: 1 },
          'approve',
          { now },
        );
        expect(first.blockers).toEqual([
          expect.objectContaining({ kind: 'unknown', scope: 'target', nodeId: 'b2' }),
        ]);
      });

      it('reads a config epoch our own slot move raised as no failover', async () => {
        const { service, anomaly } = await setup();
        const now = Date.now();
        const subject = { sourceShardId: 'a', targetShardIds: ['b'], moveCount: 1 };
        anomaly.readPlacementNodeFacts.mockResolvedValue(withUncollectedReplica(1));
        await service.gateFor('seed', subject, 'approve', { now: now - 10 * 60_000 });

        anomaly.readPlacementNodeFacts.mockResolvedValue(withUncollectedReplica(2));
        anomaly.placementMovedShardsSince.mockReturnValue(['a', 'b']);
        const ours = await service.gateFor('seed', subject, 'approve', { now });
        expect(ours.blockers).toEqual([]);
        expect(anomaly.placementMovedShardsSince).toHaveBeenLastCalledWith(
          'seed',
          now - 5 * 60_000,
        );

        anomaly.readPlacementNodeFacts.mockResolvedValue(withUncollectedReplica(3));
        anomaly.placementMovedShardsSince.mockReturnValue([]);
        const theirs = await service.gateFor('seed', subject, 'approve', { now: now + 60_000 });
        expect(theirs.blockers).toEqual([
          expect.objectContaining({ kind: 'failover', scope: 'target', nodeId: 'b2' }),
        ]);
      });
    });

    it('records a NOPERM reply of the server as acl', async () => {
      const { service, storage, anomaly } = await setup();
      await storage.savePlacementMode({ connectionId: 'seed', mode: 'recommend', updatedAt: 1 });
      anomaly.runRebalance.mockResolvedValue({
        status: 'refused',
        message: noperm,
        serverReply: true,
      });
      await service.runRebalance('seed', 'a', moves, actor);
      expect((await service.getStatus('seed')).support.modes.approve.blockedBy).toBe('acl');
    });

    it('records no acl for a NOPERM met before the slot move', async () => {
      const { service, storage, anomaly } = await setup();
      await storage.savePlacementMode({ connectionId: 'seed', mode: 'recommend', updatedAt: 1 });
      anomaly.runRebalance.mockResolvedValue({
        status: 'refused',
        message: `Could not re-check the cluster: ${noperm}`,
      });
      await service.runRebalance('seed', 'a', moves, actor);
      expect(
        (await service.getStatus('seed')).support.issues.map((issue) => issue.reason),
      ).not.toContain('acl');
    });

    it.each(Array.from({ length: 12 }, (_, ticks) => ticks))(
      'keeps acl from a refusal that lands %i ticks after the primaries of a status read',
      async (ticks) => {
        const { service, storage, anomaly } = await setup();
        await storage.savePlacementMode({
          connectionId: 'seed',
          mode: 'recommend',
          updatedAt: 1,
        });
        let answerPrimaries: (value: PlacementPrimaryRead[]) => void = () => {};
        anomaly.readPlacementPrimaries.mockReturnValueOnce(
          new Promise<PlacementPrimaryRead[]>((resolve) => {
            answerPrimaries = resolve;
          }),
        );
        let refuse: (value: unknown) => void = () => {};
        anomaly.runRebalance.mockReturnValueOnce(
          new Promise((resolve) => {
            refuse = resolve;
          }),
        );
        const run = service.runRebalance('seed', 'a', moves, actor);
        await new Promise((resolve) => setImmediate(resolve));
        const read = service.getStatus('seed');
        await new Promise((resolve) => setImmediate(resolve));
        answerPrimaries(primaries());
        for (let tick = 0; tick < ticks; tick += 1) await Promise.resolve();
        refuse({ status: 'refused', message: noperm, serverReply: true });
        await Promise.all([run, read]);
        expect((await service.getStatus('seed')).support.modes.approve.blockedBy).toBe('acl');
      },
    );

    it('keeps acl until the primaries of the cluster change', async () => {
      const { service, storage, anomaly } = await setup();
      await storage.savePlacementMode({ connectionId: 'seed', mode: 'recommend', updatedAt: 1 });
      anomaly.runRebalance.mockResolvedValue({
        status: 'refused',
        message: noperm,
        serverReply: true,
      });
      await service.runRebalance('seed', 'a', moves, actor);
      expect((await service.getStatus('seed')).support.modes.approve.blockedBy).toBe('acl');
      jest.useFakeTimers({ now: Date.now() + 31_000, doNotFake: ['nextTick', 'setImmediate'] });
      try {
        expect((await service.getStatus('seed')).support.modes.approve.blockedBy).toBe('acl');
        anomaly.readPlacementPrimaries.mockResolvedValue([
          ...primaries(),
          { address: '10.0.0.4:7004', server: valkey9, migrateSlotsCommand: true },
        ]);
        jest.setSystemTime(Date.now() + 31_000);
        expect(
          (await service.getStatus('seed')).support.issues.map((issue) => issue.reason),
        ).not.toContain('acl');
      } finally {
        jest.useRealTimers();
      }
    });
  });

  it('keeps a cluster the monitor has not connected to on Observe instead of failing', async () => {
    const { service, registry } = await setup();
    registry.get.mockReturnValue({
      getCapabilities: () => {
        throw new Error('Capabilities not yet detected');
      },
    });
    const status = await service.getStatus('seed');
    expect(status.effectiveMode).toBe('observe');
    expect(status.support.modes.recommend.blockedBy).toBe('not_connected');
    await expect(service.allowsRun('seed')).resolves.toBe(false);
  });

  it('reads the support again once the monitor has connected', async () => {
    const { service, registry, anomaly } = await setup();
    const connected = registry.get.getMockImplementation();
    registry.get.mockReturnValueOnce({
      getCapabilities: () => {
        throw new Error('Capabilities not yet detected');
      },
    });
    await service.getStatus('seed');
    registry.get.mockImplementation(connected!);
    expect(
      (await service.getStatus('seed')).support.issues.map((issue) => issue.reason),
    ).not.toContain('not_connected');
    expect(anomaly.readPlacementPrimaries).toHaveBeenCalledTimes(1);
  });

  it('reads no primaries to answer whether a plan may run', async () => {
    const { service, storage, anomaly } = await setup();
    expect(await service.allowsRun('seed')).toBe(false);
    await storage.savePlacementMode({ connectionId: 'seed', mode: 'recommend', updatedAt: 1 });
    expect(await service.allowsRun('seed')).toBe(true);
    expect(anomaly.readPlacementPrimaries).not.toHaveBeenCalled();
  });

  it('forgets the support of a removed connection', async () => {
    const { service, anomaly, configs } = await setup({
      configs: {
        seed: { id: 'seed', host: '10.0.0.1', port: 7001 },
        other: { id: 'other', host: '10.0.0.9' },
      },
    });
    await service.getStatus('seed');
    delete configs.seed;
    await service.getStatus('other');
    configs.seed = { id: 'seed', host: '10.0.0.1', port: 7001 };
    await service.getStatus('seed');
    expect(anomaly.readPlacementPrimaries).toHaveBeenCalledTimes(3);
  });

  it('caches the node reads for a short while', async () => {
    const { service, anomaly } = await setup();
    await service.getStatus('seed');
    await service.getStatus('seed');
    expect(anomaly.readPlacementPrimaries).toHaveBeenCalledTimes(1);
  });

  it('tells whether plans may run on a connection', async () => {
    const { service, storage } = await setup();
    expect(await service.allowsRun('seed')).toBe(false);
    await storage.savePlacementMode({ connectionId: 'seed', mode: 'recommend', updatedAt: 1 });
    expect(await service.allowsRun('seed')).toBe(true);
  });

  it('keeps a cluster on Recommend without a stored policy on memory storage', async () => {
    const { service } = await setup({ env: { STORAGE_TYPE: 'memory' } });
    expect((await service.getStatus('seed')).mode).toBe('recommend');
    expect(await service.allowsRun('seed')).toBe(true);
  });

  it('starts a standalone connection in Observe on memory storage', async () => {
    const { service } = await setup({ env: { STORAGE_TYPE: 'memory' }, clusterEnabled: false, primaries: null });
    expect((await service.getStatus('seed')).mode).toBe('observe');
  });

  it('keeps a stored Observe on memory storage', async () => {
    const { service, storage } = await setup({ env: { STORAGE_TYPE: 'memory' } });
    await storage.savePlacementMode({ connectionId: 'seed', mode: 'observe', updatedAt: 1 });
    expect(await service.allowsRun('seed')).toBe(false);
  });

  it('lets no plan run while the cluster runs as Observe', async () => {
    const { service, storage, prometheus } = await setup();
    await storage.savePlacementMode({ connectionId: 'seed', mode: 'recommend', updatedAt: 1 });
    prometheus.collectsClusterSlotStats.mockReturnValue(false);
    expect(await service.allowsRun('seed')).toBe(false);
  });

  it('shares a support read already in flight', async () => {
    const { service, anomaly } = await setup();
    let release: (value: PlacementPrimaryRead[]) => void = () => undefined;
    anomaly.readPlacementPrimaries.mockImplementationOnce(
      () => new Promise<PlacementPrimaryRead[]>((resolve) => (release = resolve)),
    );
    const first = service.getStatus('seed');
    const second = service.getStatus('seed');
    await new Promise((resolve) => setImmediate(resolve));
    release(primaries());
    await Promise.all([first, second]);
    expect(anomaly.readPlacementPrimaries).toHaveBeenCalledTimes(1);
  });

  it('reads the nodes again after a failed support read', async () => {
    const { service, anomaly } = await setup();
    anomaly.readPlacementPrimaries.mockRejectedValueOnce(new Error('boom'));
    await expect(service.getStatus('seed')).rejects.toThrow('boom');
    await service.getStatus('seed');
    expect(anomaly.readPlacementPrimaries).toHaveBeenCalledTimes(2);
  });

  describe('marking plans by the placement mode', () => {
    const shard = (rebalance: ServedHotShardDetail['rebalance']) =>
      ({ eventId: 'evt', shardId: 'a', nodeAddr: 'a:7000', rebalance }) as ServedHotShardDetail;
    const plan = (execution: RebalancePlan['execution']) =>
      ({ kind: 'plan', sourceShardId: 'a', moves: [], execution }) as unknown as RebalancePlan;

    it('leaves every plan out in Observe and keeps verdicts that name no plan', async () => {
      const { service, anomaly } = await setup();
      const none: RebalanceNoPlan = { kind: 'no_plan', action: 'spread', reason: 'key_level', pinnedSlots: [] };
      const other = [{ shardId: 'a', nodeAddr: 'a:7000' }];
      const marked = await service.withPlacementBlocker('seed', [
        shard(plan({ available: true })),
        shard(plan({ available: false, blockedBy: 'flag_off' })),
        shard(none),
        shard({ ...none, reason: 'covered_by_other_plan', coveredBy: other }),
        shard({ ...none, reason: 'conflicts_with_other_plan', conflictsWith: other }),
        shard(undefined),
      ]);
      expect(marked.map((each: ServedHotShardDetail) => each.rebalance)).toEqual([
        undefined,
        undefined,
        none,
        undefined,
        undefined,
        undefined,
      ]);
      expect(marked[0]).toMatchObject({ eventId: 'evt', shardId: 'a', nodeAddr: 'a:7000' });
      expect(anomaly.readPlacementPrimaries).not.toHaveBeenCalled();
    });

    it('keeps a runnable plan runnable in Recommend and attaches the gate', async () => {
      const { service, storage } = await setup();
      await storage.savePlacementMode({ connectionId: 'seed', mode: 'recommend', updatedAt: 1 });
      const [marked] = await service.withPlacementBlocker('seed', [
        shard(plan({ available: true })),
      ]);
      expect(marked.rebalance).toMatchObject({
        execution: { available: true },
        gate: { allowed: true, blockers: [], warnings: [] },
      });
    });

    it('marks a plan the gate blocks as not runnable, and reuses the gate for 10 seconds', async () => {
      const { service, storage, anomaly } = await setup();
      await storage.savePlacementMode({ connectionId: 'seed', mode: 'recommend', updatedAt: 1 });
      anomaly.placementOpenEvents.mockResolvedValue([
        { metricType: 'persistence_child', nodeId: 'a', openedAt: Date.now() },
      ]);
      const shards = [shard(plan({ available: true }))];
      const [marked] = await service.withPlacementBlocker('seed', shards);
      expect(marked.rebalance).toMatchObject({
        execution: { available: false, blockedBy: 'gate' },
        gate: {
          allowed: false,
          blockers: [expect.objectContaining({ kind: 'fork', scope: 'source' })],
        },
      });
      await service.withPlacementBlocker('seed', shards);
      expect(anomaly.readPlacementNodeFacts).toHaveBeenCalledTimes(1);
    });

    it('answers an unknown gate when the safety checks throw, and reads the gate once for calls at the same time', async () => {
      const { service, storage, anomaly } = await setup();
      await storage.savePlacementMode({ connectionId: 'seed', mode: 'recommend', updatedAt: 1 });
      const shards = [shard(plan({ available: true }))];
      const [first, second] = await Promise.all([
        service.withPlacementBlocker('seed', shards),
        service.withPlacementBlocker('seed', shards),
      ]);
      expect(first).toEqual(second);
      expect(anomaly.readPlacementNodeFacts).toHaveBeenCalledTimes(1);

      const later = await setup();
      await later.storage.savePlacementMode({
        connectionId: 'seed',
        mode: 'recommend',
        updatedAt: 1,
      });
      later.anomaly.placementJobsSince.mockImplementation(() => {
        throw new Error('storage is down');
      });
      const [marked] = await later.service.withPlacementBlocker('seed', shards);
      expect(marked.rebalance).toMatchObject({
        execution: { available: false, blockedBy: 'gate' },
        gate: {
          allowed: false,
          blockers: [
            { kind: 'unknown', scope: 'cluster', detail: 'Could not run the safety checks.' },
          ],
        },
      });
    });

    it.each([
      ['finishes', healthyNodes],
      [
        'fails',
        () =>
          ({
            get nodes(): never {
              throw new Error('torn read');
            },
          }) as unknown as PlacementNodeFacts,
      ],
    ])(
      'keeps the gate of the newer plan when the read of the plan before it %s later',
      async (_, late) => {
        const { service, storage, anomaly } = await setup();
        await storage.savePlacementMode({ connectionId: 'seed', mode: 'recommend', updatedAt: 1 });
        const to = (targetShardId: string) =>
          shard({
            kind: 'plan',
            sourceShardId: 'a',
            moves: [{ targetShardId, ranges: [[0, 3]] }],
            execution: { available: true },
          } as unknown as RebalancePlan);
        let finish: (facts: PlacementNodeFacts) => void = () => {};
        anomaly.readPlacementNodeFacts.mockReturnValueOnce(
          new Promise<PlacementNodeFacts>((resolve) => {
            finish = resolve;
          }),
        );
        const older = service.withPlacementBlocker('seed', [to('b')]);
        await settled();
        await service.withPlacementBlocker('seed', [to('c')]);
        finish(late());
        await older;

        await service.withPlacementBlocker('seed', [to('c')]);
        expect(anomaly.readPlacementNodeFacts).toHaveBeenCalledTimes(2);
      },
    );

    it('reads the gate of a plan listed through a member from its seed', async () => {
      const { service, storage, anomaly } = await setup({ configs: withMember });
      await storage.savePlacementMode({ connectionId: 'seed', mode: 'recommend', updatedAt: 1 });
      await service.withPlacementBlocker('member', [shard(plan({ available: true }))]);
      expect(anomaly.readPlacementNodeFacts).toHaveBeenCalledWith('seed', ['a']);
    });

    it('leaves a plan that is not runnable for another reason without a gate', async () => {
      const { service, storage, anomaly } = await setup();
      await storage.savePlacementMode({ connectionId: 'seed', mode: 'recommend', updatedAt: 1 });
      const shards = [shard(plan({ available: false, blockedBy: 'flag_off' }))];
      expect(await service.withPlacementBlocker('seed', shards)).toEqual(shards);
      expect(anomaly.readPlacementNodeFacts).not.toHaveBeenCalled();
    });

    it('keeps the plan, not runnable, when the client of the seed is gone', async () => {
      const { service, storage, registry } = await setup();
      await storage.savePlacementMode({ connectionId: 'seed', mode: 'recommend', updatedAt: 1 });
      registry.get.mockImplementation(() => {
        throw new Error("Connection 'seed' not found");
      });
      const [marked] = await service.withPlacementBlocker('seed', [shard(plan({ available: true }))]);
      expect(marked.rebalance).toMatchObject({ kind: 'plan', execution: { available: false } });
      expect((marked.rebalance as RebalancePlan).execution?.blockedBy).toBeUndefined();
    });

    it('leaves the plan out on memory storage when the client of the seed is gone', async () => {
      const { service, registry } = await setup({ env: { STORAGE_TYPE: 'memory' } });
      registry.get.mockImplementation(() => {
        throw new Error("Connection 'seed' not found");
      });
      const [marked] = await service.withPlacementBlocker('seed', [
        shard(plan({ available: true })),
      ]);
      expect(marked.rebalance).toBeUndefined();
    });

    it('keeps the plan, not runnable, when the mode cannot be read', async () => {
      const { service, storage } = await setup();
      jest.spyOn(storage, 'getPlacementPolicy').mockRejectedValue(new Error('db down'));
      const [marked] = await service.withPlacementBlocker('seed', [shard(plan({ available: true }))]);
      expect(marked.rebalance).toMatchObject({ kind: 'plan', execution: { available: false } });
    });

    it('keeps the plan, not runnable, when the seed is being removed', async () => {
      const { service } = await setup({ configs: {} });
      const [marked] = await service.withPlacementBlocker('seed', [shard(plan({ available: true }))]);
      expect(marked.rebalance).toMatchObject({ kind: 'plan', execution: { available: false } });
    });

    it('keeps an earlier blocker when the mode cannot be read', async () => {
      const { service, storage } = await setup();
      jest.spyOn(storage, 'getPlacementPolicy').mockRejectedValue(new Error('db down'));
      const blocked = plan({ available: false, blockedBy: 'flag_off' });
      const [marked] = await service.withPlacementBlocker('seed', [shard(blocked)]);
      expect(marked.rebalance).toEqual(blocked);
    });

    it('reads no support when there is no plan to mark', async () => {
      const { service, anomaly } = await setup();
      await service.withPlacementBlocker('seed', []);
      expect(anomaly.readPlacementPrimaries).not.toHaveBeenCalled();
    });
  });

  it('runs no plan when the client of the seed is gone after support was read', async () => {
    const { service, registry } = await setup({ env: { STORAGE_TYPE: 'memory' } });
    await service.getStatus('seed');
    registry.get.mockImplementation(() => {
      throw new Error("Connection 'seed' not found");
    });
    await expect(service.allowsRun('seed')).resolves.toBe(false);
  });

  it('fails for an unknown connection', async () => {
    const { service } = await setup();
    await expect(service.getStatus('nope')).rejects.toThrow('nope');
  });
});
