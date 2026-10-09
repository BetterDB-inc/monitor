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
  let removalListener: ((id: string) => void) | undefined;
  const footprint = {
    onSnapshot: jest.fn().mockImplementation((l) => (listener = l)),
    onConnectionRemoval: jest.fn().mockImplementation((l) => (removalListener = l)),
  };
  const prometheus = { setKvCacheFootprint: jest.fn(), setKvCacheHitRates: jest.fn(), clearKvCache: jest.fn() };
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
    prometheus as any,
  );
  return {
    storage,
    connectionRegistry,
    footprint,
    registry,
    license,
    pro,
    prometheus,
    service,
    emit: (s: KvCacheFootprintSnapshot) => listener?.(s),
    remove: (id: string) => removalListener?.(id),
  };
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

  it('keeps the stored value when an update field is undefined', async () => {
    const { service } = setup({
      stored: { connectionId: 'c1', hitRateAlertEnabled: true, hitRateThreshold: 0.3, evictionAlertEnabled: true, updatedAt: 1 },
    });
    const saved = await service.updateSettings('c1', { hitRateThreshold: undefined });
    expect(saved.hitRateThreshold).toBe(0.3);
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
    const { service, pro, prometheus } = setup({ engines: [engine({ enabled: false })] });
    await service.evaluateHitRates(1);
    expect(pro.dispatchKvCacheHitRateLow).not.toHaveBeenCalled();
    expect(prometheus.setKvCacheHitRates).toHaveBeenCalledWith('c1', []);
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

  it('only dispatches for the enabled engine when a sibling is disabled', async () => {
    const engines = [engine(), engine({ id: 'e2', name: 'off', enabled: false })];
    const { service, pro } = setup({ engines, rows: [row(), row({ engineId: 'e2' })] });
    await service.evaluateHitRates(1);
    expect(pro.dispatchKvCacheHitRateLow).toHaveBeenCalledTimes(1);
    expect(pro.dispatchKvCacheHitRateLow).toHaveBeenCalledWith(expect.objectContaining({ engineId: 'e1' }));
  });

  it('continues with the next window after a failed dispatch', async () => {
    const engines = [engine(), engine({ id: 'e2', name: 'second' })];
    const { service, pro } = setup({ engines, rows: [row(), row({ engineId: 'e2' })] });
    pro.dispatchKvCacheHitRateLow.mockRejectedValueOnce(new Error('boom'));
    await service.evaluateHitRates(1);
    expect(pro.dispatchKvCacheHitRateLow).toHaveBeenCalledTimes(2);
  });

  it('never rejects when the registry throws', async () => {
    const { service, registry } = setup();
    registry.list.mockImplementation(() => {
      throw new Error('boom');
    });
    await expect(service.evaluateHitRates(1)).resolves.toBeUndefined();
  });
});

describe('KvCacheAlertsService Prometheus export', () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const perModel = [{ model: 'm', dtype: 'bfloat16', chunksEst: 3, bytesEst: 300 }];

  it('sets footprint gauges from a snapshot', async () => {
    const { service, prometheus, emit } = setup();
    service.onModuleInit();
    emit(snapshot({ perModel }));
    await flush();
    service.onModuleDestroy();
    expect(prometheus.setKvCacheFootprint).toHaveBeenCalledWith('c1', perModel);
  });

  it('sets footprint gauges even when eviction alerts are disabled', async () => {
    const { service, prometheus } = setup({
      stored: { connectionId: 'c1', hitRateAlertEnabled: true, hitRateThreshold: 0.2, evictionAlertEnabled: false, updatedAt: 1 },
    });
    await service.onSnapshot(snapshot({ perModel }));
    expect(prometheus.setKvCacheFootprint).toHaveBeenCalledWith('c1', perModel);
  });

  it('does not set footprint gauges when unlicensed', async () => {
    const { service, prometheus } = setup({ licensed: false });
    await service.onSnapshot(snapshot({ perModel }));
    expect(prometheus.setKvCacheFootprint).not.toHaveBeenCalled();
  });

  it('sets hit rates with the engine name', async () => {
    const { service, prometheus } = setup();
    await service.evaluateHitRates(1);
    expect(prometheus.setKvCacheHitRates).toHaveBeenCalledWith('c1', [{ engine: 'vllm', model: 'm', hitRate: 0.1 }]);
  });

  it('sets hit rates when hit rate alerts are disabled', async () => {
    const { service, prometheus, pro } = setup({
      stored: { connectionId: 'c1', hitRateAlertEnabled: false, hitRateThreshold: 0.2, evictionAlertEnabled: true, updatedAt: 1 },
    });
    await service.evaluateHitRates(1);
    expect(pro.dispatchKvCacheHitRateLow).not.toHaveBeenCalled();
    expect(prometheus.setKvCacheHitRates).toHaveBeenCalledWith('c1', [{ engine: 'vllm', model: 'm', hitRate: 0.1 }]);
  });

  it('sets hit rates even when dispatch fails', async () => {
    const { service, prometheus, pro } = setup();
    pro.dispatchKvCacheHitRateLow.mockRejectedValue(new Error('boom'));
    await service.evaluateHitRates(1);
    expect(prometheus.setKvCacheHitRates).toHaveBeenCalledWith('c1', [{ engine: 'vllm', model: 'm', hitRate: 0.1 }]);
  });

  it('exports an empty list when there are no windows', async () => {
    const { service, prometheus } = setup({ rows: [] });
    await service.evaluateHitRates(1);
    expect(prometheus.setKvCacheHitRates).toHaveBeenCalledWith('c1', []);
  });

  it('excludes windows with a null hit rate', async () => {
    const { service, prometheus } = setup({ rows: [row({ requestedTokens: 0, hitTokens: 0 })] });
    await service.evaluateHitRates(1);
    expect(prometheus.setKvCacheHitRates).toHaveBeenCalledWith('c1', []);
  });

  it('excludes windows of disabled engines', async () => {
    const engines = [engine(), engine({ id: 'e2', name: 'off', enabled: false })];
    const { service, prometheus } = setup({ engines, rows: [row(), row({ engineId: 'e2' })] });
    await service.evaluateHitRates(1);
    expect(prometheus.setKvCacheHitRates).toHaveBeenCalledWith('c1', [{ engine: 'vllm', model: 'm', hitRate: 0.1 }]);
  });

  it('excludes windows of engines that are no longer registered', async () => {
    const { service, prometheus } = setup({ rows: [row({ engineId: 'gone' })] });
    await service.evaluateHitRates(1);
    expect(prometheus.setKvCacheHitRates).toHaveBeenCalledWith('c1', []);
  });

  it('exports an empty list once the last engine of a connection is removed', async () => {
    const { service, prometheus, registry } = setup();
    await service.evaluateHitRates(1);
    registry.list.mockReturnValue([]);
    registry.get.mockReturnValue(null);
    prometheus.setKvCacheHitRates.mockClear();
    await service.evaluateHitRates(2);
    expect(prometheus.setKvCacheHitRates).toHaveBeenCalledWith('c1', []);
    prometheus.setKvCacheHitRates.mockClear();
    await service.evaluateHitRates(3);
    expect(prometheus.setKvCacheHitRates).not.toHaveBeenCalled();
  });

  it('does not export hit rates when unlicensed', async () => {
    const { service, prometheus } = setup({ licensed: false });
    await service.evaluateHitRates(1);
    expect(prometheus.setKvCacheHitRates).not.toHaveBeenCalled();
  });

  it('clears the connection series on connection removal', () => {
    const { service, prometheus, remove } = setup();
    service.onModuleInit();
    remove('c1');
    service.onModuleDestroy();
    expect(prometheus.clearKvCache).toHaveBeenCalledWith('c1');
  });
});
