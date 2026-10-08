import { Feature } from '@betterdb/shared';
import { KvCacheFootprintService } from '../kv-cache-footprint.service';

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
  return { service, storage, client, registry };
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

  it('does not start without a licence', async () => {
    const { service } = setup(undefined, false);
    const start = jest.spyOn(service as any, 'start');
    await service.onModuleInit();
    expect(start).not.toHaveBeenCalled();
  });

  it('deletes stored data when a connection is removed', () => {
    const { service, storage } = setup();
    (service as any).onConnectionRemoved('c1');
    expect(storage.deleteKvCacheConnectionData).toHaveBeenCalledWith('c1');
  });
});
