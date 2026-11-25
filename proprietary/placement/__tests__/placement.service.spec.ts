import type { DatabaseConnectionConfig } from '@betterdb/shared';
import { MemoryAdapter } from '@app/storage/adapters/memory.adapter';
import type { ShardLoadSample } from '@app/cluster/shard-load';
import { PlacementService, PlacementModeError } from '../placement.service';
import type { PlacementPrimaryRead } from '../placement-support';
import type { ServedHotShardDetail } from '../../anomaly-detection/hot-shard-detector';
import type { RebalanceNoPlan, RebalancePlan } from '../../anomaly-detection/rebalance-planner';

const valkey9 = { dbType: 'valkey' as const, version: '9.0.0' };

function primaries(): PlacementPrimaryRead[] {
  return [
    { address: '10.0.0.1:7001', server: valkey9, migrateSlotsCommand: true },
    { address: '10.0.0.2:7002', server: valkey9, migrateSlotsCommand: true },
    { address: '10.0.0.3:7003', server: valkey9, migrateSlotsCommand: true },
  ];
}

const sample: ShardLoadSample = {
  timestamp: 7,
  settling: false,
  shards: ['a', 'b', 'c'].map((nodeId, index) => ({
    nodeId,
    address: `${nodeId}:7000`,
    slotCount: 5461,
    measuredSlots: 5461,
    cpuUsecPerSecond: index === 0 ? 900_000 : 300_000,
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
      getCapabilities: () => ({ clusterEnabled: options.clusterEnabled ?? true, hasClusterSlotStats: true }),
    })),
  };
  const anomaly = {
    readPlacementPrimaries: jest.fn(async () => (options.primaries === undefined ? primaries() : options.primaries)),
  };
  const env = { BETTERDB_SLOT_MIGRATION: 'true', STORAGE_TYPE: 'sqlite', ...options.env };
  const config = { get: jest.fn((key: string) => env[key as keyof typeof env]) };
  const prometheus = { collectsClusterSlotStats: jest.fn(() => true) };
  const shardLoad = { getLatest: jest.fn(() => sample) };
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
  return { service, storage, registry, anomaly, prometheus, shardLoad, clusterMetrics };
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
    await storage.savePlacementPolicy({ connectionId: 'seed', mode: 'recommend', updatedAt: 1 });
    const status = await service.getStatus('seed');
    expect(status.mode).toBe('recommend');
    expect(status.effectiveMode).toBe('recommend');
    expect(status.balance?.shards[0]).toMatchObject({ shardId: 'a', ratio: 3, overTrigger: true });
    expect(status.support.issues).toEqual([]);
  });

  it('answers for a member with its seed', async () => {
    const { service, storage, anomaly } = await setup({
      configs: {
        seed: { id: 'seed', host: '10.0.0.1', port: 7001 },
        member: { id: 'member', host: '10.0.0.2', port: 7002, membership: { seedId: 'seed', nodeId: 'n2', origin: 'auto', source: 'cluster' } },
      },
    });
    await storage.savePlacementPolicy({ connectionId: 'seed', mode: 'recommend', updatedAt: 1 });
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
    await storage.savePlacementPolicy({ connectionId: 'seed', mode: 'recommend', updatedAt: 1 });
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

  it('records a NOPERM refusal as acl', async () => {
    const { service } = await setup();
    service.noteRebalanceRefusal('seed', 'NOPERM User monitor has no permissions to run the cluster|migrateslots command');
    expect((await service.getStatus('seed')).support.modes.approve.blockedBy).toBe('acl');
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
    await storage.savePlacementPolicy({ connectionId: 'seed', mode: 'recommend', updatedAt: 1 });
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
    await storage.savePlacementPolicy({ connectionId: 'seed', mode: 'observe', updatedAt: 1 });
    expect(await service.allowsRun('seed')).toBe(false);
  });

  it('lets no plan run while the cluster runs as Observe', async () => {
    const { service, storage, prometheus } = await setup();
    await storage.savePlacementPolicy({ connectionId: 'seed', mode: 'recommend', updatedAt: 1 });
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

  describe('marking runnable plans in Observe', () => {
    const shard = (rebalance: ServedHotShardDetail['rebalance']) =>
      ({ eventId: 'evt', shardId: 'a', nodeAddr: 'a:7000', rebalance }) as ServedHotShardDetail;
    const plan = (execution: RebalancePlan['execution']) =>
      ({ kind: 'plan', sourceShardId: 'a', moves: [], execution }) as unknown as RebalancePlan;

    it('blocks a runnable plan with observe_mode', async () => {
      const { service } = await setup();
      const [marked] = await service.withPlacementBlocker('seed', [shard(plan({ available: true }))]);
      expect(marked.rebalance).toMatchObject({ execution: { available: false, blockedBy: 'observe_mode' } });
      expect(marked).toMatchObject({ eventId: 'evt', shardId: 'a', nodeAddr: 'a:7000' });
    });

    it('keeps an earlier blocker and verdicts without a plan', async () => {
      const { service } = await setup();
      const blocked = plan({ available: false, blockedBy: 'flag_off' });
      const none: RebalanceNoPlan = { kind: 'no_plan', action: 'spread', reason: 'key_level', pinnedSlots: [] };
      const marked = await service.withPlacementBlocker('seed', [shard(blocked), shard(none), shard(undefined)]);
      expect(marked.map((each: ServedHotShardDetail) => each.rebalance)).toEqual([blocked, none, undefined]);
    });

    it('leaves plans alone in Recommend', async () => {
      const { service, storage } = await setup();
      await storage.savePlacementPolicy({ connectionId: 'seed', mode: 'recommend', updatedAt: 1 });
      const shards = [shard(plan({ available: true }))];
      expect(await service.withPlacementBlocker('seed', shards)).toEqual(shards);
    });

    it('keeps the plan, not runnable, when the client of the seed is gone', async () => {
      const { service, registry } = await setup({ env: { STORAGE_TYPE: 'memory' } });
      registry.get.mockImplementation(() => {
        throw new Error("Connection 'seed' not found");
      });
      const [marked] = await service.withPlacementBlocker('seed', [shard(plan({ available: true }))]);
      expect(marked.rebalance).toMatchObject({ kind: 'plan', execution: { available: false } });
      expect((marked.rebalance as RebalancePlan).execution?.blockedBy).toBeUndefined();
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
