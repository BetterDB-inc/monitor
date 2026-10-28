import { BadRequestException, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Feature } from '@betterdb/shared';
import * as classifier from '../key-classifier';
import * as scanner from '../footprint-scanner';
import {
  KvCacheFootprintService,
  MAX_FOOTPRINT_INTERVAL_MS,
  PARTIAL_MISSES_BEFORE_CLEAR,
  REFRESH_REUSE_MS,
  resolvePositiveInt,
} from '../kv-cache-footprint.service';

const KEY = (i: number) => `m/x@1@0@${(i + 1).toString(16)}@bfloat16`;

const REPLIES: Record<string, unknown> = { MEMORY: 100, TTL: -1, EXISTS: 0, CLIENT: 'id=1 lib-name=redis-py\n' };

function fakeClient(keys: string[]) {
  return {
    getDbSize: jest.fn().mockResolvedValue(keys.length),
    call: jest.fn(async (cmd: string) => (cmd === 'SCAN' ? ['0', keys] : REPLIES[cmd])),
    getClient: () => {
      throw new Error('Raw client access not available through agent connections');
    },
    getInfoParsed: jest.fn().mockResolvedValue({
      memory: { used_memory: '1000', maxmemory: '0', maxmemory_policy: 'noeviction' },
      stats: { evicted_keys: '3' },
      keyspace: { db0: { keys: keys.length, expires: 0, avg_ttl: 0 } },
    }),
    getRole: jest.fn().mockResolvedValue({ role: 'master' }),
  } as any;
}

function setup(keys = Array.from({ length: 6 }, (_, i) => KEY(i)), licensed = true) {
  const client = fakeClient(keys);
  const removalListeners: Array<(id: string) => void> = [];
  const registry = {
    list: jest.fn().mockReturnValue([{ id: 'c1', name: 'one', isConnected: true, connectionType: 'direct' }]),
    get: jest.fn().mockReturnValue(client),
    getConfig: jest.fn().mockReturnValue({ id: 'c1', name: 'one', host: 'h', port: 6379, dbIndex: 0 }),
    addConnectionRemovalListener: jest.fn((listener: (id: string) => void) => {
      removalListeners.push(listener);
      return () => undefined;
    }),
    removed: (id: string) => removalListeners.forEach((listener) => listener(id)),
  } as any;
  const storage = {
    saveKvCacheFootprintSnapshot: jest.fn(),
    getKvCacheFootprintSnapshots: jest.fn().mockResolvedValue([]),
    deleteKvCacheConnectionData: jest.fn().mockResolvedValue(undefined),
  } as any;
  const license = {
    hasFeature: jest.fn((f: string) => licensed && f === Feature.KV_CACHE_MONITORING),
    ensureValidated: jest.fn().mockResolvedValue({}),
  } as any;
  const service = new KvCacheFootprintService(registry, storage, license);
  return { service, storage, client, registry, license };
}

describe('KvCacheFootprintService', () => {
  it('collects, stores and announces a snapshot', async () => {
    const { service, storage } = setup();
    const listener = jest.fn();
    service.onSnapshot(listener);
    const snapshot = await service.triggerCollection('c1');
    expect(snapshot).toMatchObject({ connectionId: 'c1', detected: true, matchedKeys: 6, chunksEst: 6, evictedKeysDelta: null, evictedKeysIntervalMs: null });
    expect(storage.saveKvCacheFootprintSnapshot).toHaveBeenCalledWith(snapshot);
    expect(listener).toHaveBeenCalledWith(snapshot, { partial: false });
    expect(service.getSampleKey('c1')).toBe('m/x@1@0@1…@bfloat16');
  });

  it('reports the eviction delta on the second run', async () => {
    const { service } = setup();
    await service.triggerCollection('c1');
    expect((await service.triggerCollection('c1'))?.evictedKeysDelta).toBe(0);
  });

  it('returns the in-flight collection to a manual trigger', async () => {
    const { service, client, storage } = setup();
    let finishRead: (size: number) => void = () => undefined;
    client.getDbSize.mockImplementationOnce(() => new Promise((resolve) => (finishRead = resolve)));
    const first = service.triggerCollection('c1');
    await new Promise((resolve) => setImmediate(resolve));
    const second = service.triggerCollection('c1');
    finishRead(6);
    const [a, b] = await Promise.all([first, second]);
    expect(b).not.toBeNull();
    expect(b).toBe(a);
    expect(storage.saveKvCacheFootprintSnapshot).toHaveBeenCalledTimes(1);
  });

  it('returns the in-flight collection to a trigger that starts in the same tick', async () => {
    const { service, storage } = setup();
    const first = service.triggerCollection('c1');
    const second = service.triggerCollection('c1');
    const [a, b] = await Promise.all([first, second]);
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(storage.saveKvCacheFootprintSnapshot).toHaveBeenCalledTimes(1);
  });

  it('returns the in-flight collection to a poll that overlaps a manual trigger', async () => {
    const { service, client } = setup();
    const ctx = { connectionId: 'c1', connectionName: 'one', client, host: 'h', port: 6379 };
    const manual = service.triggerCollection('c1');
    const polled = service.collect(ctx);
    const [a, b] = await Promise.all([manual, polled]);
    expect(a).not.toBeNull();
    expect(b).toBe(a);
  });

  it('classifies each scanned key once per collection', async () => {
    const { service } = setup();
    const classify = jest.spyOn(classifier, 'classifyKey');
    try {
      await service.triggerCollection('c1');
      expect(classify).toHaveBeenCalledTimes(6);
    } finally {
      classify.mockRestore();
    }
  });

  it('rejects a manual trigger for a cluster member, which its seed collects', async () => {
    const { service, client, registry } = setup();
    registry.list.mockReturnValue([
      { id: 'seed', name: 'seed', isConnected: true, connectionType: 'direct' },
      {
        id: 'c1',
        name: 'one',
        isConnected: true,
        connectionType: 'direct',
        membership: { seedId: 'seed', nodeId: 'n', origin: 'auto', source: 'cluster' },
      },
    ]);
    await expect(service.triggerCollection('c1')).rejects.toThrow(/seed/);
    await expect(service.triggerCollection('c1')).rejects.toBeInstanceOf(BadRequestException);
    expect(client.getDbSize).not.toHaveBeenCalled();
  });

  it('rejects a manual trigger for an external connection', async () => {
    const { service, client, registry } = setup();
    registry.list.mockReturnValue([{ id: 'c1', name: 'one', isConnected: true, connectionType: 'external' }]);
    registry.getConfig.mockReturnValue({ id: 'c1', name: 'one', host: 'h', port: 6379, connectionType: 'external' });
    registry.get.mockImplementation(() => {
      throw new Error('external connections have no client');
    });
    await expect(service.triggerCollection('c1')).rejects.toBeInstanceOf(BadRequestException);
    expect(client.getDbSize).not.toHaveBeenCalled();
  });

  it('rejects a manual trigger for a sentinel connection', async () => {
    const { service, client } = setup();
    client.getCapabilities = () => ({ isSentinel: true });
    await expect(service.triggerCollection('c1')).rejects.toBeInstanceOf(BadRequestException);
    expect(client.getDbSize).not.toHaveBeenCalled();
  });

  it('reports the time since the run the eviction delta is measured from', async () => {
    const { service } = setup();
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      await service.triggerCollection('c1');
      now.mockReturnValue(1_000_000 + 4_000);
      expect(await service.triggerCollection('c1')).toMatchObject({ evictedKeysDelta: 0, evictedKeysIntervalMs: 4_000 });
    } finally {
      now.mockRestore();
    }
  });

  it('keeps the eviction baseline when the connection is renamed', async () => {
    const { service, registry } = setup();
    await service.triggerCollection('c1');
    registry.getConfig.mockReturnValue({ id: 'c1', name: 'renamed', host: 'h', port: 6379, dbIndex: 0 });
    expect((await service.triggerCollection('c1'))?.evictedKeysDelta).toBe(0);
  });

  it('keeps the eviction baseline of a cluster member when it is renamed', async () => {
    const { service, client, registry } = setup();
    const member = fakeClient([]);
    client.getClusterNodes = jest.fn().mockResolvedValue([
      { id: 'n0', flags: ['myself', 'master'], slots: [[0, 8191]] },
      { id: 'n1', flags: ['master'], slots: [[8192, 16383]] },
    ]);
    registry.get.mockImplementation((id: string) => (id === 'm1' ? member : client));
    const listing = (name: string) => [
      { id: 'c1', name: 'one', isConnected: true, connectionType: 'direct' },
      { id: 'm1', name, isConnected: true, connectionType: 'direct', membership: { seedId: 'c1', nodeId: 'n1', origin: 'auto', source: 'cluster' } },
    ];
    const evicted = (count: number) =>
      member.getInfoParsed.mockResolvedValue({
        memory: { used_memory: '1000', maxmemory: '0', maxmemory_policy: 'noeviction' },
        stats: { evicted_keys: String(count) },
        keyspace: {},
      });
    registry.list.mockReturnValue(listing('m1'));
    evicted(10);
    await service.triggerCollection('c1');
    registry.list.mockReturnValue(listing('renamed'));
    evicted(15);
    expect((await service.triggerCollection('c1'))?.evictedKeysDelta).toBe(5);
  });

  describe('memory limits across primaries', () => {
    const withMemory = (target: any, maxmemory: string, policy: string) =>
      target.getInfoParsed.mockResolvedValue({
        memory: { used_memory: '1000', maxmemory, maxmemory_policy: policy },
        stats: { evicted_keys: '0' },
        keyspace: {},
      });

    function twoNodes(a: [string, string], b: [string, string]) {
      const ctx = setup();
      const other = fakeClient([]);
      withMemory(ctx.client, ...a);
      withMemory(other, ...b);
      jest.spyOn(ctx.service as any, 'nodesFor').mockResolvedValue({
        nodes: [{ name: 'a', client: ctx.client }, { name: 'b', client: other }],
        skipped: 0,
      });
      return ctx.service;
    }

    it('sums the limits when every primary has one', async () => {
      const service = twoNodes(['1000', 'allkeys-lru'], ['2000', 'allkeys-lru']);
      expect(await service.triggerCollection('c1')).toMatchObject({ maxmemory: 3000, maxmemoryPolicy: 'allkeys-lru' });
    });

    it('reports no limit when any primary is unlimited', async () => {
      const service = twoNodes(['1000', 'allkeys-lru'], ['0', 'allkeys-lru']);
      expect(await service.triggerCollection('c1')).toMatchObject({ maxmemory: 0 });
    });

    it('reports a mixed policy when primaries disagree', async () => {
      const service = twoNodes(['1000', 'allkeys-lru'], ['1000', 'volatile-lru']);
      expect(await service.triggerCollection('c1')).toMatchObject({ maxmemoryPolicy: 'mixed' });
    });
  });

  it('counts a tagged pair split across primaries as two-key evidence', async () => {
    const pair = 'm/x@1@0@3@bfloat16@kind%prefill';
    const single = 'm/x@1@0@4@bfloat16@kind%decode';
    const { service } = setup();
    jest.spyOn(service as any, 'nodesFor').mockResolvedValue({
      nodes: [
        { name: 'a', client: fakeClient([`${pair}metadata`, single]) },
        { name: 'b', client: fakeClient([`${pair}kv_bytes`]) },
      ],
      skipped: 0,
    });
    expect(await service.triggerCollection('c1')).toMatchObject({ matchedKeys: 3, chunksEst: 2 });
  });

  it('counts single keys on another primary as single-key evidence', async () => {
    const { service } = setup();
    jest.spyOn(service as any, 'nodesFor').mockResolvedValue({
      nodes: [
        { name: 'a', client: fakeClient(['m/x@1@0@1@bfloat16', 'm/x@1@0@2@bfloat16']) },
        { name: 'b', client: fakeClient(['m/x@1@0@3@bfloat16@kind%metadata', 'm/x@1@0@4@bfloat16@kind%metadata']) },
      ],
      skipped: 0,
    });
    expect(await service.triggerCollection('c1')).toMatchObject({ matchedKeys: 4, chunksEst: 4 });
  });

  it('reads a tag ending in a suffix name as a tag when no node shows two-key evidence', async () => {
    const { service } = setup(['m/x@1@0@1@bfloat16@kind%metadata', 'm/x@1@0@2@bfloat16@kind%decode']);
    expect(await service.triggerCollection('c1')).toMatchObject({ matchedKeys: 2, chunksEst: 2 });
  });

  it('drops the eviction baseline of a node that misses a run', async () => {
    const { service, client } = setup();
    const other = fakeClient([]);
    const evicted = (target: any, count: number) =>
      target.getInfoParsed.mockResolvedValue({
        memory: { used_memory: '1000', maxmemory: '0', maxmemory_policy: 'noeviction' },
        stats: { evicted_keys: String(count) },
        keyspace: {},
      });
    const nodes = jest.spyOn(service as any, 'nodesFor');
    const both = { nodes: [{ name: 'a', client }, { name: 'b', client: other }], skipped: 0 };
    nodes.mockResolvedValue(both);
    evicted(client, 10);
    evicted(other, 100);
    await service.triggerCollection('c1');
    nodes.mockResolvedValue({ nodes: [{ name: 'a', client }], skipped: 1 });
    evicted(client, 12);
    expect((await service.triggerCollection('c1'))?.evictedKeysDelta).toBe(2);
    nodes.mockResolvedValue(both);
    evicted(client, 13);
    evicted(other, 5000);
    expect((await service.triggerCollection('c1'))?.evictedKeysDelta).toBe(1);
  });

  it('keeps the readable nodes and marks the scan incomplete when one node fails', async () => {
    const { service, client } = setup();
    const broken = fakeClient([]);
    broken.getDbSize.mockRejectedValue(new Error('LOADING'));
    jest.spyOn(service as any, 'nodesFor').mockResolvedValue({
      nodes: [
        { name: 'a', client },
        { name: 'b', client: broken },
      ],
      skipped: 0,
    });
    const snapshot = await service.triggerCollection('c1');
    expect(snapshot).toMatchObject({ matchedKeys: 6, scanComplete: false });
  });

  it('tells snapshot listeners whether every node was read', async () => {
    const { service, client } = setup();
    const listener = jest.fn();
    service.onSnapshot(listener);
    const broken = fakeClient([]);
    broken.getDbSize.mockRejectedValue(new Error('LOADING'));
    const nodes = jest.spyOn(service as any, 'nodesFor').mockResolvedValue({
      nodes: [
        { name: 'a', client },
        { name: 'b', client: broken },
      ],
      skipped: 0,
    });
    await service.triggerCollection('c1');
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ connectionId: 'c1' }), { partial: true });
    nodes.mockResolvedValue({ nodes: [{ name: 'a', client }], skipped: 0 });
    await service.triggerCollection('c1');
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ connectionId: 'c1' }), { partial: false });
  });

  it('clears an earlier detection after consecutive partial runs that find no LMCache', async () => {
    const { service, storage } = setup();
    await service.triggerCollection('c1');
    storage.getKvCacheFootprintSnapshots.mockImplementation(async () => [
      { ...storage.saveKvCacheFootprintSnapshot.mock.calls.at(-1)[0], timestamp: 0 },
    ]);
    jest.spyOn(service as any, 'nodesFor').mockResolvedValue({ nodes: [{ name: 'a', client: fakeClient([]) }], skipped: 1 });
    const runs = [];
    for (let i = 0; i < PARTIAL_MISSES_BEFORE_CLEAR; i += 1) runs.push(await service.triggerCollection('c1'));
    expect(runs.slice(0, -1).every((run) => run?.detected === true)).toBe(true);
    expect(runs.at(-1)).toMatchObject({ detected: false, scanComplete: false });
    expect(service.getSampleKey('c1')).toBeNull();
    expect(await service.triggerCollection('c1')).toMatchObject({ detected: false });
  });

  it('restarts the partial miss count when a run finds LMCache again', async () => {
    const { service, storage } = setup();
    await service.triggerCollection('c1');
    storage.getKvCacheFootprintSnapshots.mockResolvedValue([{ connectionId: 'c1', detected: true }]);
    const nodes = jest.spyOn(service as any, 'nodesFor');
    const empty = { nodes: [{ name: 'a', client: fakeClient([]) }], skipped: 1 };
    nodes.mockResolvedValue(empty);
    for (let i = 0; i < PARTIAL_MISSES_BEFORE_CLEAR - 1; i += 1) await service.triggerCollection('c1');
    nodes.mockRestore();
    await service.triggerCollection('c1');
    jest.spyOn(service as any, 'nodesFor').mockResolvedValue(empty);
    expect(await service.triggerCollection('c1')).toMatchObject({ detected: true });
  });

  it('stores not detected for a partial read when LMCache was not detected before', async () => {
    const { service } = setup();
    const broken = fakeClient([]);
    broken.getDbSize.mockRejectedValue(new Error('LOADING'));
    jest.spyOn(service as any, 'nodesFor').mockResolvedValue({
      nodes: [
        { name: 'a', client: fakeClient([KEY(0)]) },
        { name: 'b', client: broken },
      ],
      skipped: 0,
    });
    expect(await service.triggerCollection('c1')).toMatchObject({ detected: false, scanComplete: false });
  });

  it('marks the snapshot partial when a node drops its connection while sampling', async () => {
    const { service, client } = setup();
    const listener = jest.fn();
    service.onSnapshot(listener);
    const dropped = fakeClient(Array.from({ length: 6 }, (_, i) => KEY(i + 10)));
    dropped.call.mockImplementation(async (cmd: string) => {
      if (cmd === 'SCAN') return ['0', Array.from({ length: 6 }, (_, i) => KEY(i + 10))];
      throw new Error('Connection is closed.');
    });
    jest.spyOn(service as any, 'nodesFor').mockResolvedValue({
      nodes: [
        { name: 'a', client },
        { name: 'b', client: dropped },
      ],
      skipped: 0,
    });
    const snapshot = await service.triggerCollection('c1');
    expect(snapshot).toMatchObject({ matchedKeys: 6, scanComplete: false });
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ connectionId: 'c1' }), { partial: true });
  });

  describe('cluster members that were never read', () => {
    const primary = (id: string, slots: number[][], flags: string[] = []) => ({ id, flags: [...flags, 'master'], slots });
    const replica = (id: string) => ({ id, flags: ['slave'], slots: [] });

    function clusterSetup(
      member: 'deregistered' | 'role-failed' | 'replica' | 'primary',
      view: unknown[] = [primary('n0', [[0, 8191]], ['myself']), member === 'replica' ? replica('n1') : primary('n1', [[8192, 16383]])],
    ) {
      const ctx = setup();
      const listener = jest.fn();
      ctx.service.onSnapshot(listener);
      const other = fakeClient([]);
      ctx.client.getClusterNodes = jest.fn().mockResolvedValue(view);
      if (member === 'role-failed') other.getRole.mockRejectedValue(new Error('timeout'));
      if (member === 'replica') other.getRole.mockResolvedValue({ role: 'slave' });
      ctx.registry.get.mockImplementation((id: string) => {
        if (id === 'm1' && member === 'deregistered') throw new Error('not registered');
        return id === 'm1' ? other : ctx.client;
      });
      ctx.registry.list.mockReturnValue([
        { id: 'c1', name: 'one', isConnected: true, connectionType: 'direct' },
        {
          id: 'm1',
          name: 'm1',
          isConnected: true,
          connectionType: 'direct',
          membership: { seedId: 'c1', nodeId: 'n1', origin: 'auto', source: 'cluster' },
        },
      ]);
      return { ...ctx, listener };
    }

    it.each(['deregistered', 'role-failed'] as const)('marks the snapshot partial when a member is %s', async (member) => {
      const { service, listener } = clusterSetup(member);
      const snapshot = await service.triggerCollection('c1');
      expect(snapshot).toMatchObject({ scanComplete: false });
      expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ connectionId: 'c1' }), { partial: true });
    });

    it('does not treat a replica as unread', async () => {
      const { service, listener } = clusterSetup('replica');
      const snapshot = await service.triggerCollection('c1');
      expect(snapshot).toMatchObject({ scanComplete: true });
      expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ connectionId: 'c1' }), { partial: false });
    });

    it('keeps the snapshot complete when every slot owner was scanned', async () => {
      const { service } = clusterSetup('primary');
      expect(await service.triggerCollection('c1')).toMatchObject({ scanComplete: true });
    });

    it('marks the snapshot incomplete when a slot owner has no member connection', async () => {
      const { service } = clusterSetup('primary', [
        primary('n0', [[0, 5460]], ['myself']),
        primary('n1', [[5461, 10922]]),
        primary('n2', [[10923, 16383]]),
      ]);
      expect(await service.triggerCollection('c1')).toMatchObject({ scanComplete: false, primariesScanned: 2, primariesTotal: 3 });
    });

    it('limits sibling probes on each primary to the slots it owns', async () => {
      const { service, registry, client } = clusterSetup('primary');
      const sample = jest.spyOn(scanner, 'sampleLmcacheKeys');
      try {
        await service.triggerCollection('c1');
        const ownership = new Map(
          sample.mock.calls.map(([target, , owns]) => [target === client ? 'seed' : 'member', owns]),
        );
        expect([0, 8191, 8192].map((slot) => ownership.get('seed')?.(slot))).toEqual([true, true, false]);
        expect([8191, 8192, 16383].map((slot) => ownership.get('member')?.(slot))).toEqual([false, true, true]);
        expect(registry.get).toHaveBeenCalledWith('m1');
      } finally {
        sample.mockRestore();
      }
    });

    it('probes every sibling when the cluster view is unknown', async () => {
      const { service, client } = clusterSetup('primary');
      client.getClusterNodes.mockRejectedValue(new Error('timeout'));
      const sample = jest.spyOn(scanner, 'sampleLmcacheKeys');
      try {
        await service.triggerCollection('c1');
        expect(sample.mock.calls.every(([, , owns]) => owns === undefined)).toBe(true);
      } finally {
        sample.mockRestore();
      }
    });

    it('scales by the slots of the primaries that were read when one read fails', async () => {
      const { service, registry, client } = clusterSetup('primary');
      const broken = fakeClient([]);
      broken.getDbSize.mockRejectedValue(new Error('LOADING'));
      registry.get.mockImplementation((id: string) => (id === 'm1' ? broken : client));
      expect(await service.triggerCollection('c1')).toMatchObject({
        scanComplete: false,
        matchedKeys: 6,
        chunksEst: 12,
        primariesScanned: 1,
        primariesTotal: 2,
      });
    });

    it('keeps the snapshot complete when only a replica fails its role check', async () => {
      const { service } = clusterSetup('role-failed', [primary('n0', [[0, 16383]], ['myself']), replica('n1')]);
      expect(await service.triggerCollection('c1')).toMatchObject({ scanComplete: true });
    });

    it.each([
      ['its IP', '10.0.0.2'],
      ['its announced hostname', 'node-2.example'],
    ])('finds a member whose stored node id is stale by %s', async (_label, host) => {
      const { service, registry } = clusterSetup('primary', [
        primary('n0', [[0, 5460]], ['myself']),
        { ...primary('n1-replaced', [[5461, 16383]]), address: '10.0.0.2:6379@16379', hostname: 'node-2.example' },
      ]);
      registry.getConfig.mockImplementation((id: string) =>
        id === 'm1'
          ? { id: 'm1', name: 'm1', host, port: 6379, dbIndex: 0 }
          : { id: 'c1', name: 'one', host: 'h', port: 6379, dbIndex: 0 },
      );
      expect(await service.triggerCollection('c1')).toMatchObject({
        scanComplete: true,
        chunksEst: 6,
        primariesScanned: 2,
        primariesTotal: 2,
      });
    });

    it('does not scale the estimate when a scanned member matches no slot owner', async () => {
      const { service, registry, client } = clusterSetup('primary', [
        primary('n0', [[0, 5460]], ['myself']),
        primary('n1-replaced', [[5461, 10922]]),
        primary('n2', [[10923, 16383]]),
      ]);
      const unidentified = fakeClient(Array.from({ length: 6 }, (_, i) => KEY(i + 6)));
      registry.get.mockImplementation((id: string) => (id === 'm1' ? unidentified : client));
      expect(await service.triggerCollection('c1')).toMatchObject({
        matchedKeys: 12,
        chunksEst: 12,
        primariesScanned: 1,
        primariesTotal: 3,
        scanComplete: false,
      });
    });

    it('scans a member once when it is the same node as the seed', async () => {
      const seedId = 'a'.repeat(40);
      const { service, registry, client } = clusterSetup('primary', [
        primary(seedId, [[0, 8191]], ['myself']),
        primary('b'.repeat(40), [[8192, 16383]]),
      ]);
      const sameNode = fakeClient(Array.from({ length: 6 }, (_, i) => KEY(i)));
      const myId = (target: any) => {
        const call = target.call.getMockImplementation();
        target.call.mockImplementation(async (cmd: string, args: string[]) => (cmd === 'CLUSTER' && args[0] === 'MYID' ? seedId : call(cmd, args)));
      };
      myId(client);
      myId(sameNode);
      registry.get.mockImplementation((id: string) => (id === 'm1' ? sameNode : client));
      const snapshot = await service.triggerCollection('c1');
      expect(snapshot).toMatchObject({ matchedKeys: 6, chunksEst: 12, primariesScanned: 1, primariesTotal: 2, scanComplete: false });
      expect(sameNode.getDbSize).not.toHaveBeenCalled();
    });

    it('marks the snapshot incomplete when the cluster view cannot be read', async () => {
      const { service, client } = clusterSetup('primary');
      client.getClusterNodes.mockRejectedValue(new Error('timeout'));
      expect(await service.triggerCollection('c1')).toMatchObject({ scanComplete: false });
    });
  });

  describe('cluster seed without registered members', () => {
    function seedSetup(clusterNodes: () => Promise<unknown>) {
      const ctx = setup();
      ctx.client.getCapabilities = () => ({ clusterEnabled: true });
      ctx.client.getClusterNodes = jest.fn(clusterNodes);
      return ctx;
    }

    it('marks the snapshot incomplete when other primaries own slots', async () => {
      const { service } = seedSetup(async () => [
        { id: 'a', flags: ['myself', 'master'], slots: [[0, 8191]] },
        { id: 'b', flags: ['master'], slots: [[8192, 16383]] },
        { id: 'c', flags: ['slave'], slots: [] },
      ]);
      expect(await service.triggerCollection('c1')).toMatchObject({ matchedKeys: 6, scanComplete: false });
    });

    it('reports the shards scanned and scales the footprint by the slots they own', async () => {
      const { service } = seedSetup(async () => [
        { id: 'a', flags: ['myself', 'master'], slots: [[0, 4095]] },
        { id: 'b', flags: ['master'], slots: [[4096, 8191]] },
        { id: 'c', flags: ['master'], slots: [[8192, 16383]] },
        { id: 'd', flags: ['slave'], slots: [] },
      ]);
      expect(await service.triggerCollection('c1')).toMatchObject({
        matchedKeys: 6,
        chunksEst: 24,
        primariesScanned: 1,
        primariesTotal: 3,
      });
    });

    it('counts a replica seed as no primary scanned', async () => {
      const { service } = seedSetup(async () => [
        { id: 'r', flags: ['myself', 'slave'], master: 'a', slots: [] },
        { id: 'a', flags: ['master'], slots: [[0, 16383]] },
      ]);
      expect(await service.triggerCollection('c1')).toMatchObject({
        scanComplete: false,
        primariesScanned: 0,
        primariesTotal: 1,
      });
    });

    it('does not sample keys on a replica seed, which would answer MOVED', async () => {
      const { service, client } = seedSetup(async () => [
        { id: 'r', flags: ['myself', 'slave'], master: 'a', slots: [] },
        { id: 'a', flags: ['master'], slots: [[0, 16383]] },
      ]);
      const sample = jest.spyOn(scanner, 'sampleLmcacheKeys');
      try {
        expect(await service.triggerCollection('c1')).toMatchObject({ matchedKeys: 6, primariesScanned: 0 });
        expect(sample.mock.calls.filter(([target]) => target === client)).toHaveLength(0);
      } finally {
        sample.mockRestore();
      }
    });

    it('samples keys on a primary seed', async () => {
      const { service, client } = seedSetup(async () => [{ id: 'a', flags: ['myself', 'master'], slots: [[0, 16383]] }]);
      const sample = jest.spyOn(scanner, 'sampleLmcacheKeys');
      try {
        await service.triggerCollection('c1');
        expect(sample.mock.calls.filter(([target]) => target === client)).toHaveLength(1);
      } finally {
        sample.mockRestore();
      }
    });

    it('keeps the snapshot complete when the seed is the only primary', async () => {
      const { service } = seedSetup(async () => [{ id: 'a', flags: ['myself', 'master'], slots: [[0, 16383]] }]);
      expect(await service.triggerCollection('c1')).toMatchObject({ scanComplete: true, primariesScanned: 1, primariesTotal: 1 });
    });

    it('marks the snapshot incomplete when the cluster view cannot be read', async () => {
      const { service } = seedSetup(async () => {
        throw new Error('timeout');
      });
      expect(await service.triggerCollection('c1')).toMatchObject({
        scanComplete: false,
        chunksEst: 6,
        primariesScanned: 1,
        primariesTotal: null,
      });
    });

    it('does not read the cluster view of a standalone server', async () => {
      const { service, client } = setup();
      client.getCapabilities = () => ({ clusterEnabled: false });
      client.getClusterNodes = jest.fn();
      expect(await service.triggerCollection('c1')).toMatchObject({ scanComplete: true, primariesScanned: 1, primariesTotal: 1 });
      expect(client.getClusterNodes).not.toHaveBeenCalled();
    });
  });

  describe('disconnected cluster members', () => {
    function offlineSetup(clusterNodes: () => Promise<unknown>) {
      const ctx = setup();
      const listener = jest.fn();
      ctx.service.onSnapshot(listener);
      ctx.registry.list.mockReturnValue([
        { id: 'c1', name: 'one', isConnected: true, connectionType: 'direct' },
        {
          id: 'm1',
          name: 'm1',
          isConnected: false,
          connectionType: 'direct',
          membership: { seedId: 'c1', nodeId: 'n1', origin: 'auto', source: 'cluster' },
        },
      ]);
      ctx.client.getClusterNodes = jest.fn(clusterNodes);
      return { ...ctx, listener };
    }

    it('marks the snapshot partial when a disconnected member still owns slots as a primary', async () => {
      const { service, listener } = offlineSetup(async () => [{ id: 'n1', flags: ['master', 'fail?'], slots: [[0, 5460]] }]);
      const snapshot = await service.triggerCollection('c1');
      expect(snapshot).toMatchObject({ scanComplete: false });
      expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ connectionId: 'c1' }), { partial: true });
    });

    it('marks the snapshot partial when the cluster view cannot be read', async () => {
      const { service, listener } = offlineSetup(async () => {
        throw new Error('timeout');
      });
      await service.triggerCollection('c1');
      expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ connectionId: 'c1' }), { partial: true });
    });

    it.each([
      ['a replica', { id: 'n1', flags: ['slave'], slots: [] }],
      ['a failed-over primary without slots', { id: 'n1', flags: ['master', 'fail'], slots: [] }],
    ])('does not treat %s as unread', async (_label, node) => {
      const { service, listener } = offlineSetup(async () => [node]);
      const snapshot = await service.triggerCollection('c1');
      expect(snapshot).toMatchObject({ scanComplete: true });
      expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ connectionId: 'c1' }), { partial: false });
    });
  });

  describe('partial reads with too few keys', () => {
    function partialSetup() {
      const ctx = setup([KEY(0)]);
      const broken = fakeClient([]);
      broken.getDbSize.mockRejectedValue(new Error('LOADING'));
      jest.spyOn(ctx.service as any, 'nodesFor').mockResolvedValue({
        nodes: [
          { name: 'a', client: ctx.client },
          { name: 'b', client: broken },
        ],
        skipped: 0,
      });
      return ctx;
    }

    it('keeps the previous detection instead of flipping to not detected', async () => {
      const { service, storage } = partialSetup();
      storage.getKvCacheFootprintSnapshots.mockResolvedValue([{ connectionId: 'c1', detected: true }]);
      const snapshot = await service.triggerCollection('c1');
      expect(snapshot).toMatchObject({ detected: true, scanComplete: false });
      expect(storage.getKvCacheFootprintSnapshots).toHaveBeenCalledWith({ connectionId: 'c1', limit: 1 });
    });

    it('keeps the sample key when the readable nodes hold no LMCache keys', async () => {
      const { service, storage } = partialSetup();
      storage.getKvCacheFootprintSnapshots.mockResolvedValue([{ connectionId: 'c1', detected: true }]);
      await service.triggerCollection('c1');
      expect(service.getSampleKey('c1')).toBe('m/x@1@0@1…@bfloat16');
      const broken = fakeClient([]);
      broken.getDbSize.mockRejectedValue(new Error('LOADING'));
      (service as any).nodesFor.mockResolvedValue({
        nodes: [
          { name: 'a', client: fakeClient([]) },
          { name: 'b', client: broken },
        ],
        skipped: 0,
      });
      await service.triggerCollection('c1');
      expect(service.getSampleKey('c1')).toBe('m/x@1@0@1…@bfloat16');
    });

    it('neither backs off polling nor switches the next scan to a probe', async () => {
      const { service, storage, client } = partialSetup();
      await service.triggerCollection('c1');
      expect(storage.saveKvCacheFootprintSnapshot.mock.calls[0][0].detected).toBe(false);
      expect((service as any).undetected.has('c1')).toBe(false);
      client.getDbSize.mockClear();
      await (service as any).tick();
      expect(client.getDbSize).toHaveBeenCalledTimes(1);
    });
  });

  it('fails the collection when every node fails', async () => {
    const { service, client } = setup();
    client.getDbSize.mockRejectedValue(new Error('LOADING'));
    await expect(service.triggerCollection('c1')).rejects.toThrow('LOADING');
  });

  it('scans fully first and only probes a connection whose last snapshot was undetected', async () => {
    const { service, client } = setup();
    client.call.mockImplementation(async (cmd: string) => (cmd === 'SCAN' ? ['7', []] : REPLIES[cmd]));
    client.getDbSize.mockResolvedValue(1_000_000);
    const scans = () => client.call.mock.calls.filter(([cmd]: [string]) => cmd === 'SCAN').length;
    await service.triggerCollection('c1');
    expect(scans()).toBe(200);

    client.call.mockClear();
    await service.triggerCollection('c1');
    expect(scans()).toBe(2);

    (service as any).forget('c1');
    client.call.mockClear();
    await service.triggerCollection('c1');
    expect(scans()).toBe(200);
  });

  it('deletes the data of a retired member once it is deleted, even with no connected connections', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    const { service, storage, registry } = setup();
    const member = { id: 'm1', name: 'member', isConnected: false, connectionType: 'direct' };
    registry.list.mockImplementation((options?: { includeRetired?: boolean }) => (options?.includeRetired ? [member] : []));
    try {
      await service.onModuleInit();
      await jest.advanceTimersByTimeAsync(300000);
      expect(storage.deleteKvCacheConnectionData).not.toHaveBeenCalled();

      registry.list.mockImplementation(() => []);
      await jest.advanceTimersByTimeAsync(300000);
      await new Promise((resolve) => setImmediate(resolve));
      expect(storage.deleteKvCacheConnectionData).toHaveBeenCalledWith('m1');
    } finally {
      await service.onModuleDestroy();
      jest.useRealTimers();
    }
  });

  it('lists other databases relative to the database the client actually selected', async () => {
    const { service, client, registry } = setup();
    registry.getConfig.mockReturnValue({ id: 'c1', name: 'one', host: 'h', port: 6379, dbIndex: 2 });
    client.getInfoParsed.mockResolvedValue({
      memory: { used_memory: '1000', maxmemory: '0', maxmemory_policy: 'noeviction' },
      stats: { evicted_keys: '0' },
      keyspace: { db0: { keys: 6, expires: 0, avg_ttl: 0 }, db2: { keys: 9, expires: 0, avg_ttl: 0 } },
    });
    client.getActiveDbIndex = jest.fn().mockReturnValue(0);
    expect((await service.triggerCollection('c1'))?.otherDbs).toEqual([2]);
    client.getActiveDbIndex.mockReturnValue(2);
    expect((await service.triggerCollection('c1'))?.otherDbs).toEqual([0]);
  });

  it('keeps going when a listener throws', async () => {
    const { service, storage } = setup();
    service.onSnapshot(() => { throw new Error('boom'); });
    await expect(service.triggerCollection('c1')).resolves.not.toBeNull();
    expect(storage.saveKvCacheFootprintSnapshot).toHaveBeenCalled();
  });

  it('starts the poller even when the licence has not resolved at init', async () => {
    const { service } = setup(undefined, false);
    const start = jest.spyOn(service as any, 'start').mockImplementation(() => undefined);
    await service.onModuleInit();
    await new Promise((resolve) => setImmediate(resolve));
    expect(start).toHaveBeenCalled();
  });

  it('runs the first scan as soon as the licence resolves instead of a full interval later', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    const { service, storage, license } = setup(undefined, false);
    let resolveLicence!: (value: unknown) => void;
    license.ensureValidated.mockReturnValue(new Promise((resolve) => (resolveLicence = resolve)));
    try {
      await service.onModuleInit();
      await new Promise((resolve) => setImmediate(resolve));
      expect(storage.saveKvCacheFootprintSnapshot).not.toHaveBeenCalled();

      license.hasFeature.mockImplementation((f: string) => f === Feature.KV_CACHE_MONITORING);
      resolveLicence({});
      for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
      expect(storage.saveKvCacheFootprintSnapshot).toHaveBeenCalledTimes(1);
    } finally {
      await service.onModuleDestroy();
      jest.useRealTimers();
    }
  });

  it('skips collection while unlicensed and collects once the licence resolves', async () => {
    const { service, storage, license } = setup(undefined, false);
    jest.spyOn(service as any, 'start').mockImplementation(() => undefined);
    await service.onModuleInit();
    await (service as any).tick();
    expect(storage.saveKvCacheFootprintSnapshot).not.toHaveBeenCalled();
    license.hasFeature.mockImplementation((f: string) => f === Feature.KV_CACHE_MONITORING);
    await (service as any).tick();
    expect(storage.saveKvCacheFootprintSnapshot).toHaveBeenCalledTimes(1);
  });

  it('runs connection removal cleanup while unlicensed', async () => {
    const { service, storage, registry } = setup(undefined, false);
    const listener = jest.fn();
    service.onConnectionRemoval(listener);
    jest.spyOn(service as any, 'start').mockImplementation(() => undefined);
    await service.onModuleInit();
    await (service as any).tick();
    registry.list.mockReturnValue([]);
    registry.removed('c1');
    await new Promise((resolve) => setImmediate(resolve));
    expect(storage.deleteKvCacheConnectionData).toHaveBeenCalledWith('c1');
    expect(storage.saveKvCacheFootprintSnapshot).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledWith('c1');
    await service.onModuleDestroy();
  });

  it('stops polling a retired member but keeps its data', async () => {
    const { service, storage, client, registry } = setup();
    const removed = jest.fn();
    const restored = jest.fn();
    service.onConnectionRemoval(removed);
    service.onConnectionRestore(restored);
    jest.spyOn(service as any, 'start').mockImplementation(() => undefined);
    await service.onModuleInit();
    await (service as any).tick();
    expect(client.getDbSize).toHaveBeenCalledTimes(1);
    registry.list.mockImplementation((options?: { includeRetired?: boolean }) =>
      options?.includeRetired ? [{ id: 'c1', name: 'one', isConnected: false, connectionType: 'direct' }] : [],
    );
    await (service as any).tick();
    await new Promise((resolve) => setImmediate(resolve));
    expect(client.getDbSize).toHaveBeenCalledTimes(1);
    expect(storage.deleteKvCacheConnectionData).not.toHaveBeenCalled();
    expect(removed).not.toHaveBeenCalled();
    expect(restored).not.toHaveBeenCalled();
    expect(service.getSampleKey('c1')).toBe('m/x@1@0@1…@bfloat16');
    await service.onModuleDestroy();
  });

  it('backs off full collection after a not-detected result until the recheck window passes', async () => {
    const { service, storage, client } = setup([]);
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      await (service as any).tick();
      expect(storage.saveKvCacheFootprintSnapshot).toHaveBeenCalledTimes(1);
      expect(storage.saveKvCacheFootprintSnapshot.mock.calls[0][0].detected).toBe(false);
      now.mockReturnValue(1_000_000 + 1_800_000 - 1);
      await (service as any).tick();
      expect(storage.saveKvCacheFootprintSnapshot).toHaveBeenCalledTimes(1);
      expect(client.getDbSize).toHaveBeenCalledTimes(1);
      now.mockReturnValue(1_000_000 + 1_800_000);
      await (service as any).tick();
      expect(storage.saveKvCacheFootprintSnapshot).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  describe('back-off on partial runs', () => {
    function partialSetup() {
      const ctx = setup([]);
      ctx.client.getCapabilities = () => ({ clusterEnabled: true });
      ctx.client.getClusterNodes = jest.fn().mockResolvedValue([
        { id: 'a', flags: ['myself', 'master'], slots: [[0, 8191]] },
        { id: 'b', flags: ['master'], slots: [[8192, 16383]] },
      ]);
      return ctx;
    }

    it('does not let a discarded run touch the miss count of a re-registered connection', async () => {
      const { service, storage, client, registry } = partialSetup();
      storage.getKvCacheFootprintSnapshots.mockResolvedValue([{ connectionId: 'c1', detected: true }]);
      const listed = registry.list();
      let finishRead: (size: number) => void = () => undefined;
      client.getDbSize.mockImplementationOnce(() => new Promise((resolve) => (finishRead = resolve)));
      const stale = service.triggerCollection('c1');
      await new Promise((resolve) => setImmediate(resolve));
      registry.list.mockReturnValue([]);
      (service as any).forget('c1');
      registry.list.mockReturnValue(listed);
      await new Promise((resolve) => setImmediate(resolve));
      finishRead(0);
      await expect(stale).resolves.toBeNull();
      for (let i = 0; i < PARTIAL_MISSES_BEFORE_CLEAR; i += 1) await service.triggerCollection('c1');
      const saved = storage.saveKvCacheFootprintSnapshot.mock.calls.map(([snapshot]: [any]) => snapshot.detected);
      expect(saved).toEqual([true, true, false]);
    });

    it('keeps polling when slot owners were left unscanned and nothing was detected', async () => {
      const { service, storage } = partialSetup();
      await (service as any).tick();
      await (service as any).tick();
      expect(storage.saveKvCacheFootprintSnapshot).toHaveBeenCalledTimes(2);
      expect(storage.saveKvCacheFootprintSnapshot.mock.calls[0][0]).toMatchObject({ detected: false, scanComplete: false });
    });

    it('backs off once consecutive partial misses clear an earlier detection', async () => {
      const { service, storage } = partialSetup();
      storage.getKvCacheFootprintSnapshots.mockResolvedValue([{ connectionId: 'c1', detected: true }]);
      for (let i = 0; i < PARTIAL_MISSES_BEFORE_CLEAR + 1; i += 1) await (service as any).tick();
      const saved = storage.saveKvCacheFootprintSnapshot.mock.calls.map(([snapshot]: [any]) => snapshot.detected);
      expect(saved).toEqual([true, true, false]);
    });

    it('backs off a cluster that is partial on every run after consecutive misses', async () => {
      const { service, storage } = partialSetup();
      const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
      try {
        for (let i = 0; i < PARTIAL_MISSES_BEFORE_CLEAR + 2; i += 1) await (service as any).tick();
        expect(storage.saveKvCacheFootprintSnapshot).toHaveBeenCalledTimes(PARTIAL_MISSES_BEFORE_CLEAR);
        now.mockReturnValue(1_000_000 + 1_800_000);
        await (service as any).tick();
        expect(storage.saveKvCacheFootprintSnapshot).toHaveBeenCalledTimes(PARTIAL_MISSES_BEFORE_CLEAR + 1);
      } finally {
        now.mockRestore();
      }
    });

    it('keeps polling when a scanned primary could not be read', async () => {
      const { service, storage } = partialSetup();
      const broken = fakeClient([]);
      broken.getDbSize.mockRejectedValue(new Error('LOADING'));
      jest.spyOn(service as any, 'nodesFor').mockResolvedValue({
        nodes: [{ name: 'a', client: fakeClient([]) }, { name: 'b', client: broken }],
        skipped: 0,
      });
      await (service as any).tick();
      await (service as any).tick();
      expect(storage.saveKvCacheFootprintSnapshot).toHaveBeenCalledTimes(2);
    });

    it('keeps polling when a partial run keeps an earlier detection', async () => {
      const { service, storage } = partialSetup();
      storage.getKvCacheFootprintSnapshots.mockResolvedValue([{ connectionId: 'c1', detected: true }]);
      await (service as any).tick();
      await (service as any).tick();
      expect(storage.saveKvCacheFootprintSnapshot).toHaveBeenCalledTimes(2);
    });
  });

  it('collects on a manual trigger during the back-off and resumes polling once detected', async () => {
    const keys = Array.from({ length: 6 }, (_, i) => KEY(i));
    const { service, storage, client } = setup([]);
    await (service as any).tick();
    await (service as any).tick();
    expect(storage.saveKvCacheFootprintSnapshot).toHaveBeenCalledTimes(1);
    client.getDbSize.mockResolvedValue(keys.length);
    client.call.mockImplementation(async (cmd: string) => (cmd === 'SCAN' ? ['0', keys] : REPLIES[cmd]));
    expect((await service.triggerCollection('c1'))?.detected).toBe(true);
    await (service as any).tick();
    expect(storage.saveKvCacheFootprintSnapshot).toHaveBeenCalledTimes(3);
  });

  it('rejects a manual trigger for an unknown connection with NotFoundException', async () => {
    const { service, registry, storage } = setup();
    registry.getConfig.mockReturnValue(null);
    await expect(service.triggerCollection('missing')).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.saveKvCacheFootprintSnapshot).not.toHaveBeenCalled();
  });

  it('deletes stored data when a connection is removed', async () => {
    const { service, storage, registry } = setup();
    registry.list.mockReturnValue([]);
    (service as any).forget('c1');
    await new Promise((resolve) => setImmediate(resolve));
    expect(storage.deleteKvCacheConnectionData).toHaveBeenCalledWith('c1');
  });

  it('deletes stored data only after async removal listeners settle', async () => {
    const { service, storage, registry } = setup();
    registry.list.mockReturnValue([]);
    let release: () => void = () => undefined;
    service.onConnectionRemoval(() => new Promise<void>((resolve) => (release = resolve)));
    (service as any).forget('c1');
    await new Promise((resolve) => setImmediate(resolve));
    expect(storage.deleteKvCacheConnectionData).not.toHaveBeenCalled();
    release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(storage.deleteKvCacheConnectionData).toHaveBeenCalledWith('c1');
  });

  it('discards an in-flight collection and deletes data after it settles when the connection is removed', async () => {
    const { service, storage, client, registry } = setup();
    let finishRead: (size: number) => void = () => undefined;
    client.getDbSize.mockImplementationOnce(() => new Promise((resolve) => (finishRead = resolve)));
    const listener = jest.fn();
    service.onSnapshot(listener);
    const collecting = service.triggerCollection('c1');
    await new Promise((resolve) => setImmediate(resolve));
    registry.list.mockReturnValue([]);
    (service as any).forget('c1');
    await new Promise((resolve) => setImmediate(resolve));
    expect(storage.deleteKvCacheConnectionData).not.toHaveBeenCalled();
    finishRead(6);
    await expect(collecting).resolves.toBeNull();
    await new Promise((resolve) => setImmediate(resolve));
    expect(storage.saveKvCacheFootprintSnapshot).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(storage.deleteKvCacheConnectionData).toHaveBeenCalledWith('c1');
  });

  it('keeps fresh data when the connection is re-registered before an in-flight run settles', async () => {
    const { service, storage, client, registry } = setup();
    const listed = registry.list();
    let finishRead: (size: number) => void = () => undefined;
    client.getDbSize.mockImplementationOnce(() => new Promise((resolve) => (finishRead = resolve)));
    const stale = service.triggerCollection('c1');
    await new Promise((resolve) => setImmediate(resolve));
    registry.list.mockReturnValue([]);
    (service as any).forget('c1');
    registry.list.mockReturnValue(listed);
    const fresh = await service.triggerCollection('c1');
    expect(fresh).not.toBeNull();
    expect(storage.saveKvCacheFootprintSnapshot).toHaveBeenCalledTimes(1);
    finishRead(6);
    await expect(stale).resolves.toBeNull();
    await new Promise((resolve) => setImmediate(resolve));
    expect(storage.saveKvCacheFootprintSnapshot).toHaveBeenCalledTimes(1);
    expect(storage.deleteKvCacheConnectionData).not.toHaveBeenCalled();
    expect(await service.triggerCollection('c1')).not.toBeNull();
  });

  it('announces a restore instead of deleting when the connection is registered again', async () => {
    const { service, storage } = setup();
    const restored = jest.fn();
    service.onConnectionRestore(restored);
    (service as any).forget('c1');
    await new Promise((resolve) => setImmediate(resolve));
    expect(storage.deleteKvCacheConnectionData).not.toHaveBeenCalled();
    expect(restored).toHaveBeenCalledWith('c1');
  });

  it('announces a restore instead of deleting when the connection was only retired', async () => {
    const { service, storage, registry } = setup();
    const restored = jest.fn();
    service.onConnectionRestore(restored);
    registry.list.mockImplementation((options?: { includeRetired?: boolean }) =>
      options?.includeRetired ? [{ id: 'c1', name: 'one', isConnected: true, connectionType: 'direct' }] : [],
    );
    (service as any).forget('c1');
    await new Promise((resolve) => setImmediate(resolve));
    expect(storage.deleteKvCacheConnectionData).not.toHaveBeenCalled();
    expect(restored).toHaveBeenCalledWith('c1');
  });

  it('does not announce a restore when the connection stays removed', async () => {
    const { service, storage, registry } = setup();
    const restored = jest.fn();
    service.onConnectionRestore(restored);
    registry.list.mockReturnValue([]);
    (service as any).forget('c1');
    await new Promise((resolve) => setImmediate(resolve));
    expect(storage.deleteKvCacheConnectionData).toHaveBeenCalledWith('c1');
    expect(restored).not.toHaveBeenCalled();
  });

  it('waits for an in-flight removal delete before saving for a re-registered connection', async () => {
    const { service, storage, registry } = setup();
    const listed = registry.list();
    const order: string[] = [];
    let finishDelete: () => void = () => undefined;
    storage.deleteKvCacheConnectionData.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishDelete = () => { order.push('delete'); resolve(); })),
    );
    storage.saveKvCacheFootprintSnapshot.mockImplementation(async () => { order.push('save'); });
    registry.list.mockReturnValue([]);
    (service as any).forget('c1');
    await new Promise((resolve) => setImmediate(resolve));
    expect(storage.deleteKvCacheConnectionData).toHaveBeenCalledWith('c1');
    registry.list.mockReturnValue(listed);
    const collecting = service.triggerCollection('c1');
    await new Promise((resolve) => setImmediate(resolve));
    expect(storage.saveKvCacheFootprintSnapshot).not.toHaveBeenCalled();
    finishDelete();
    await expect(collecting).resolves.not.toBeNull();
    expect(order).toEqual(['delete', 'save']);
  });

  it('holds a save that races an in-flight removal delete until the delete completes', async () => {
    const { service, storage, client, registry } = setup();
    const listed = registry.list();
    const order: string[] = [];
    let release: () => void = () => undefined;
    let finishRead: (size: number) => void = () => undefined;
    let finishDelete: () => void = () => undefined;
    service.onConnectionRemoval(() => new Promise<void>((resolve) => (release = resolve)));
    client.getDbSize.mockImplementationOnce(() => new Promise((resolve) => (finishRead = resolve)));
    storage.deleteKvCacheConnectionData.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishDelete = () => { order.push('delete'); resolve(); })),
    );
    storage.saveKvCacheFootprintSnapshot.mockImplementation(async () => { order.push('save'); });
    registry.list.mockReturnValue([]);
    (service as any).forget('c1');
    const collecting = service.collect({ connectionId: 'c1', connectionName: 'one', client, host: 'h', port: 6379 });
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(storage.deleteKvCacheConnectionData).toHaveBeenCalledWith('c1');
    registry.list.mockReturnValue(listed);
    finishRead(6);
    await new Promise((resolve) => setImmediate(resolve));
    expect(storage.saveKvCacheFootprintSnapshot).not.toHaveBeenCalled();
    finishDelete();
    await expect(collecting).resolves.not.toBeNull();
    expect(order).toEqual(['delete', 'save']);
  });

  it('drops a poll that waited on the removal delete when the connection stays removed', async () => {
    const { service, storage, client, registry } = setup();
    const listener = jest.fn();
    service.onSnapshot(listener);
    let finishDelete: () => void = () => undefined;
    storage.deleteKvCacheConnectionData.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishDelete = resolve)),
    );
    registry.list.mockReturnValue([]);
    registry.getConfig.mockReturnValue(null);
    (service as any).forget('c1');
    await new Promise((resolve) => setImmediate(resolve));
    expect(storage.deleteKvCacheConnectionData).toHaveBeenCalledWith('c1');
    const collecting = service.collect({ connectionId: 'c1', connectionName: 'one', client, host: 'h', port: 6379 });
    await new Promise((resolve) => setImmediate(resolve));
    finishDelete();
    await expect(collecting).resolves.toBeNull();
    expect(storage.saveKvCacheFootprintSnapshot).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it('does not save or announce when the connection disappears mid-collect', async () => {
    const { service, storage, client, registry } = setup();
    const listener = jest.fn();
    service.onSnapshot(listener);
    let finishRead: (size: number) => void = () => undefined;
    client.getDbSize.mockImplementationOnce(() => new Promise((resolve) => (finishRead = resolve)));
    const collecting = service.collect({ connectionId: 'c1', connectionName: 'one', client, host: 'h', port: 6379 });
    await new Promise((resolve) => setImmediate(resolve));
    registry.getConfig.mockReturnValue(null);
    finishRead(6);
    await expect(collecting).resolves.toBeNull();
    expect(storage.saveKvCacheFootprintSnapshot).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it('deletes once for the latest removal when a connection is removed again before data is deleted', async () => {
    const { service, storage, registry } = setup();
    registry.list.mockReturnValue([]);
    const releases: Array<() => void> = [];
    service.onConnectionRemoval(() => new Promise<void>((resolve) => releases.push(resolve)));
    (service as any).forget('c1');
    (service as any).forget('c1');
    releases.forEach((release) => release());
    await new Promise((resolve) => setImmediate(resolve));
    expect(storage.deleteKvCacheConnectionData).toHaveBeenCalledTimes(1);
  });

  it('forgets the removal generation once the data is deleted', async () => {
    const { service, storage, registry } = setup();
    registry.list.mockReturnValue([]);
    (service as any).forget('c1');
    await new Promise((resolve) => setImmediate(resolve));
    expect(storage.deleteKvCacheConnectionData).toHaveBeenCalledWith('c1');
    expect((service as any).generations.has('c1')).toBe(false);
  });

  it('notifies removal listeners with the connection id', () => {
    const { service } = setup();
    const listener = jest.fn();
    const failing = jest.fn(() => { throw new Error('x'); });
    service.onConnectionRemoval(failing);
    service.onConnectionRemoval(listener);
    (service as any).forget('c1');
    expect(listener).toHaveBeenCalledWith('c1');
  });

  it('runs removal listeners only after an in-flight snapshot announce finishes', async () => {
    const { service, registry } = setup();
    const order: string[] = [];
    let release: () => void = () => undefined;
    service.onSnapshot(async () => {
      order.push('announce:start');
      await new Promise<void>((resolve) => (release = resolve));
      order.push('announce:end');
    });
    service.onConnectionRemoval(() => {
      order.push('removed');
    });
    const collecting = service.triggerCollection('c1');
    while (!order.includes('announce:start')) await new Promise((resolve) => setImmediate(resolve));
    registry.list.mockReturnValue([]);
    (service as any).forget('c1');
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(['announce:start']);
    release();
    await collecting;
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(['announce:start', 'announce:end', 'removed']);
  });

  it('keeps the snapshot of a re-registered connection when the older announce finishes after it', async () => {
    const { service } = setup();
    const order: string[] = [];
    let release: () => void = () => undefined;
    let calls = 0;
    service.onSnapshot(async () => {
      calls += 1;
      if (calls > 1) {
        order.push('snapshot:new');
        return;
      }
      order.push('announce:start');
      await new Promise<void>((resolve) => (release = resolve));
      order.push('announce:end');
    });
    service.onConnectionRemoval(() => {
      order.push('removed');
    });
    const stale = service.triggerCollection('c1');
    while (!order.includes('announce:start')) await new Promise((resolve) => setImmediate(resolve));
    (service as any).forget('c1');
    const fresh = service.triggerCollection('c1');
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await stale;
    await expect(fresh).resolves.not.toBeNull();
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(['announce:start', 'announce:end', 'removed', 'snapshot:new']);
  });

  it('deletes data for a connection removed from the registry before the poller saw it', async () => {
    const { service, storage, registry } = setup();
    jest.spyOn(service as any, 'start').mockImplementation(() => undefined);
    await service.onModuleInit();
    registry.list.mockReturnValue([]);
    registry.removed('c2');
    await new Promise((resolve) => setImmediate(resolve));
    expect(storage.deleteKvCacheConnectionData).toHaveBeenCalledWith('c2');
    await service.onModuleDestroy();
  });

  it('rejects a refresh for a retired member without scanning it', async () => {
    const { service, client, registry } = setup();
    const retired = {
      id: 'c1',
      name: 'one',
      isConnected: true,
      connectionType: 'direct',
      membership: { seedId: 'seed', nodeId: 'n', origin: 'auto', source: 'cluster', retiredAt: 1 },
    };
    registry.list.mockImplementation((options?: { includeRetired?: boolean }) => (options?.includeRetired ? [retired] : []));
    await expect(service.triggerCollection('c1')).rejects.toThrow(/retired/);
    await expect(service.triggerCollection('c1')).rejects.toBeInstanceOf(BadRequestException);
    expect(client.getDbSize).not.toHaveBeenCalled();
  });

  it('reads the registry listing once per refresh', async () => {
    const { service, registry } = setup();
    await service.triggerCollection('c1');
    expect(registry.list).toHaveBeenCalledTimes(1);
  });

  it('rejects a refresh for a disconnected connection without scanning it', async () => {
    const { service, client, registry } = setup();
    registry.list.mockReturnValue([{ id: 'c1', name: 'one', isConnected: false, connectionType: 'direct' }]);
    await expect(service.triggerCollection('c1')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(client.getDbSize).not.toHaveBeenCalled();
  });

  it('returns the latest snapshot to a refresh when it is only seconds old', async () => {
    const { service, client, storage } = setup();
    const recent = { connectionId: 'c1', timestamp: Date.now() - 1000, detected: true };
    storage.getKvCacheFootprintSnapshots.mockResolvedValue([recent]);
    expect(await service.triggerCollection('c1')).toBe(recent);
    expect(client.getDbSize).not.toHaveBeenCalled();
    expect(storage.saveKvCacheFootprintSnapshot).not.toHaveBeenCalled();
  });

  it('collects on a refresh when the latest snapshot is older than the reuse window', async () => {
    const { service, storage } = setup();
    storage.getKvCacheFootprintSnapshots.mockResolvedValue([
      { connectionId: 'c1', timestamp: Date.now() - REFRESH_REUSE_MS - 1, detected: true },
    ]);
    await service.triggerCollection('c1');
    expect(storage.saveKvCacheFootprintSnapshot).toHaveBeenCalledTimes(1);
  });

  it('rejects a refresh for an external connection', async () => {
    const { service, client, registry } = setup();
    registry.list.mockReturnValue([{ id: 'c1', name: 'one', isConnected: true, connectionType: 'external' }]);
    registry.getConfig.mockReturnValue({ id: 'c1', name: 'one', host: 'h', port: 6379, connectionType: 'external' });
    registry.get.mockImplementation(() => {
      throw new Error('external connections have no client');
    });
    await expect(service.triggerCollection('c1')).rejects.toBeInstanceOf(BadRequestException);
    expect(client.getDbSize).not.toHaveBeenCalled();
  });

  it('rejects a refresh for a sentinel connection', async () => {
    const { service, client } = setup();
    client.getCapabilities = () => ({ isSentinel: true });
    await expect(service.triggerCollection('c1')).rejects.toBeInstanceOf(BadRequestException);
    expect(client.getDbSize).not.toHaveBeenCalled();
  });

  it('reads INFO while the scan runs and CLIENT LIST only after it', async () => {
    const { service, client } = setup([KEY(0)]);
    let release!: () => void;
    const scanned = new Promise<void>((resolve) => { release = resolve; });
    const call = client.call.getMockImplementation();
    client.call.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'SCAN') await scanned;
      return call!(cmd, args);
    });
    const collecting = service.triggerCollection('c1');
    await new Promise((resolve) => setImmediate(resolve));
    expect(client.getInfoParsed).toHaveBeenCalled();
    expect(client.call).not.toHaveBeenCalledWith('CLIENT', ['LIST']);
    release();
    await collecting;
    expect(client.call).toHaveBeenCalledWith('CLIENT', ['LIST']);
  });

  it('skips CLIENT LIST when the scan finds enough LMCache keys', async () => {
    const { service, client } = setup();
    const clientLists = () => client.call.mock.calls.filter(([cmd]: [string]) => cmd === 'CLIENT').length;
    await service.triggerCollection('c1');
    await service.triggerCollection('c1');
    expect(clientLists()).toBe(0);
  });

  it('skips CLIENT LIST when the run has enough keys though each primary has few', async () => {
    const { service } = setup();
    const a = fakeClient([KEY(0), KEY(1), KEY(2)]);
    const b = fakeClient([KEY(3), KEY(4), KEY(5)]);
    jest.spyOn(service as any, 'nodesFor').mockResolvedValue({ nodes: [{ name: 'a', client: a }, { name: 'b', client: b }], skipped: 0 });
    expect(await service.triggerCollection('c1')).toMatchObject({ detected: true, matchedKeys: 6 });
    expect(a.call).not.toHaveBeenCalledWith('CLIENT', ['LIST']);
    expect(b.call).not.toHaveBeenCalledWith('CLIENT', ['LIST']);
  });

  it('checks CLIENT LIST again when a previously detected cache drops below the key threshold', async () => {
    const { service, client, storage } = setup();
    await service.triggerCollection('c1');
    client.getDbSize.mockResolvedValue(1);
    client.call.mockImplementation(async (cmd: string) =>
      cmd === 'SCAN' ? ['0', [KEY(0)]] : 'id=1 lib-name=GlidePySync(lmcache:0.3.0) lib-ver=1\n',
    );
    const snapshot = await service.triggerCollection('c1');
    expect(client.call).toHaveBeenCalledWith('CLIENT', ['LIST']);
    expect(snapshot).toMatchObject({ detected: true, matchedKeys: 1 });
    await (service as any).tick();
    expect(storage.saveKvCacheFootprintSnapshot).toHaveBeenCalledTimes(3);
  });

  it('ignores an LMCache client connected to another database', async () => {
    const { service, client } = setup([KEY(0)]);
    client.getActiveDbIndex = jest.fn().mockReturnValue(2);
    client.call.mockImplementation(async (cmd: string) =>
      cmd === 'SCAN' ? ['0', [KEY(0)]] : 'id=1 db=0 lib-name=GlidePySync(lmcache:0.3.0) lib-ver=1\n',
    );
    expect(await service.triggerCollection('c1')).toMatchObject({ detected: false, matchedKeys: 1 });
    client.getActiveDbIndex.mockReturnValue(0);
    expect(await service.triggerCollection('c1')).toMatchObject({ detected: true, matchedKeys: 1 });
  });

  it('skips agent connections, which cannot run SCAN or MEMORY USAGE', async () => {
    const { service, storage, client, registry } = setup();
    registry.list.mockReturnValue([{ id: 'c1', name: 'one', isConnected: true, connectionType: 'agent' }]);
    registry.getConfig.mockReturnValue({ id: 'c1', name: 'one', host: 'agent', port: 0, dbIndex: 0 });
    await (service as any).tick();
    await expect(service.triggerCollection('c1')).rejects.toBeInstanceOf(BadRequestException);
    expect(client.getDbSize).not.toHaveBeenCalled();
    expect(storage.saveKvCacheFootprintSnapshot).not.toHaveBeenCalled();
  });
});

describe('resolvePositiveInt', () => {
  it('uses the default when unset', () => {
    expect(resolvePositiveInt(undefined, 300000, 60000)).toBe(300000);
  });

  it('uses the default when the value is not a number', () => {
    expect(resolvePositiveInt('abc', 300000, 60000)).toBe(300000);
    expect(resolvePositiveInt('', 500, 1)).toBe(500);
  });

  it('uses the default when the value is below the floor', () => {
    expect(resolvePositiveInt('5m', 300000, 60000)).toBe(300000);
    expect(resolvePositiveInt('59999', 300000, 60000)).toBe(300000);
    expect(resolvePositiveInt('0', 2000, 1)).toBe(2000);
    expect(resolvePositiveInt('-3', 500, 1)).toBe(500);
  });

  it('rejects numeric prefixes instead of truncating them', () => {
    const onInvalid = jest.fn();
    expect(resolvePositiveInt('500k', 500, 1, onInvalid)).toBe(500);
    expect(resolvePositiveInt('1.5', 500, 1, onInvalid)).toBe(500);
    expect(onInvalid.mock.calls).toEqual([['500k'], ['1.5']]);
  });

  it('accepts exponent notation as the number it spells', () => {
    expect(resolvePositiveInt('1e6', 200000, 1)).toBe(1_000_000);
  });

  it('reports a value below the floor but not an unset one', () => {
    const onInvalid = jest.fn();
    expect(resolvePositiveInt('0', 2000, 1, onInvalid)).toBe(2000);
    expect(resolvePositiveInt(undefined, 2000, 1, onInvalid)).toBe(2000);
    expect(onInvalid.mock.calls).toEqual([['0']]);
  });

  it('uses the default when the value is above the ceiling', () => {
    const onInvalid = jest.fn();
    expect(resolvePositiveInt('86400001', 300000, 60000, onInvalid, 86400000)).toBe(300000);
    expect(resolvePositiveInt('86400000', 300000, 60000, onInvalid, 86400000)).toBe(86400000);
    expect(onInvalid.mock.calls).toEqual([['86400001']]);
  });

  it('accepts a value at or above the floor', () => {
    expect(resolvePositiveInt('60000', 300000, 60000)).toBe(60000);
    expect(resolvePositiveInt('1', 2000, 1)).toBe(1);
    expect(resolvePositiveInt('750', 500, 1)).toBe(750);
  });
});

describe('KvCacheFootprintService settings', () => {
  const keys = ['KV_CACHE_FOOTPRINT_INTERVAL_MS', 'KV_CACHE_SCAN_MAX_KEYS', 'KV_CACHE_MATCH_MAX_KEYS', 'KV_CACHE_SAMPLE_KEYS', 'KV_CACHE_UNDETECTED_RECHECK_MS'];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

  afterEach(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('falls back to the defaults for invalid settings', () => {
    process.env.KV_CACHE_FOOTPRINT_INTERVAL_MS = 'abc';
    process.env.KV_CACHE_SCAN_MAX_KEYS = '0';
    process.env.KV_CACHE_MATCH_MAX_KEYS = 'NaN';
    process.env.KV_CACHE_SAMPLE_KEYS = '-1';
    process.env.KV_CACHE_UNDETECTED_RECHECK_MS = '1000';
    const { service } = setup();
    expect((service as any).getIntervalMs()).toBe(300000);
    expect((service as any).budgets).toEqual({ maxScanned: 200000, maxMatched: 2000 });
    expect((service as any).sampleSize).toBe(500);
    expect((service as any).undetectedRecheckMs).toBe(1800000);
  });

  it('caps the footprint interval at a day so setTimeout cannot overflow', () => {
    process.env.KV_CACHE_FOOTPRINT_INTERVAL_MS = String(2 ** 31);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const { service } = setup();
      expect((service as any).getIntervalMs()).toBe(300000);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('KV_CACHE_FOOTPRINT_INTERVAL_MS'));
      process.env.KV_CACHE_FOOTPRINT_INTERVAL_MS = String(MAX_FOOTPRINT_INTERVAL_MS);
      expect((setup().service as any).getIntervalMs()).toBe(86_400_000);
    } finally {
      warn.mockRestore();
    }
  });

  it('logs the setting it ignores', () => {
    process.env.KV_CACHE_SAMPLE_KEYS = '500k';
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const { service } = setup();
      expect((service as any).sampleSize).toBe(500);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('KV_CACHE_SAMPLE_KEYS'));
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps valid settings', () => {
    process.env.KV_CACHE_FOOTPRINT_INTERVAL_MS = '120000';
    process.env.KV_CACHE_SCAN_MAX_KEYS = '1000';
    process.env.KV_CACHE_MATCH_MAX_KEYS = '10';
    process.env.KV_CACHE_SAMPLE_KEYS = '5';
    process.env.KV_CACHE_UNDETECTED_RECHECK_MS = '600000';
    const { service } = setup();
    expect((service as any).getIntervalMs()).toBe(120000);
    expect((service as any).budgets).toEqual({ maxScanned: 1000, maxMatched: 10 });
    expect((service as any).sampleSize).toBe(5);
    expect((service as any).undetectedRecheckMs).toBe(600000);
  });
});
