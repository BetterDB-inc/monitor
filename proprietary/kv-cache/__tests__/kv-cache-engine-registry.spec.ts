import { KvCacheEngineRegistry } from '../kv-cache-engine-registry';

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
  let removal: (id: string) => void = () => undefined;
  const footprint = { onConnectionRemoval: jest.fn((l) => (removal = l)) } as any;
  const registry = new KvCacheEngineRegistry(storage, footprint);
  return { registry, storage, removal: (id: string) => removal(id) };
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

  it('records results in memory and persists them', async () => {
    const { registry, storage } = setup();
    await registry.onModuleInit();
    registry.recordResult('a', { lastSeenAt: 99, lastError: 'boom' });
    expect(registry.get('a')).toMatchObject({ lastSeenAt: 99, lastError: 'boom' });
    expect(storage.saveKvCacheEngine).toHaveBeenCalledWith(expect.objectContaining({ id: 'a', lastError: 'boom' }));
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

  it('removes from storage and memory', async () => {
    const { registry, storage } = setup();
    await registry.onModuleInit();
    await expect(registry.remove('a')).resolves.toBe(true);
    expect(storage.deleteKvCacheEngine).toHaveBeenCalledWith('a');
    expect(registry.get('a')).toBeNull();
  });

  it('drops only the removed connection engines on broadcast', async () => {
    const { registry, removal } = setup();
    await registry.onModuleInit();
    removal('c1');
    expect(registry.list().map((e) => e.id)).toEqual(['b']);
  });
});
