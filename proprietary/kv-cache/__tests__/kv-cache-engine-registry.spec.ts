import { NotFoundException } from '@nestjs/common';
import { KV_CACHE_LAST_SEEN_PERSIST_MS, KvCacheEngineRegistry, REMOVAL_TOMBSTONE_MS } from '../kv-cache-engine-registry';

const engine = (id: string, connectionId: string, otlpEngineId: string | null = null) => ({
  id, connectionId, name: id, source: 'otlp' as const, scrapeUrl: null, scrapeAuthHeader: null,
  scrapeAuthEncrypted: false, otlpEngineId, enabled: true, createdAt: 1, lastSeenAt: null, lastError: null,
});

function setup(initial = [engine('a', 'c1', 'lmc-a'), engine('b', 'c2')]) {
  const storage = {
    getKvCacheEngines: jest.fn().mockResolvedValue(initial),
    saveKvCacheEngine: jest.fn().mockImplementation(async (e) => e),
    deleteKvCacheEngine: jest.fn().mockResolvedValue(true),
  } as any;
  let removal: (id: string) => unknown = () => undefined;
  const footprint = { onConnectionRemoval: jest.fn((l) => (removal = l)) } as any;
  const samples = { forgetEngine: jest.fn(), idle: jest.fn().mockResolvedValue(undefined) } as any;
  const registry = new KvCacheEngineRegistry(storage, footprint, samples);
  return { registry, storage, samples, removal: (id: string) => removal(id) };
}

describe('KvCacheEngineRegistry', () => {
  it('loads engines from storage and finds them', async () => {
    const { registry } = setup();
    await registry.onModuleInit();
    expect(registry.list()).toHaveLength(2);
    expect(registry.list('c1').map((e) => e.id)).toEqual(['a']);
    expect(registry.get('b')?.connectionId).toBe('c2');
    expect(registry.get('zzz')).toBeNull();
    expect(registry.byOtlpId('lmc-a')?.id).toBe('a');
    expect(registry.byOtlpId('nope')).toBeNull();
  });

  it('writes storage before memory', async () => {
    const { registry, storage } = setup([]);
    await registry.onModuleInit();
    storage.saveKvCacheEngine.mockRejectedValueOnce(new Error('disk'));
    await expect(registry.save(engine('x', 'c1'))).rejects.toThrow('disk');
    expect(registry.get('x')).toBeNull();
    await registry.save(engine('x', 'c1'));
    expect(registry.get('x')).not.toBeNull();
  });

  it('rejects saves for a connection that has been removed', async () => {
    const { registry, storage, removal } = setup();
    await registry.onModuleInit();
    await removal('c1');
    await expect(registry.save(engine('late', 'c1'))).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.saveKvCacheEngine).not.toHaveBeenCalled();
    expect(registry.get('late')).toBeNull();
    await expect(registry.save(engine('ok', 'c2'))).resolves.toMatchObject({ id: 'ok' });
  });

  it('drops an engine whose save was in flight when its connection was removed', async () => {
    const { registry, storage, removal } = setup();
    await registry.onModuleInit();
    let finishSave: () => void = () => undefined;
    storage.saveKvCacheEngine.mockImplementationOnce((e: any) => new Promise((resolve) => (finishSave = () => resolve(e))));
    const pending = registry.save(engine('racing', 'c1'));
    await new Promise((resolve) => setImmediate(resolve));
    await removal('c1');
    finishSave();
    await expect(pending).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.deleteKvCacheEngine).toHaveBeenCalledWith('racing');
    expect(registry.get('racing')).toBeNull();
  });

  it('expires removal tombstones once they are older than the tombstone window', async () => {
    const { registry, removal } = setup();
    await registry.onModuleInit();
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      await registry.remove('a');
      await removal('c2');
      await expect(registry.save(engine('a', 'c1'))).rejects.toBeInstanceOf(NotFoundException);
      await expect(registry.save(engine('x', 'c2'))).rejects.toBeInstanceOf(NotFoundException);
      now.mockReturnValue(1_000 + REMOVAL_TOMBSTONE_MS + 1);
      await registry.remove('zzz');
      await removal('c9');
      await expect(registry.save(engine('a', 'c1'))).resolves.toMatchObject({ id: 'a' });
      await expect(registry.save(engine('x', 'c2'))).resolves.toMatchObject({ id: 'x' });
    } finally {
      now.mockRestore();
    }
  });

  it('records results in memory and persists them', async () => {
    const { registry, storage } = setup();
    await registry.onModuleInit();
    registry.recordResult('a', { lastSeenAt: 99, lastError: 'boom' });
    expect(registry.get('a')).toMatchObject({ lastSeenAt: 99, lastError: 'boom' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(storage.saveKvCacheEngine).toHaveBeenCalledWith(expect.objectContaining({ id: 'a', lastError: 'boom' }));
  });

  it('persists repeated successful results only when lastSeenAt is stale or the error changes', async () => {
    const { registry, storage } = setup();
    await registry.onModuleInit();
    const flush = () => new Promise((resolve) => setImmediate(resolve));
    registry.recordResult('a', { lastSeenAt: 1_000, lastError: null });
    await flush();
    expect(storage.saveKvCacheEngine).toHaveBeenCalledTimes(1);
    registry.recordResult('a', { lastSeenAt: 31_000, lastError: null });
    registry.recordResult('a', { lastSeenAt: 61_000, lastError: null });
    await flush();
    expect(storage.saveKvCacheEngine).toHaveBeenCalledTimes(1);
    expect(registry.get('a')?.lastSeenAt).toBe(61_000);
    registry.recordResult('a', { lastSeenAt: 91_000, lastError: 'timeout' });
    await flush();
    expect(storage.saveKvCacheEngine).toHaveBeenCalledTimes(2);
    registry.recordResult('a', { lastError: 'timeout' });
    await flush();
    expect(storage.saveKvCacheEngine).toHaveBeenCalledTimes(2);
    registry.recordResult('a', { lastSeenAt: 91_000 + KV_CACHE_LAST_SEEN_PERSIST_MS, lastError: 'timeout' });
    await flush();
    expect(storage.saveKvCacheEngine).toHaveBeenCalledTimes(3);
  });

  it('keeps lastSeenAt when a result omits it and survives persist failures', async () => {
    const { registry, storage } = setup();
    await registry.onModuleInit();
    registry.recordResult('a', { lastSeenAt: 5, lastError: null });
    storage.saveKvCacheEngine.mockRejectedValueOnce(new Error('disk'));
    registry.recordResult('a', { lastError: 'x' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(registry.get('a')).toMatchObject({ lastSeenAt: 5, lastError: 'x' });
  });

  it('persists a result raised during an update with the updated fields', async () => {
    const { registry, storage } = setup();
    await registry.onModuleInit();
    let finishSave: () => void = () => undefined;
    storage.saveKvCacheEngine.mockImplementationOnce((e: any) => new Promise((resolve) => (finishSave = () => resolve(e))));
    const pending = registry.save({ ...engine('a', 'c1', 'lmc-a'), name: 'renamed' });
    registry.recordResult('a', { lastSeenAt: 7, lastError: null });
    await new Promise((resolve) => setImmediate(resolve));
    finishSave();
    await pending;
    await new Promise((resolve) => setImmediate(resolve));
    expect(storage.saveKvCacheEngine).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'a', name: 'renamed' }));
    expect(registry.get('a')?.name).toBe('renamed');
  });

  it('keeps the probe result of a URL change over an old-URL scrape that lands during the save', async () => {
    const scraped = { ...engine('s', 'c1'), source: 'scrape' as const, scrapeUrl: 'http://old/metrics' };
    const { registry, storage } = setup([scraped as any]);
    await registry.onModuleInit();
    let finishSave: () => void = () => undefined;
    storage.saveKvCacheEngine.mockImplementationOnce((e: any) => new Promise((resolve) => (finishSave = () => resolve(e))));
    const pending = registry.save({ ...scraped, scrapeUrl: 'http://new/metrics', lastSeenAt: 9, lastError: null } as any);
    await new Promise((resolve) => setImmediate(resolve));
    registry.recordResult('s', { lastError: 'HTTP 401' });
    finishSave();
    await pending;
    await new Promise((resolve) => setImmediate(resolve));
    expect(registry.get('s')).toMatchObject({ scrapeUrl: 'http://new/metrics', lastSeenAt: 9, lastError: null });
    expect(storage.saveKvCacheEngine).toHaveBeenLastCalledWith(expect.objectContaining({ scrapeUrl: 'http://new/metrics', lastError: null }));
  });

  it('keeps a scrape result that lands during an update', async () => {
    const { registry, storage } = setup();
    await registry.onModuleInit();
    let finishSave: () => void = () => undefined;
    storage.saveKvCacheEngine.mockImplementationOnce((e: any) => new Promise((resolve) => (finishSave = () => resolve(e))));
    const pending = registry.save({ ...engine('a', 'c1', 'lmc-a'), name: 'renamed' });
    await new Promise((resolve) => setImmediate(resolve));
    registry.recordResult('a', { lastSeenAt: 7, lastError: 'boom' });
    finishSave();
    await pending;
    await new Promise((resolve) => setImmediate(resolve));
    expect(registry.get('a')).toMatchObject({ name: 'renamed', lastSeenAt: 7, lastError: 'boom' });
    expect(storage.saveKvCacheEngine).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'renamed', lastSeenAt: 7, lastError: 'boom' }));
  });

  it('waits for in-flight writes on connection removal and never writes the engine again', async () => {
    const { registry, storage, removal } = setup();
    await registry.onModuleInit();
    let finishSave: () => void = () => undefined;
    storage.saveKvCacheEngine.mockImplementationOnce((e: any) => new Promise((resolve) => (finishSave = () => resolve(e))));
    const pending = registry.save({ ...engine('a', 'c1', 'lmc-a'), name: 'renamed' });
    await new Promise((resolve) => setImmediate(resolve));
    let removed = false;
    const removing = Promise.resolve(removal('c1')).then(() => (removed = true));
    await new Promise((resolve) => setImmediate(resolve));
    expect(removed).toBe(false);
    finishSave();
    await expect(pending).rejects.toBeInstanceOf(NotFoundException);
    await removing;
    expect(storage.deleteKvCacheEngine).toHaveBeenCalledWith('a');
    expect(registry.get('a')).toBeNull();
    await expect(registry.save(engine('a', 'c1', 'lmc-a'))).rejects.toBeInstanceOf(NotFoundException);
    registry.recordResult('a', { lastSeenAt: 9, lastError: null });
    await new Promise((resolve) => setImmediate(resolve));
    expect(storage.saveKvCacheEngine).toHaveBeenCalledTimes(1);
    expect(registry.get('a')).toBeNull();
  });

  it('does not resurrect an engine removed while a result was pending', async () => {
    const { registry, storage } = setup();
    await registry.onModuleInit();
    registry.recordResult('a', { lastSeenAt: 7, lastError: null });
    await registry.remove('a');
    registry.recordResult('a', { lastSeenAt: 8, lastError: null });
    await new Promise((resolve) => setImmediate(resolve));
    expect(storage.saveKvCacheEngine).not.toHaveBeenCalled();
    expect(registry.get('a')).toBeNull();
  });

  it('rejects a save whose write was in flight when the engine was deleted', async () => {
    const { registry, storage } = setup();
    await registry.onModuleInit();
    let finishSave: () => void = () => undefined;
    storage.saveKvCacheEngine.mockImplementationOnce((e: any) => new Promise((resolve) => (finishSave = () => resolve(e))));
    const saving = registry.save({ ...engine('a', 'c1', 'lmc-a'), name: 'renamed' });
    await new Promise((resolve) => setImmediate(resolve));
    const removing = registry.remove('a');
    finishSave();
    await expect(saving).rejects.toBeInstanceOf(NotFoundException);
    await expect(removing).resolves.toBe(true);
    expect(storage.deleteKvCacheEngine).toHaveBeenCalledWith('a');
    expect(registry.get('a')).toBeNull();
  });

  it('rejects a save queued behind a pending delete and does not re-insert the engine', async () => {
    const { registry, storage } = setup();
    await registry.onModuleInit();
    let finishDelete: () => void = () => undefined;
    storage.deleteKvCacheEngine.mockImplementationOnce(() => new Promise((resolve) => (finishDelete = () => resolve(true))));
    const removing = registry.remove('a');
    const saving = registry.save({ ...engine('a', 'c1', 'lmc-a'), name: 'renamed' });
    await new Promise((resolve) => setImmediate(resolve));
    finishDelete();
    await removing;
    await expect(saving).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.saveKvCacheEngine).not.toHaveBeenCalled();
    expect(registry.get('a')).toBeNull();
  });

  it('keeps a scrape result recorded after a save was queued behind another write', async () => {
    const { registry, storage } = setup();
    await registry.onModuleInit();
    let finishPersist: () => void = () => undefined;
    storage.saveKvCacheEngine.mockImplementationOnce((e: any) => new Promise((resolve) => (finishPersist = () => resolve(e))));
    registry.recordResult('a', { lastSeenAt: 5, lastError: null });
    const stale = { ...registry.get('a')!, name: 'renamed' };
    const saving = registry.save(stale);
    registry.recordResult('a', { lastSeenAt: 9, lastError: 'boom' });
    await new Promise((resolve) => setImmediate(resolve));
    finishPersist();
    await saving;
    await new Promise((resolve) => setImmediate(resolve));
    expect(registry.get('a')).toMatchObject({ name: 'renamed', lastSeenAt: 9, lastError: 'boom' });
  });

  it('removes from storage and memory', async () => {
    const { registry, storage } = setup();
    await registry.onModuleInit();
    await expect(registry.remove('a')).resolves.toBe(true);
    expect(storage.deleteKvCacheEngine).toHaveBeenCalledWith('a');
    expect(registry.get('a')).toBeNull();
  });

  it('keeps an engine saveable and persisting results after a failed delete', async () => {
    const { registry, storage } = setup();
    await registry.onModuleInit();
    storage.deleteKvCacheEngine.mockRejectedValueOnce(new Error('disk'));
    await expect(registry.remove('a')).rejects.toThrow('disk');
    expect(registry.get('a')).not.toBeNull();
    await registry.save({ ...engine('a', 'c1', 'lmc-a'), name: 'renamed' });
    expect(storage.saveKvCacheEngine).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'a', name: 'renamed' }));
    expect(registry.get('a')?.name).toBe('renamed');
    registry.recordResult('a', { lastSeenAt: 11, lastError: null });
    await new Promise((resolve) => setImmediate(resolve));
    expect(storage.saveKvCacheEngine).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'a', lastSeenAt: 11 }));
  });

  it('drops only the removed connection engines on broadcast', async () => {
    const { registry, samples, removal } = setup();
    await registry.onModuleInit();
    removal('c1');
    expect(registry.list().map((e) => e.id)).toEqual(['b']);
    expect(samples.forgetEngine).toHaveBeenCalledTimes(1);
    expect(samples.forgetEngine).toHaveBeenCalledWith('a');
  });
});
