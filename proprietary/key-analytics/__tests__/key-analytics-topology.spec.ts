import {
  hasOwnKeyAnalytics,
  mergeKeySizeDistributions,
  type ConnectionStatus,
  type KeyAnalyticsResult,
  type KeyPatternData,
  type KeyPatternSnapshot,
  type TopologyMembership,
} from '@betterdb/shared';
import type { ConnectionRegistry } from '@app/connections/connection-registry.service';
import type { StoragePort } from '@app/common/interfaces/storage-port.interface';
import type { LicenseService } from '@proprietary/licenses';
import { KeyAnalyticsService } from '../key-analytics.service';
import { collectionPlan } from '../key-analytics-plan';
import { buildPatternSnapshots, mergePatternSnapshots } from '../key-pattern-snapshots';

function connection(id: string, over: Partial<ConnectionStatus> = {}): ConnectionStatus {
  return { id, name: id, host: 'h', port: 1, isConnected: true, connectionType: 'direct', ...over };
}

function member(over: Partial<TopologyMembership> = {}): TopologyMembership {
  return { seedId: 'seed', nodeId: 'n', origin: 'auto', source: 'cluster', ...over };
}

function pattern(name: string, over: Partial<KeyPatternData> = {}): KeyPatternData {
  return {
    pattern: name,
    count: 10,
    totalMemory: 1000,
    maxMemory: 200,
    totalCardinality: 0,
    maxCardinality: 0,
    totalIdleTime: 100,
    withTtl: 0,
    withoutTtl: 10,
    ttlValues: [],
    accessFrequencies: [],
    ...over,
  };
}

function snapshot(over: Partial<KeyPatternSnapshot>): KeyPatternSnapshot {
  return {
    id: 'id',
    timestamp: 1,
    pattern: 'user:*',
    keyCount: 0,
    sampledKeyCount: 0,
    keysWithTtl: 0,
    keysExpiringSoon: 0,
    totalMemoryBytes: 0,
    avgMemoryBytes: 0,
    maxMemoryBytes: 0,
    ...over,
  };
}

describe('hasOwnKeyAnalytics', () => {
  it.each([
    ['a standalone connection or seed', undefined, true],
    ['an auto cluster node', member(), false],
    ['an adopted cluster node', member({ origin: 'adopted' }), false],
    ['a sentinel primary', member({ source: 'sentinel', role: 'primary' }), true],
    ['an adopted sentinel primary', member({ source: 'sentinel', role: 'primary', origin: 'adopted' }), true],
    ['a sentinel replica', member({ source: 'sentinel', role: 'replica' }), false],
    ['a retired sentinel primary', member({ source: 'sentinel', role: 'primary', retiredAt: 5 }), false],
  ])('%s', (_case, membership, expected) => {
    expect(hasOwnKeyAnalytics(membership)).toBe(expected);
  });
});

describe('collectionPlan', () => {
  const seed = connection('seed');

  it('scans a connection without members on its own', () => {
    expect(collectionPlan(seed, [seed, connection('other')])).toEqual({ kind: 'single' });
  });

  it('skips cluster nodes and sentinel replicas', () => {
    const node = connection('node', { membership: member() });
    const replica = connection('replica', { membership: member({ source: 'sentinel', role: 'replica' }) });
    expect(collectionPlan(node, [seed, node])).toEqual({ kind: 'skip' });
    expect(collectionPlan(replica, [seed, replica])).toEqual({ kind: 'skip' });
  });

  it('scans a sentinel primary on its own', () => {
    const primary = connection('primary', { membership: member({ source: 'sentinel', role: 'primary' }) });
    expect(collectionPlan(primary, [seed, primary])).toEqual({ kind: 'single' });
  });

  it('scans a cluster seed together with its reachable, active cluster nodes', () => {
    const auto = connection('auto', { membership: member() });
    const adopted = connection('adopted', { membership: member({ origin: 'adopted' }) });
    const down = connection('down', { membership: member(), isConnected: false });
    const retired = connection('retired', { membership: member({ origin: 'adopted', retiredAt: 5 }) });
    const foreign = connection('foreign', { membership: member({ seedId: 'other' }) });
    const sentinelChild = connection('sentinel-child', { membership: member({ source: 'sentinel', role: 'primary' }) });
    const plan = collectionPlan(seed, [seed, auto, adopted, down, retired, foreign, sentinelChild]);
    expect(plan).toEqual({ kind: 'cluster', members: [auto, adopted] });
  });

  it('still treats the seed as a cluster when none of its nodes are reachable', () => {
    const down = connection('down', { membership: member(), isConnected: false });
    expect(collectionPlan(seed, [seed, down])).toEqual({ kind: 'cluster', members: [] });
  });
});

describe('mergePatternSnapshots', () => {
  it('returns a single node untouched', () => {
    const only = [snapshot({ keyCount: 5 })];
    expect(mergePatternSnapshots([only])).toBe(only);
  });

  it('scales each node by its own sampling ratio before adding patterns up', () => {
    const big: KeyAnalyticsResult = { dbSize: 1000, scanned: 10, patterns: [pattern('user:*')] };
    const small: KeyAnalyticsResult = { dbSize: 10, scanned: 10, patterns: [pattern('user:*'), pattern('job:*')] };
    const merged = mergePatternSnapshots([buildPatternSnapshots(big, 7), buildPatternSnapshots(small, 7)]);
    const users = merged.find((s) => s.pattern === 'user:*')!;
    expect(users).toMatchObject({ timestamp: 7, keyCount: 1010, sampledKeyCount: 20, totalMemoryBytes: 101000, avgMemoryBytes: 100 });
    expect(merged.find((s) => s.pattern === 'job:*')).toMatchObject({ keyCount: 10, sampledKeyCount: 10 });
  });

  it('weights per-key averages by how many keys each node holds', () => {
    const [merged] = mergePatternSnapshots([
      [snapshot({ keyCount: 900, avgMemoryBytes: 100, maxMemoryBytes: 150, avgAccessFrequency: 2, avgIdleTimeSeconds: 10, keysWithTtl: 0 })],
      [snapshot({ keyCount: 100, avgMemoryBytes: 1100, maxMemoryBytes: 5000, avgAccessFrequency: 12, avgIdleTimeSeconds: 110, keysWithTtl: 50, avgTtlSeconds: 60, minTtlSeconds: 5, maxTtlSeconds: 90 })],
    ]);
    expect(merged).toMatchObject({
      keyCount: 1000,
      avgMemoryBytes: 200,
      maxMemoryBytes: 5000,
      avgAccessFrequency: 3,
      avgIdleTimeSeconds: 20,
      keysWithTtl: 50,
      avgTtlSeconds: 60,
      minTtlSeconds: 5,
      maxTtlSeconds: 90,
    });
  });

  it('leaves figures no node measured undefined', () => {
    const [merged] = mergePatternSnapshots([[snapshot({ keyCount: 1 })], [snapshot({ keyCount: 1 })]]);
    expect(merged.avgAccessFrequency).toBeUndefined();
    expect(merged.hotKeyCount).toBeUndefined();
    expect(merged.avgTtlSeconds).toBeUndefined();
    expect(merged.minTtlSeconds).toBeUndefined();
  });
});

describe('mergeKeySizeDistributions', () => {
  it('adds matching buckets and keeps them in size order', () => {
    const merged = mergeKeySizeDistributions([
      { available: true, databases: { db0: { strings: { metric: 'sizes', buckets: [{ bucket: '2', count: 1 }, { bucket: '1K', count: 4 }] } } } },
      { available: false, databases: {} },
      {
        available: true,
        databases: {
          db0: {
            strings: { metric: 'sizes', buckets: [{ bucket: '16', count: 2 }, { bucket: '1K', count: 6 }, { bucket: '1M', count: 1 }] },
            hashes: { metric: 'items', buckets: [{ bucket: '4', count: 3 }] },
          },
        },
      },
    ]);
    expect(merged).toEqual({
      available: true,
      databases: {
        db0: {
          strings: {
            metric: 'sizes',
            buckets: [{ bucket: '2', count: 1 }, { bucket: '16', count: 2 }, { bucket: '1K', count: 10 }, { bucket: '1M', count: 1 }],
          },
          hashes: { metric: 'items', buckets: [{ bucket: '4', count: 3 }] },
        },
      },
    });
  });

  it('reports unavailable when no node exposes key sizes', () => {
    expect(mergeKeySizeDistributions([{ available: false, databases: {} }])).toEqual({ available: false, databases: {} });
  });
});

interface FakeClient {
  getRole: jest.Mock;
  collectKeyAnalytics: jest.Mock;
  call: jest.Mock;
  getCapabilities: () => { isSentinel?: boolean };
}

function fakeClient(role: 'master' | 'slave' | 'sentinel', result: KeyAnalyticsResult | Error, keySizes = ''): FakeClient {
  return {
    getRole: jest.fn().mockResolvedValue({ role }),
    collectKeyAnalytics: result instanceof Error ? jest.fn().mockRejectedValue(result) : jest.fn().mockResolvedValue(result),
    call: jest.fn().mockResolvedValue(keySizes),
    getCapabilities: () => ({ isSentinel: role === 'sentinel' }),
  };
}

function build(connections: ConnectionStatus[], clients: Record<string, FakeClient>) {
  const storage = {
    saveKeyPatternSnapshots: jest.fn().mockResolvedValue(undefined),
    saveHotKeys: jest.fn().mockResolvedValue(undefined),
    getKeyAnalyticsSummary: jest.fn().mockResolvedValue({ totalKeys: 1 }),
    getKeyPatternSnapshots: jest.fn().mockResolvedValue([snapshot({})]),
    getKeyPatternTrends: jest.fn().mockResolvedValue([{ timestamp: 1, keyCount: 1, memoryBytes: 1, staleCount: 0 }]),
    getHotKeys: jest.fn().mockResolvedValue([{ id: 'x', keyName: 'k', connectionId: 'c', capturedAt: 1, signalType: 'cardinality', rank: 1 }]),
  };
  const registry = {
    list: jest.fn((options: { includeRetired?: boolean } = {}) =>
      connections.filter((c) => options.includeRetired || !(c.membership?.origin === 'auto' && c.membership.retiredAt !== undefined)),
    ),
    get: jest.fn((id: string) => {
      const client = clients[id];
      if (!client) {
        throw new Error(`Connection '${id}' not found`);
      }
      return client;
    }),
  };
  const license = { hasFeature: () => true, getLicenseTier: () => 'pro' } as unknown as LicenseService;
  const service = new KeyAnalyticsService(registry as unknown as ConnectionRegistry, storage as unknown as StoragePort, license);
  const poll = (id: string) =>
    (service as unknown as { pollConnection(ctx: unknown): Promise<void> }).pollConnection({
      connectionId: id,
      connectionName: id,
      client: clients[id],
      host: 'h',
      port: 1,
    });
  return { service, storage, poll };
}

const scanOf = (dbSize: number, name = 'user:*'): KeyAnalyticsResult => ({
  dbSize,
  scanned: 10,
  patterns: [pattern(name)],
  keyDetails: [{ keyName: `${name}:${dbSize}`, keyType: 'hash', cardinality: dbSize, freqScore: 5, idleSeconds: null, memoryBytes: 10, ttl: null }],
});

describe('KeyAnalyticsService with topology members', () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  afterAll(() => warn.mockRestore());

  function cluster() {
    const connections = [
      connection('seed'),
      connection('primary-2', { membership: member({ nodeId: 'p2' }) }),
      connection('adopted-3', { membership: member({ nodeId: 'p3', origin: 'adopted' }) }),
      connection('replica-1', { membership: member({ nodeId: 'r1' }) }),
      connection('standalone'),
    ];
    const clients = {
      seed: fakeClient('master', scanOf(100), 'db0_distrib_strings_sizes:2=1,1K=4'),
      'primary-2': fakeClient('master', scanOf(300), 'db0_distrib_strings_sizes:1K=6'),
      'adopted-3': fakeClient('master', scanOf(600, 'job:*'), ''),
      'replica-1': fakeClient('slave', scanOf(100), 'db0_distrib_strings_sizes:1K=100'),
      standalone: fakeClient('master', scanOf(50)),
    };
    return { connections, clients, ...build(connections, clients) };
  }

  it('never scans a cluster node on its own', async () => {
    const { poll, clients, storage } = cluster();
    await poll('primary-2');
    await poll('adopted-3');
    await poll('replica-1');
    expect(clients['primary-2'].collectKeyAnalytics).not.toHaveBeenCalled();
    expect(clients['adopted-3'].collectKeyAnalytics).not.toHaveBeenCalled();
    expect(clients['replica-1'].collectKeyAnalytics).not.toHaveBeenCalled();
    expect(storage.saveKeyPatternSnapshots).not.toHaveBeenCalled();
  });

  it('scans every primary of the cluster once and stores one merged result under the seed', async () => {
    const { poll, clients, storage } = cluster();
    await poll('seed');
    expect(clients.seed.collectKeyAnalytics).toHaveBeenCalledTimes(1);
    expect(clients['primary-2'].collectKeyAnalytics).toHaveBeenCalledTimes(1);
    expect(clients['adopted-3'].collectKeyAnalytics).toHaveBeenCalledTimes(1);
    expect(clients['replica-1'].collectKeyAnalytics).not.toHaveBeenCalled();
    expect(clients.standalone.collectKeyAnalytics).not.toHaveBeenCalled();

    expect(storage.saveKeyPatternSnapshots).toHaveBeenCalledTimes(1);
    const [snapshots, connectionId] = storage.saveKeyPatternSnapshots.mock.calls[0] as [KeyPatternSnapshot[], string];
    expect(connectionId).toBe('seed');
    expect(snapshots.map((s) => [s.pattern, s.keyCount]).sort()).toEqual([['job:*', 600], ['user:*', 400]]);

    const [hotKeys, hotKeysConnectionId] = storage.saveHotKeys.mock.calls[0] as [Array<{ keyName: string; signalType: string; connectionId: string }>, string];
    expect(hotKeysConnectionId).toBe('seed');
    expect(hotKeys.every((row) => row.connectionId === 'seed')).toBe(true);
    expect(hotKeys.filter((row) => row.signalType === 'cardinality').map((row) => row.keyName)).toEqual(['job:*:600', 'user:*:300', 'user:*:100']);
  });

  it('leaves the seed out of the merge when the seed node is a replica', async () => {
    const { poll, clients, storage } = cluster();
    clients.seed.getRole.mockResolvedValue({ role: 'slave' });
    await poll('seed');
    expect(clients.seed.collectKeyAnalytics).not.toHaveBeenCalled();
    const [snapshots] = storage.saveKeyPatternSnapshots.mock.calls[0] as [KeyPatternSnapshot[]];
    expect(snapshots.map((s) => [s.pattern, s.keyCount]).sort()).toEqual([['job:*', 600], ['user:*', 300]]);
  });

  it('stores what the reachable primaries returned when one scan fails', async () => {
    const { poll, clients, storage } = cluster();
    clients['primary-2'].collectKeyAnalytics.mockRejectedValue(new Error('LOADING'));
    await poll('seed');
    const [snapshots] = storage.saveKeyPatternSnapshots.mock.calls[0] as [KeyPatternSnapshot[]];
    expect(snapshots.map((s) => [s.pattern, s.keyCount]).sort()).toEqual([['job:*', 600], ['user:*', 100]]);
  });

  it('fails the collection when every primary scan fails', async () => {
    const { poll, clients, storage } = cluster();
    for (const id of ['seed', 'primary-2', 'adopted-3'] as const) {
      clients[id].collectKeyAnalytics.mockRejectedValue(new Error('LOADING'));
    }
    await expect(poll('seed')).rejects.toThrow('LOADING');
    expect(storage.saveKeyPatternSnapshots).not.toHaveBeenCalled();
  });

  it('fails instead of reporting an empty keyspace when no primary can be found', async () => {
    const { poll, clients, storage } = cluster();
    for (const client of Object.values(clients)) {
      client.getRole.mockRejectedValue(new Error('NOPERM'));
    }
    await expect(poll('seed')).rejects.toThrow('No reachable primary found for seed');
    expect(storage.saveKeyPatternSnapshots).not.toHaveBeenCalled();
  });

  it('does not store a replica seed as the whole cluster while its nodes are down', async () => {
    const connections = [connection('seed'), connection('primary-2', { membership: member(), isConnected: false })];
    const clients = { seed: fakeClient('slave', scanOf(100)), 'primary-2': fakeClient('master', scanOf(300)) };
    const { poll, storage } = build(connections, clients);
    await expect(poll('seed')).rejects.toThrow('No reachable primary');
    expect(clients.seed.collectKeyAnalytics).not.toHaveBeenCalled();
    expect(storage.saveKeyPatternSnapshots).not.toHaveBeenCalled();
  });

  it('scans a standalone connection exactly as before', async () => {
    const { poll, clients, storage } = cluster();
    await poll('standalone');
    expect(clients.standalone.getRole).not.toHaveBeenCalled();
    expect(clients.standalone.collectKeyAnalytics).toHaveBeenCalledWith({ sampleSize: 10000, scanBatchSize: 1000, fullScan: false });
    const [snapshots, connectionId] = storage.saveKeyPatternSnapshots.mock.calls[0] as [KeyPatternSnapshot[], string];
    expect(connectionId).toBe('standalone');
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ pattern: 'user:*', keyCount: 50 });
  });

  it('scans a sentinel primary but not its replicas or a retired node', async () => {
    const connections = [
      connection('sentinel'),
      connection('primary', { membership: member({ seedId: 'sentinel', source: 'sentinel', role: 'primary' }) }),
      connection('replica', { membership: member({ seedId: 'sentinel', source: 'sentinel', role: 'replica' }) }),
      connection('retired', { membership: member({ seedId: 'sentinel', source: 'sentinel', role: 'primary', origin: 'adopted', retiredAt: 5 }) }),
    ];
    const clients = {
      sentinel: fakeClient('sentinel', new Error('ERR unknown command')),
      primary: fakeClient('master', scanOf(40)),
      replica: fakeClient('slave', scanOf(40)),
      retired: fakeClient('master', scanOf(40)),
    };
    const { poll, storage, service } = build(connections, clients);
    await poll('primary');
    await poll('replica');
    await poll('retired');
    expect(clients.primary.collectKeyAnalytics).toHaveBeenCalledTimes(1);
    expect(clients.replica.collectKeyAnalytics).not.toHaveBeenCalled();
    expect(clients.retired.collectKeyAnalytics).not.toHaveBeenCalled();
    expect(storage.saveKeyPatternSnapshots).toHaveBeenCalledTimes(1);
    expect(storage.saveKeyPatternSnapshots.mock.calls[0][1]).toBe('primary');

    await service.triggerCollection();
    expect(clients.sentinel.collectKeyAnalytics).not.toHaveBeenCalled();
    expect(clients.primary.collectKeyAnalytics).toHaveBeenCalledTimes(2);
    expect(clients.replica.collectKeyAnalytics).not.toHaveBeenCalled();
  });

  it('triggers a manual collection once per seed and standalone connection', async () => {
    const { service, clients, storage } = cluster();
    await service.triggerCollection(true);
    expect(storage.saveKeyPatternSnapshots.mock.calls.map((call) => call[1]).sort()).toEqual(['seed', 'standalone']);
    expect(clients['primary-2'].collectKeyAnalytics).toHaveBeenCalledTimes(1);
    expect(clients['primary-2'].collectKeyAnalytics).toHaveBeenCalledWith(expect.objectContaining({ fullScan: true }));
    expect(clients['replica-1'].collectKeyAnalytics).not.toHaveBeenCalled();
  });

  it('returns nothing for a member that has no key analytics of its own', async () => {
    const { service, storage } = cluster();
    expect(await service.getSummary(undefined, undefined, 'primary-2')).toBeNull();
    expect(await service.getPatternSnapshots({ connectionId: 'primary-2' })).toEqual([]);
    expect(await service.getPatternTrends('user:*', 0, 1, 'primary-2')).toEqual([]);
    expect(await service.getHotKeys({ connectionId: 'primary-2' })).toEqual([]);
    expect(await service.getLargestKeys({ connectionId: 'primary-2' })).toEqual([]);
    expect(await service.getCompositeKeys({ connectionId: 'primary-2' })).toEqual([]);
    expect(await service.getKeySizes('primary-2')).toEqual({ databases: {}, available: false });
    expect(storage.getHotKeys).not.toHaveBeenCalled();
    expect(storage.getKeyAnalyticsSummary).not.toHaveBeenCalled();
  });

  it('keeps serving stored analytics for seeds, standalone and unknown connections', async () => {
    const { service } = cluster();
    expect(await service.getSummary(undefined, undefined, 'seed')).toEqual({ totalKeys: 1 });
    expect(await service.getHotKeys({ connectionId: 'standalone' })).toHaveLength(1);
    expect(await service.getPatternSnapshots({ connectionId: 'deleted-long-ago' })).toHaveLength(1);
    expect(await service.getPatternSnapshots()).toHaveLength(1);
  });

  it('adds up key sizes across the primaries of a cluster seed', async () => {
    const { service, clients } = cluster();
    expect(await service.getKeySizes('seed')).toEqual({
      available: true,
      databases: { db0: { strings: { metric: 'sizes', buckets: [{ bucket: '2', count: 1 }, { bucket: '1K', count: 10 }] } } },
    });
    expect(clients['replica-1'].call).not.toHaveBeenCalled();
  });

  it('reads key sizes from the connection itself when it has no cluster nodes', async () => {
    const { service, clients } = cluster();
    clients.standalone.call.mockResolvedValue('db0_distrib_strings_sizes:4=9');
    expect(await service.getKeySizes('standalone')).toEqual({
      available: true,
      databases: { db0: { strings: { metric: 'sizes', buckets: [{ bucket: '4', count: 9 }] } } },
    });
  });

  it('defaults key sizes to a connection that has its own key analytics', async () => {
    const connections = [connection('node', { membership: member() }), connection('plain')];
    const clients = { node: fakeClient('master', scanOf(1), 'db0_distrib_strings_sizes:1=1'), plain: fakeClient('master', scanOf(1), 'db0_distrib_strings_sizes:8=2') };
    const { service } = build(connections, clients);
    expect((await service.getKeySizes()).databases.db0.strings.buckets).toEqual([{ bucket: '8', count: 2 }]);
  });
});
