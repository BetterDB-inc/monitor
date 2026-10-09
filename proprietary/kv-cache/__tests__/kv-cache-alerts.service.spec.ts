import type { KvCacheFootprintSnapshot } from '@betterdb/shared';
import { KvCacheAlertsService } from '../kv-cache-alerts.service';

const snapshot = (over: Partial<KvCacheFootprintSnapshot> = {}): KvCacheFootprintSnapshot =>
  ({
    connectionId: 'c1',
    timestamp: 5,
    detected: true,
    usedMemory: 95,
    maxmemory: 100,
    maxmemoryPolicy: 'volatile-lru',
    lmcacheMemoryShare: 0.6,
    noTtlRatio: 0.95,
    evictedKeysDelta: 0,
    ...over,
  }) as KvCacheFootprintSnapshot;

const engine = (over: Record<string, unknown> = {}) => ({ id: 'e1', connectionId: 'c1', name: 'vllm', enabled: true, ...over });

const row = (over: Record<string, unknown> = {}) => ({
  connectionId: 'c1',
  engineId: 'e1',
  modelName: 'm',
  timestamp: 1,
  requestedTokens: 20000,
  hitTokens: 2000,
  ...over,
});

function setup(opts: { licensed?: boolean; engines?: unknown[]; stored?: unknown; rows?: unknown } = {}) {
  const storage = {
    getKvCacheSettings: jest.fn().mockResolvedValue(opts.stored ?? null),
    saveKvCacheSettings: jest.fn().mockImplementation(async (s) => s),
    getKvCacheEngineSamples: jest.fn().mockResolvedValue(opts.rows ?? [row()]),
  };
  const connectionRegistry = { getConfig: jest.fn().mockReturnValue({ host: 'h', port: 6379 }) };
  let listener: ((s: KvCacheFootprintSnapshot) => void) | undefined;
  const footprint = { onSnapshot: jest.fn().mockImplementation((l) => (listener = l)) };
  const registry = {
    list: jest.fn().mockReturnValue(opts.engines ?? [engine()]),
    get: jest.fn().mockImplementation((id: string) => (opts.engines ?? [engine()]).find((e: any) => e.id === id) ?? null),
  };
  const license = { hasFeature: jest.fn().mockReturnValue(opts.licensed ?? true) };
  const pro = {
    dispatchKvCacheHitRateLow: jest.fn().mockResolvedValue(undefined),
    dispatchKvCacheEvictionRisk: jest.fn().mockResolvedValue(undefined),
  };
  const service = new KvCacheAlertsService(
    storage as any,
    connectionRegistry as any,
    footprint as any,
    registry as any,
    license as any,
    pro as any,
  );
  return { storage, connectionRegistry, footprint, registry, license, pro, service, emit: (s: KvCacheFootprintSnapshot) => listener?.(s) };
}

describe('KvCacheAlertsService settings', () => {
  it('returns defaults when nothing is stored', async () => {
    const { service } = setup();
    expect(await service.getSettings('c1')).toEqual({
      connectionId: 'c1',
      hitRateAlertEnabled: true,
      hitRateThreshold: 0.2,
      evictionAlertEnabled: true,
      updatedAt: 0,
    });
  });

  it('merges updates onto the current settings and stamps the time', async () => {
    const { service, storage } = setup({
      stored: { connectionId: 'c1', hitRateAlertEnabled: true, hitRateThreshold: 0.2, evictionAlertEnabled: true, updatedAt: 1 },
    });
    const saved = await service.updateSettings('c1', { hitRateThreshold: 0.4 });
    expect(saved).toMatchObject({ connectionId: 'c1', hitRateAlertEnabled: true, hitRateThreshold: 0.4, evictionAlertEnabled: true });
    expect(saved.updatedAt).toBeGreaterThan(1);
    expect(storage.saveKvCacheSettings).toHaveBeenCalledWith(saved);
  });
});

describe('KvCacheAlertsService eviction risk', () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it('subscribes to footprint snapshots on init and dispatches both reasons', async () => {
    const { service, pro, emit } = setup();
    service.onModuleInit();
    emit(snapshot());
    await flush();
    service.onModuleDestroy();
    expect(pro.dispatchKvCacheEvictionRisk).toHaveBeenCalledTimes(2);
    expect(pro.dispatchKvCacheEvictionRisk).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'c1',
        reason: 'unevictable',
        active: true,
        policy: 'volatile-lru',
        instance: { host: 'h', port: 6379 },
        timestamp: 5,
      }),
    );
    expect(pro.dispatchKvCacheEvictionRisk).toHaveBeenCalledWith(expect.objectContaining({ reason: 'evicting', active: false }));
  });

  it('omits the instance when the connection is unknown', async () => {
    const { service, pro, connectionRegistry } = setup();
    connectionRegistry.getConfig.mockReturnValue(null);
    await service.onSnapshot(snapshot());
    expect(pro.dispatchKvCacheEvictionRisk.mock.calls[0][0]).not.toHaveProperty('instance');
  });

  it('sends nothing when eviction alerts are disabled', async () => {
    const { service, pro } = setup({
      stored: { connectionId: 'c1', hitRateAlertEnabled: true, hitRateThreshold: 0.2, evictionAlertEnabled: false, updatedAt: 1 },
    });
    await service.onSnapshot(snapshot());
    expect(pro.dispatchKvCacheEvictionRisk).not.toHaveBeenCalled();
  });

  it('sends nothing when unlicensed', async () => {
    const { service, pro } = setup({ licensed: false });
    await service.onSnapshot(snapshot());
    expect(pro.dispatchKvCacheEvictionRisk).not.toHaveBeenCalled();
  });
});

describe('KvCacheAlertsService hit rate', () => {
  it('dispatches for a window below the floor of tokens with a low rate', async () => {
    const { service, pro, storage } = setup();
    await service.evaluateHitRates(1_000_000);
    expect(storage.getKvCacheEngineSamples).toHaveBeenCalledWith({ connectionId: 'c1', from: 1_000_000 - 900_000, to: 1_000_000 });
    expect(pro.dispatchKvCacheHitRateLow).toHaveBeenCalledWith({
      connectionId: 'c1',
      engineId: 'e1',
      engineName: 'vllm',
      model: 'm',
      hitRate: 0.1,
      threshold: 0.2,
      requestedTokens: 20000,
      windowMs: 900_000,
      timestamp: 1_000_000,
      instance: { host: 'h', port: 6379 },
    });
  });

  it('skips windows under the token floor', async () => {
    const { service, pro } = setup({ rows: [row({ requestedTokens: 5000, hitTokens: 100 })] });
    await service.evaluateHitRates(1);
    expect(pro.dispatchKvCacheHitRateLow).not.toHaveBeenCalled();
  });

  it('skips disabled engines', async () => {
    const { service, pro, storage } = setup({ engines: [engine({ enabled: false })] });
    await service.evaluateHitRates(1);
    expect(storage.getKvCacheEngineSamples).not.toHaveBeenCalled();
    expect(pro.dispatchKvCacheHitRateLow).not.toHaveBeenCalled();
  });

  it('skips samples of engines that are no longer registered', async () => {
    const { service, pro } = setup({ rows: [row({ engineId: 'gone' })] });
    await service.evaluateHitRates(1);
    expect(pro.dispatchKvCacheHitRateLow).not.toHaveBeenCalled();
  });

  it('does nothing when unlicensed', async () => {
    const { service, pro, storage } = setup({ licensed: false });
    await service.evaluateHitRates(1);
    expect(storage.getKvCacheEngineSamples).not.toHaveBeenCalled();
    expect(pro.dispatchKvCacheHitRateLow).not.toHaveBeenCalled();
  });

  it('continues with the next connection after a storage error', async () => {
    const engines = [engine(), engine({ id: 'e2', connectionId: 'c2', name: 'other' })];
    const { service, pro, storage } = setup({ engines });
    storage.getKvCacheEngineSamples
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([row({ connectionId: 'c2', engineId: 'e2' })]);
    await service.evaluateHitRates(1);
    expect(pro.dispatchKvCacheHitRateLow).toHaveBeenCalledTimes(1);
    expect(pro.dispatchKvCacheHitRateLow).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'c2', engineId: 'e2' }));
  });
});
