import type { KvCacheEngineSample, KvCacheFootprintSnapshot, KvCacheSettings } from '@betterdb/shared';
import { evictionConditions, shouldCheckHitRate, windowHitRates, type HitRateWindow } from '../kv-cache-alert-rules';

const settings = (over: Partial<KvCacheSettings> = {}): KvCacheSettings => ({
  connectionId: 'c1',
  hitRateAlertEnabled: true,
  hitRateThreshold: 0.2,
  evictionAlertEnabled: true,
  updatedAt: 0,
  ...over,
});

const window = (over: Partial<HitRateWindow> = {}): HitRateWindow => ({
  engineId: 'e1',
  model: 'm',
  requestedTokens: 10000,
  hitTokens: 1000,
  hitRate: 0.1,
  ...over,
});

const sample = (over: Partial<KvCacheEngineSample> = {}): KvCacheEngineSample => ({
  connectionId: 'c1',
  engineId: 'e1',
  modelName: 'm',
  timestamp: 0,
  requestedTokens: 100,
  hitTokens: 50,
  lookupTokens: 0,
  lookupHits: 0,
  remoteReadBytes: 0,
  remoteWriteBytes: 0,
  remoteReadRequests: 0,
  remoteWriteRequests: 0,
  remotePingErrors: 0,
  ...over,
});

const snapshot = (over: Partial<KvCacheFootprintSnapshot> = {}): KvCacheFootprintSnapshot => ({
  connectionId: 'c1',
  timestamp: 0,
  detected: true,
  layout: null,
  scannedKeys: 0,
  matchedKeys: 0,
  sampledKeys: 0,
  scanComplete: true,
  chunksEst: 0,
  bytesEst: 0,
  usedMemory: 50,
  maxmemory: 100,
  maxmemoryPolicy: 'allkeys-lru',
  lmcacheMemoryShare: 0.1,
  noTtlRatio: 0,
  orphanRatio: null,
  evictedKeysDelta: 0,
  otherDbs: [],
  perModel: [],
  ...over,
});

describe('shouldCheckHitRate', () => {
  it('requires the token floor', () => {
    expect(shouldCheckHitRate(window({ requestedTokens: 9999 }), settings())).toBe(false);
    expect(shouldCheckHitRate(window({ requestedTokens: 10000 }), settings())).toBe(true);
  });

  it('is false when the alert is disabled', () => {
    expect(shouldCheckHitRate(window(), settings({ hitRateAlertEnabled: false }))).toBe(false);
  });

  it('is false when the hit rate is null', () => {
    expect(shouldCheckHitRate(window({ hitRate: null }), settings())).toBe(false);
  });
});

describe('windowHitRates', () => {
  it('sums minutes per engine and model and keeps models apart', () => {
    const result = windowHitRates([
      sample({ timestamp: 1, requestedTokens: 100, hitTokens: 10 }),
      sample({ timestamp: 2, requestedTokens: 300, hitTokens: 30 }),
      sample({ modelName: 'other', requestedTokens: 50, hitTokens: 50 }),
    ]);
    expect(result).toEqual([
      { engineId: 'e1', model: 'm', requestedTokens: 400, hitTokens: 40, hitRate: 0.1 },
      { engineId: 'e1', model: 'other', requestedTokens: 50, hitTokens: 50, hitRate: 1 },
    ]);
  });

  it('reports a null hit rate when nothing was requested', () => {
    expect(windowHitRates([sample({ requestedTokens: 0, hitTokens: 0 })])[0].hitRate).toBeNull();
  });
});

describe('evictionConditions', () => {
  it('flags unevictable keys under a volatile policy', () => {
    expect(evictionConditions(snapshot({ maxmemoryPolicy: 'volatile-lru', noTtlRatio: 0.95 })).unevictable).toBe(true);
  });

  it('does not flag allkeys or noeviction policies', () => {
    expect(evictionConditions(snapshot({ maxmemoryPolicy: 'allkeys-lru', noTtlRatio: 1 })).unevictable).toBe(false);
    expect(evictionConditions(snapshot({ maxmemoryPolicy: 'noeviction', noTtlRatio: 1 })).unevictable).toBe(false);
  });

  const evicting = { evictedKeysDelta: 5, usedMemory: 95, maxmemory: 100, lmcacheMemoryShare: 0.6 };

  it('flags evicting when all three conditions hold', () => {
    expect(evictionConditions(snapshot(evicting)).evicting).toBe(true);
  });

  it.each([
    ['no evictions', { evictedKeysDelta: 0 }],
    ['null evictions', { evictedKeysDelta: null }],
    ['low memory pressure', { usedMemory: 80 }],
    ['no maxmemory', { maxmemory: 0 }],
    ['low lmcache share', { lmcacheMemoryShare: 0.4 }],
  ])('does not flag evicting with %s', (_name, override) => {
    expect(evictionConditions(snapshot({ ...evicting, ...override })).evicting).toBe(false);
  });

  it('flags nothing when LMCache is not detected', () => {
    expect(
      evictionConditions(snapshot({ ...evicting, detected: false, maxmemoryPolicy: 'volatile-lru', noTtlRatio: 1 })),
    ).toEqual({ unevictable: false, evicting: false });
  });
});
