import { Feature } from '@betterdb/shared';
import { KvCacheFootprintService, resolvePositiveInt } from '../kv-cache-footprint.service';

const KEY = (i: number) => `m/x@1@0@${(i + 1).toString(16)}@bfloat16`;

function fakeClient(keys: string[]) {
  const pipeline = { call: jest.fn().mockReturnThis(), ttl: jest.fn().mockReturnThis(), exists: jest.fn().mockReturnThis(), exec: jest.fn() };
  pipeline.exec.mockImplementation(async () => keys.flatMap(() => [[null, 100], [null, -1]]));
  return {
    getDbSize: jest.fn().mockResolvedValue(keys.length),
    call: jest.fn(async (cmd: string) => (cmd === 'SCAN' ? ['0', keys] : 'id=1 lib-name=redis-py\n')),
    getClient: () => ({ pipeline: () => pipeline }),
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
  const registry = {
    list: jest.fn().mockReturnValue([{ id: 'c1', name: 'one', isConnected: true, connectionType: 'direct' }]),
    get: jest.fn().mockReturnValue(client),
    getConfig: jest.fn().mockReturnValue({ id: 'c1', name: 'one', host: 'h', port: 6379, dbIndex: 0 }),
  } as any;
  const storage = { saveKvCacheFootprintSnapshot: jest.fn(), deleteKvCacheConnectionData: jest.fn().mockResolvedValue(undefined) } as any;
  const license = { hasFeature: jest.fn((f: string) => licensed && f === Feature.KV_CACHE_MONITORING) } as any;
  const service = new KvCacheFootprintService(registry, storage, license);
  return { service, storage, client, registry, license };
}

describe('KvCacheFootprintService', () => {
  it('collects, stores and announces a snapshot', async () => {
    const { service, storage } = setup();
    const listener = jest.fn();
    service.onSnapshot(listener);
    const snapshot = await service.triggerCollection('c1');
    expect(snapshot).toMatchObject({ connectionId: 'c1', detected: true, matchedKeys: 6, chunksEst: 6, evictedKeysDelta: null });
    expect(storage.saveKvCacheFootprintSnapshot).toHaveBeenCalledWith(snapshot);
    expect(listener).toHaveBeenCalledWith(snapshot);
    expect(service.getSampleKey('c1')).toBe('m/x@1@0@1…@bfloat16');
  });

  it('reports the eviction delta on the second run', async () => {
    const { service } = setup();
    await service.triggerCollection('c1');
    expect((await service.triggerCollection('c1'))?.evictedKeysDelta).toBe(0);
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
    expect(start).toHaveBeenCalled();
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
    await (service as any).tick();
    registry.list.mockReturnValue([]);
    await (service as any).tick();
    expect(storage.deleteKvCacheConnectionData).toHaveBeenCalledWith('c1');
    expect(storage.saveKvCacheFootprintSnapshot).not.toHaveBeenCalled();
  });

  it('deletes stored data when a connection is removed', () => {
    const { service, storage } = setup();
    (service as any).onConnectionRemoved('c1');
    expect(storage.deleteKvCacheConnectionData).toHaveBeenCalledWith('c1');
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

  it('accepts a value at or above the floor', () => {
    expect(resolvePositiveInt('60000', 300000, 60000)).toBe(60000);
    expect(resolvePositiveInt('1', 2000, 1)).toBe(1);
    expect(resolvePositiveInt('750', 500, 1)).toBe(750);
  });
});

describe('KvCacheFootprintService settings', () => {
  const keys = ['KV_CACHE_FOOTPRINT_INTERVAL_MS', 'KV_CACHE_SCAN_MAX_KEYS', 'KV_CACHE_MATCH_MAX_KEYS', 'KV_CACHE_SAMPLE_KEYS'];
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
    const { service } = setup();
    expect((service as any).getIntervalMs()).toBe(300000);
    expect((service as any).budgets).toEqual({ maxScanned: 200000, maxMatched: 2000 });
    expect((service as any).sampleSize).toBe(500);
  });

  it('keeps valid settings', () => {
    process.env.KV_CACHE_FOOTPRINT_INTERVAL_MS = '120000';
    process.env.KV_CACHE_SCAN_MAX_KEYS = '1000';
    process.env.KV_CACHE_MATCH_MAX_KEYS = '10';
    process.env.KV_CACHE_SAMPLE_KEYS = '5';
    const { service } = setup();
    expect((service as any).getIntervalMs()).toBe(120000);
    expect((service as any).budgets).toEqual({ maxScanned: 1000, maxMatched: 10 });
    expect((service as any).sampleSize).toBe(5);
  });
});
