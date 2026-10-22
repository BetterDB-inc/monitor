import { Logger } from '@nestjs/common';
import type { KvCacheFootprintSnapshot } from '@betterdb/shared';
import { KvCacheAlertsService } from '../kv-cache-alerts.service';

const snapshot = (over: Partial<KvCacheFootprintSnapshot> = {}): KvCacheFootprintSnapshot =>
  ({
    connectionId: 'c1',
    timestamp: 5,
    detected: true,
    scanComplete: true,
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
  const prometheus = { setKvCacheFootprint: jest.fn(), setKvCacheHitRates: jest.fn(), clearKvCache: jest.fn(), clearAllKvCache: jest.fn() };
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

  it('does not hold the snapshot on webhook delivery and logs a failed dispatch', async () => {
    const { service, pro } = setup();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    pro.dispatchKvCacheEvictionRisk.mockReturnValueOnce(new Promise(() => undefined)).mockRejectedValueOnce(new Error('receiver down'));
    await expect(service.onSnapshot(snapshot())).resolves.toBeUndefined();
    expect(pro.dispatchKvCacheEvictionRisk).toHaveBeenCalledTimes(2);
    await flush();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('receiver down'));
    warn.mockRestore();
  });

  it('holds the evicting alert until three clean snapshots in a row', async () => {
    const { service, pro } = setup();
    const evictingStates = () =>
      pro.dispatchKvCacheEvictionRisk.mock.calls.filter(([e]) => e.reason === 'evicting').map(([e]) => e.active);
    for (const delta of [50, 0, 30, 0, 0, 0, 0]) await service.onSnapshot(snapshot({ evictedKeysDelta: delta }));
    expect(evictingStates()).toEqual([true, true, true, true, true, false, false]);
  });

  it('keeps the evicting state when a snapshot only read some nodes', async () => {
    const { service, pro } = setup();
    const evictingStates = () =>
      pro.dispatchKvCacheEvictionRisk.mock.calls.filter(([e]) => e.reason === 'evicting').map(([e]) => e.active);
    await service.onSnapshot(snapshot({ evictedKeysDelta: 50 }), { partial: true });
    await service.onSnapshot(snapshot({ evictedKeysDelta: 50 }));
    for (let i = 0; i < 3; i += 1) await service.onSnapshot(snapshot({ evictedKeysDelta: 0 }), { partial: true });
    await service.onSnapshot(snapshot({ evictedKeysDelta: 0 }));
    expect(evictingStates()).toEqual([false, true, true, true, true, true]);
  });

  it('keeps the evicting state when a partial snapshot does not detect LMCache', async () => {
    const { service, pro } = setup();
    await service.onSnapshot(snapshot({ evictedKeysDelta: 50 }));
    await service.onSnapshot(snapshot({ detected: false, evictedKeysDelta: 0 }), { partial: true });
    expect(pro.dispatchKvCacheEvictionRisk).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'evicting', active: true }));
  });

  it('keeps the unevictable state when a snapshot only read some nodes', async () => {
    const { service, pro } = setup();
    const unevictableStates = () =>
      pro.dispatchKvCacheEvictionRisk.mock.calls.filter(([e]) => e.reason === 'unevictable').map(([e]) => e.active);
    await service.onSnapshot(snapshot({ noTtlRatio: 0.95 }), { partial: true });
    await service.onSnapshot(snapshot({ noTtlRatio: 0.95 }));
    await service.onSnapshot(snapshot({ noTtlRatio: 0.1 }), { partial: true });
    await service.onSnapshot(snapshot({ noTtlRatio: null }), { partial: true });
    await service.onSnapshot(snapshot({ detected: false }), { partial: true });
    await service.onSnapshot(snapshot({ noTtlRatio: 0.1 }));
    await service.onSnapshot(snapshot({ noTtlRatio: 0.95 }), { partial: true });
    expect(unevictableStates()).toEqual([false, true, true, true, true, false, false]);
  });

  it('forgets the unevictable state when the connection is removed or alerts are disabled', async () => {
    const { service, pro, remove, storage } = setup();
    const lastUnevictable = () =>
      pro.dispatchKvCacheEvictionRisk.mock.calls.filter(([e]) => e.reason === 'unevictable').at(-1)?.[0].active;
    service.onModuleInit();
    await service.onSnapshot(snapshot());
    remove('c1');
    await service.onSnapshot(snapshot(), { partial: true });
    expect(lastUnevictable()).toBe(false);
    await service.onSnapshot(snapshot());
    storage.getKvCacheSettings.mockResolvedValueOnce({
      connectionId: 'c1',
      hitRateAlertEnabled: true,
      hitRateThreshold: 0.2,
      evictionAlertEnabled: false,
      updatedAt: 1,
    });
    await service.onSnapshot(snapshot());
    await service.onSnapshot(snapshot(), { partial: true });
    expect(lastUnevictable()).toBe(false);
    service.onModuleDestroy();
  });

  it('passes the partial flag from footprint snapshots through', async () => {
    const { service, pro, footprint } = setup();
    service.onModuleInit();
    const listener = footprint.onSnapshot.mock.calls[0][0];
    await listener(snapshot({ evictedKeysDelta: 50 }), { partial: true });
    expect(pro.dispatchKvCacheEvictionRisk).toHaveBeenCalledWith(expect.objectContaining({ reason: 'evicting', active: false }));
    service.onModuleDestroy();
  });

  it('forgets the evicting hold when the connection is removed', async () => {
    const { service, pro, remove } = setup();
    service.onModuleInit();
    await service.onSnapshot(snapshot({ evictedKeysDelta: 50 }));
    remove('c1');
    await service.onSnapshot(snapshot({ evictedKeysDelta: 0 }));
    expect(pro.dispatchKvCacheEvictionRisk).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'evicting', active: false }));
    service.onModuleDestroy();
  });

  it('omits the instance when the connection is unknown', async () => {
    const { service, pro, connectionRegistry } = setup();
    connectionRegistry.getConfig.mockReturnValue(null);
    await service.onSnapshot(snapshot());
    expect(pro.dispatchKvCacheEvictionRisk.mock.calls[0][0]).not.toHaveProperty('instance');
  });

  it('clears both eviction alerts and the evicting hold when eviction alerts are disabled', async () => {
    const { service, pro, storage } = setup();
    const settings = (evictionAlertEnabled: boolean) => ({
      connectionId: 'c1',
      hitRateAlertEnabled: true,
      hitRateThreshold: 0.2,
      evictionAlertEnabled,
      updatedAt: 1,
    });
    await service.onSnapshot(snapshot({ evictedKeysDelta: 50 }));
    pro.dispatchKvCacheEvictionRisk.mockClear();
    storage.getKvCacheSettings.mockResolvedValue(settings(false));
    await service.onSnapshot(snapshot({ evictedKeysDelta: 50 }));
    expect(pro.dispatchKvCacheEvictionRisk.mock.calls.map(([e]) => [e.reason, e.active])).toEqual([
      ['unevictable', false],
      ['evicting', false],
    ]);
    pro.dispatchKvCacheEvictionRisk.mockClear();
    storage.getKvCacheSettings.mockResolvedValue(settings(true));
    await service.onSnapshot(snapshot({ evictedKeysDelta: 0 }));
    expect(pro.dispatchKvCacheEvictionRisk).toHaveBeenCalledWith(expect.objectContaining({ reason: 'evicting', active: false }));
  });

  it('clears the evicting alert at once when LMCache is no longer detected', async () => {
    const { service, pro } = setup();
    await service.onSnapshot(snapshot({ evictedKeysDelta: 50 }));
    await service.onSnapshot(snapshot({ detected: false, evictedKeysDelta: 0 }));
    expect(pro.dispatchKvCacheEvictionRisk).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'evicting', active: false }));
    await service.onSnapshot(snapshot({ evictedKeysDelta: 0 }));
    expect(pro.dispatchKvCacheEvictionRisk).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'evicting', active: false }));
  });

  it('keeps the unevictable state when a snapshot has no TTL data', async () => {
    const { service, pro } = setup();
    const unevictableStates = () =>
      pro.dispatchKvCacheEvictionRisk.mock.calls.filter(([e]) => e.reason === 'unevictable').map(([e]) => e.active);
    for (const noTtlRatio of [null, 0.95, null, 0.1, null]) await service.onSnapshot(snapshot({ noTtlRatio }));
    expect(unevictableStates()).toEqual([false, true, true, false, false]);
  });

  it('forgets the unevictable state when the connection is removed', async () => {
    const { service, pro, remove } = setup();
    service.onModuleInit();
    await service.onSnapshot(snapshot({ noTtlRatio: 0.95 }));
    remove('c1');
    await service.onSnapshot(snapshot({ noTtlRatio: null }));
    expect(pro.dispatchKvCacheEvictionRisk).toHaveBeenCalledWith(expect.objectContaining({ reason: 'unevictable', active: false }));
    service.onModuleDestroy();
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

  it('keeps the alert state while a checked window has too little traffic', async () => {
    const { service, pro, storage } = setup();
    await service.evaluateHitRates(1);
    storage.getKvCacheEngineSamples.mockResolvedValue([row({ requestedTokens: 5000, hitTokens: 100 })]);
    await service.evaluateHitRates(2);
    await service.evaluateHitRates(3);
    expect(pro.dispatchKvCacheHitRateLow).toHaveBeenCalledTimes(1);
    storage.getKvCacheEngineSamples.mockResolvedValue([row({ requestedTokens: 20000, hitTokens: 19000 })]);
    await service.evaluateHitRates(4);
    expect(pro.dispatchKvCacheHitRateLow).toHaveBeenCalledTimes(2);
    expect(pro.dispatchKvCacheHitRateLow).toHaveBeenLastCalledWith(expect.objectContaining({ hitRate: 0.95, timestamp: 4 }));
  });

  it('recovers a checked window once hit rate alerts are disabled', async () => {
    const { service, pro, storage } = setup();
    await service.evaluateHitRates(1);
    storage.getKvCacheSettings.mockResolvedValue({ connectionId: 'c1', hitRateAlertEnabled: false, hitRateThreshold: 0.3, evictionAlertEnabled: true, updatedAt: 1 });
    await service.evaluateHitRates(2);
    expect(pro.dispatchKvCacheHitRateLow).toHaveBeenCalledTimes(2);
    expect(pro.dispatchKvCacheHitRateLow).toHaveBeenLastCalledWith(
      expect.objectContaining({ engineId: 'e1', model: 'm', hitRate: 1, requestedTokens: 0, timestamp: 2 }),
    );
    await service.evaluateHitRates(3);
    expect(pro.dispatchKvCacheHitRateLow).toHaveBeenCalledTimes(2);
  });

  it('recovers a checked window when its engine is gone and no samples remain', async () => {
    const { service, pro, storage, registry } = setup();
    await service.evaluateHitRates(1);
    registry.list.mockReturnValue([]);
    registry.get.mockReturnValue(null);
    storage.getKvCacheEngineSamples.mockResolvedValue([]);
    await service.evaluateHitRates(2);
    expect(storage.getKvCacheEngineSamples).toHaveBeenLastCalledWith(expect.objectContaining({ connectionId: 'c1' }));
    expect(pro.dispatchKvCacheHitRateLow).toHaveBeenLastCalledWith(expect.objectContaining({ engineName: 'vllm', hitRate: 1 }));
  });

  it('skips a run while the previous one is still in flight', async () => {
    const { service, pro, storage } = setup();
    let release: () => void = () => undefined;
    pro.dispatchKvCacheHitRateLow.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
    const first = service.evaluateHitRates(1_000_000);
    await new Promise((resolve) => setImmediate(resolve));
    await service.evaluateHitRates(1_060_000);
    expect(storage.getKvCacheEngineSamples).toHaveBeenCalledTimes(1);
    release();
    await first;
    await service.evaluateHitRates(1_120_000);
    expect(storage.getKvCacheEngineSamples).toHaveBeenCalledTimes(2);
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

  it('does not export footprint gauges from a partial snapshot', async () => {
    const { service, prometheus, pro } = setup();
    await service.onSnapshot(snapshot({ perModel, scanComplete: false }));
    expect(prometheus.setKvCacheFootprint).not.toHaveBeenCalled();
    expect(pro.dispatchKvCacheEvictionRisk).toHaveBeenCalled();
  });

  it('does not set footprint gauges when unlicensed', async () => {
    const { service, prometheus } = setup({ licensed: false });
    await service.onSnapshot(snapshot({ perModel }));
    expect(prometheus.setKvCacheFootprint).not.toHaveBeenCalled();
  });

  it('clears exported series once the license lapses', async () => {
    const { service, prometheus, license } = setup();
    await service.onSnapshot(snapshot({ perModel }));
    await service.evaluateHitRates(1);
    expect(prometheus.clearAllKvCache).not.toHaveBeenCalled();
    license.hasFeature.mockReturnValue(false);
    await service.evaluateHitRates(2);
    expect(prometheus.clearAllKvCache).toHaveBeenCalledTimes(1);
    await service.onSnapshot(snapshot({ perModel }));
    expect(prometheus.clearAllKvCache).toHaveBeenCalledTimes(2);
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
