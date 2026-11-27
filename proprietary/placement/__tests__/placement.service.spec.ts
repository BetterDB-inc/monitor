import { Logger } from '@nestjs/common';
import {
  DEFAULT_PLACEMENT_SETTINGS,
  type DatabaseConnectionConfig,
  type PlacementPolicy,
} from '@betterdb/shared';
import { MemoryAdapter } from '@app/storage/adapters/memory.adapter';
import type { ShardLoadSample } from '@app/cluster/shard-load';
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
    placementPlanOf: jest.fn((): RebalancePlan | null => null),
    placementJobsSince: jest.fn(() => 0),
    placementOpenEvents: jest.fn(async (): Promise<PlacementGateSignal[]> => []),
    placementIncidents: jest.fn(async () => []),
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

  it('reads the sustained trigger of each shard from the samples it was handed', async () => {
    const { service, feed } = await setup();
    const now = Date.now();
    await service.settingsOf('seed', { fresh: true });
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
    await service.settingsOf('seed', { fresh: true });
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
    await service.settingsOf('seed', { fresh: true });
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
    await service.settingsOf('seed', { fresh: true });
    feed('seed', start, end);
    expect(service.triggerOf('seed', 'a', end)?.state).toBe('over');

    for (const listener of listeners) listener.reset('seed');
    expect(service.triggerOf('seed', 'a', end)).toMatchObject({
      state: 'short_history',
      coveredMs: 0,
    });

    feed('seed', start, end);
    await service.setSettings('seed', { ...DEFAULT_PLACEMENT_SETTINGS, resolveRatio: 1.5 }, 0);
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
    const slow = service.settingsOf('seed', { fresh: true });
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
      await service.setSettings('seed', tighter, 0);
      expect((await storage.getPlacementPolicy('seed'))?.settings.excludedShardIds).toEqual(['c']);
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
        { ...tighter, nodeCpuLimitUsecPerSecond: 600_000, resolveRatio: 1.5 },
        0,
      );

      expect(await resolve('seed')).toEqual({
        ...DEFAULT_REBALANCE_POLICY,
        nodeCpuLimitUsecPerSecond: 600_000,
        resolveRatio: 1.5,
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
      const slow = service.settingsOf('seed', { fresh: true });
      await service.setSettings('seed', tighter, 0);
      finish(before);
      expect((await slow).version).toBe(0);
      expect((await resolve('seed')).excludedSlots).toEqual([7]);
    });

    it('reads the settings with their version, and fresh past the half-minute cache', async () => {
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
      expect(await service.settingsOf('seed', { fresh: true })).toEqual({
        settings: tighter,
        version: 1,
        invalid: null,
      });
      expect((await service.settingsOf('seed')).version).toBe(1);
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

    describe('the gate', () => {
      const cached = { kind: 'plan', sourceShardId: 'a', moves } as unknown as RebalancePlan;
      const failover = { metricType: 'failover_churn', nodeId: 'b', openedAt: Date.now() };

      it('blocks the run while an event is open on a target node, and runs it once it closes', async () => {
        const { service, storage, anomaly } = await setup();
        await storage.savePlacementMode({ connectionId: 'seed', mode: 'recommend', updatedAt: 1 });
        anomaly.placementPlanOf.mockReturnValue(cached);
        anomaly.placementOpenEvents.mockResolvedValue([failover]);
        await expect(service.runRebalance('seed', 'a', moves, actor)).resolves.toEqual({
          status: 'blocked',
          blockedBy: 'gate',
          blockers: [expect.objectContaining({ kind: 'failover', scope: 'target', nodeId: 'b' })],
        });
        expect(anomaly.placementPlanOf).toHaveBeenCalledWith('seed', 'a');
        expect(anomaly.runRebalance).not.toHaveBeenCalled();

        anomaly.placementOpenEvents.mockResolvedValue([]);
        anomaly.runRebalance.mockResolvedValue({ status: 'started', run: {} });
        await expect(service.runRebalance('seed', 'a', moves, actor)).resolves.toMatchObject({
          status: 'started',
        });
        expect(anomaly.runRebalance).toHaveBeenCalledWith('seed', 'a', moves, actor);
      });

      it('counts the slot jobs of the last hour against the budget', async () => {
        const { service, storage, anomaly } = await setup();
        await storage.savePlacementMode({ connectionId: 'seed', mode: 'recommend', updatedAt: 1 });
        anomaly.placementPlanOf.mockReturnValue(cached);
        anomaly.placementJobsSince.mockReturnValue(4);
        const result = await service.runRebalance('seed', 'a', moves, actor);
        expect(result).toMatchObject({ status: 'blocked', blockedBy: 'gate' });
        expect(anomaly.placementJobsSince).toHaveBeenCalledWith('seed', expect.any(Number));
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
