import { Logger } from '@nestjs/common';
import type { KvCacheEngineSample } from '@betterdb/shared';
import {
  hitRate,
  KvCacheSamplesService,
  mergeBuckets,
  SAMPLES_CHART_POINTS,
  SAMPLES_LIMIT,
  SAMPLES_MAX_RANGE_MS,
} from '../kv-cache-samples.service';
import { METRIC_FIELDS } from '../counter-deltas';

const counters = { requestedTokens: 0, hitTokens: 0, lookupTokens: 0, lookupHits: 0, remoteReadBytes: 0, remoteWriteBytes: 0, remoteReadRequests: 0, remoteWriteRequests: 0, remotePingErrors: 0 };

const sample = (over: Partial<KvCacheEngineSample>): KvCacheEngineSample => ({
  engineId: 'e1',
  connectionId: 'c1',
  modelName: 'm',
  timestamp: 60_000,
  ...counters,
  ...over,
});

const observation = (value: number, cumulative = false) => ({
  engineId: 'e1',
  connectionId: 'c1',
  modelName: 'm',
  series: 's',
  metric: 'num_requested_tokens',
  value,
  cumulative,
});

function setup() {
  const storage = {
    saveKvCacheEngineSamples: jest.fn().mockResolvedValue(undefined),
    getKvCacheEngineSamples: jest.fn().mockResolvedValue([]),
    getKvCacheSampleTotals: jest.fn().mockResolvedValue({ requestedTokens: 0, hitTokens: 0 }),
    deleteKvCacheEngineSamples: jest.fn().mockResolvedValue(undefined),
  };
  return { storage, service: new KvCacheSamplesService(storage as any) };
}

describe('hitRate', () => {
  it('is null without requested tokens', () => {
    expect(hitRate(0, 0)).toBeNull();
  });

  it('rounds the ratio to four decimals', () => {
    expect(hitRate(1000, 700)).toBe(0.7);
    expect(hitRate(3, 1)).toBe(0.3333);
  });

  it('clamps the ratio to [0, 1]', () => {
    expect(hitRate(100, 250)).toBe(1);
    expect(hitRate(100, -5)).toBe(0);
  });
});

describe('mergeBuckets', () => {
  it('sums rows sharing engine, model and timestamp', () => {
    const merged = mergeBuckets([
      sample({ requestedTokens: 100, hitTokens: 50 }),
      sample({ requestedTokens: 100, hitTokens: 25 }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ requestedTokens: 200, hitTokens: 75, hitRate: 0.375 });
  });

  it('sums every mapped counter field', () => {
    const ones = Object.fromEntries(Object.values(METRIC_FIELDS).map((field) => [field, 1]));
    const [merged] = mergeBuckets([sample(ones), sample(ones)]);
    for (const field of Object.values(METRIC_FIELDS)) expect(merged[field]).toBe(2);
  });

  it('keeps distinct engines, models and timestamps apart, sorted by timestamp', () => {
    const merged = mergeBuckets([
      sample({ timestamp: 120_000 }),
      sample({ engineId: 'e2' }),
      sample({ modelName: 'other' }),
      sample({}),
    ]);
    expect(merged.map((b) => b.timestamp)).toEqual([60_000, 60_000, 60_000, 120_000]);
    expect(merged).toHaveLength(4);
    expect(merged[0].hitRate).toBeNull();
  });
});

describe('KvCacheSamplesService', () => {
  it('flushes a closed bucket once', async () => {
    const { service, storage } = setup();
    expect(service.observe(observation(10), 61_000)).toBe(true);
    service.observe(observation(5), 62_000);
    await service.flush(120_000);
    expect(storage.saveKvCacheEngineSamples).toHaveBeenCalledTimes(1);
    expect(storage.saveKvCacheEngineSamples.mock.calls[0][0]).toEqual([
      expect.objectContaining({ engineId: 'e1', timestamp: 60_000, requestedTokens: 15 }),
    ]);
    await service.flush(120_000);
    expect(storage.saveKvCacheEngineSamples).toHaveBeenCalledTimes(1);
  });

  it('keeps the open bucket until it closes', async () => {
    const { service, storage } = setup();
    service.observe(observation(10), 61_000);
    await service.flush(90_000);
    expect(storage.saveKvCacheEngineSamples).not.toHaveBeenCalled();
  });

  it('logs and drops rows when the save fails', async () => {
    const { service, storage } = setup();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    storage.saveKvCacheEngineSamples.mockRejectedValue(new Error('disk full'));
    service.observe(observation(10), 61_000);
    await expect(service.flush(120_000)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('Could not save 1 KV cache samples: disk full');
    storage.saveKvCacheEngineSamples.mockClear();
    await service.flush(120_000);
    expect(storage.saveKvCacheEngineSamples).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('drops pending buckets and stored samples of a deleted engine', async () => {
    const { service, storage } = setup();
    service.observe(observation(10), 61_000);
    await service.deleteEngine('e1');
    expect(storage.deleteKvCacheEngineSamples).toHaveBeenCalledWith('e1');
    await service.flush(120_000);
    expect(storage.saveKvCacheEngineSamples).not.toHaveBeenCalled();
  });

  it('deletes stored samples only after an in-flight flush lands', async () => {
    const { service, storage } = setup();
    const order: string[] = [];
    let finishSave: () => void = () => undefined;
    storage.saveKvCacheEngineSamples.mockImplementationOnce(() => new Promise<void>((resolve) => (finishSave = () => { order.push('save'); resolve(); })));
    storage.deleteKvCacheEngineSamples.mockImplementationOnce(async () => { order.push('delete'); });
    service.observe(observation(10), 61_000);
    const flushing = service.flush(120_000);
    const deleting = service.deleteEngine('e1');
    await new Promise((resolve) => setImmediate(resolve));
    finishSave();
    await Promise.all([flushing, deleting]);
    expect(order).toEqual(['save', 'delete']);
  });

  it('resets baselines without dropping pending buckets', async () => {
    const { service, storage } = setup();
    service.observe(observation(100, true), 61_000);
    service.observe(observation(110, true), 62_000);
    service.resetBaselines('e1');
    service.observe(observation(5000, true), 63_000);
    await service.flush(120_000);
    expect(storage.saveKvCacheEngineSamples).toHaveBeenCalledWith([expect.objectContaining({ requestedTokens: 10 })]);
  });

  it('caps the range and computes the range hit rate across engines', async () => {
    const { service, storage } = setup();
    storage.getKvCacheEngineSamples.mockResolvedValue([
      sample({ engineId: 'e1', requestedTokens: 100, hitTokens: 50 }),
      sample({ engineId: 'e2', requestedTokens: 300, hitTokens: 250 }),
    ]);
    const to = 100 * 24 * 60 * 60_000;
    const result = await service.getSamples('c1', { from: 0, to, engineId: 'e1', model: 'm' });
    expect(storage.getKvCacheEngineSamples).toHaveBeenCalledWith({
      connectionId: 'c1',
      from: to - SAMPLES_MAX_RANGE_MS,
      to,
      limit: SAMPLES_LIMIT,
      bucketMs: expect.any(Number),
      engineId: 'e1',
      modelName: 'm',
    });
    expect(result.buckets).toHaveLength(2);
    expect(storage.getKvCacheSampleTotals).toHaveBeenCalledWith({
      connectionId: 'c1',
      from: to - SAMPLES_MAX_RANGE_MS,
      to,
      engineId: 'e1',
      modelName: 'm',
    });
  });

  it('buckets the chart rows in storage so a long range covers the whole window', async () => {
    const { service, storage } = setup();
    const to = 40 * 24 * 60 * 60_000;
    await service.getSamples('c1', { from: 0, to });
    const query = storage.getKvCacheEngineSamples.mock.calls[0][0];
    expect(query.bucketMs % 60_000).toBe(0);
    expect(SAMPLES_MAX_RANGE_MS / query.bucketMs).toBeLessThanOrEqual(SAMPLES_CHART_POINTS);
    await service.getSamples('c1', { from: to - 60 * 60_000, to });
    expect(storage.getKvCacheEngineSamples.mock.calls[1][0].bucketMs).toBe(60_000);
  });

  it('reports the chart bucket size it used', async () => {
    const { service, storage } = setup();
    const to = 10 * 24 * 60 * 60_000;
    const response = await service.getSamples('c1', { from: to - 7 * 24 * 60 * 60_000, to });
    expect(response.bucketMs).toBe(storage.getKvCacheEngineSamples.mock.calls[0][0].bucketMs);
    expect(response.bucketMs).toBe(7 * 60_000);
  });

  it('computes the range hit rate from totals over the whole range, not the capped rows', async () => {
    const { service, storage } = setup();
    storage.getKvCacheEngineSamples.mockResolvedValue([sample({ requestedTokens: 100, hitTokens: 100 })]);
    storage.getKvCacheSampleTotals.mockResolvedValue({ requestedTokens: 400, hitTokens: 300 });
    expect((await service.getSamples('c1', { from: 0, to: 1000 })).rangeHitRate).toBe(0.75);
  });

  it('returns a null range hit rate when nothing was requested', async () => {
    const { service } = setup();
    expect(await service.getSamples('c1', { from: 0, to: 1000 })).toEqual({ buckets: [], rangeHitRate: null, bucketMs: 60_000 });
  });

  it('waits for an in-flight save even when there is nothing new to drain', async () => {
    const { service, storage } = setup();
    let finishSave: () => void = () => undefined;
    let saved = false;
    storage.saveKvCacheEngineSamples.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishSave = () => { saved = true; resolve(); })),
    );
    service.observe(observation(10), 61_000);
    void service.flush(120_000);
    let destroyed = false;
    const destroying = service.onModuleDestroy().then(() => { destroyed = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(destroyed).toBe(false);
    finishSave();
    await destroying;
    expect(saved).toBe(true);
  });

  it('flushes the open bucket on module destroy and stops the timer', async () => {
    const { service, storage } = setup();
    service.onModuleInit();
    service.observe(observation(10), Date.now());
    await service.onModuleDestroy();
    expect(storage.saveKvCacheEngineSamples).toHaveBeenCalledTimes(1);
    expect(storage.saveKvCacheEngineSamples.mock.calls[0][0][0]).toMatchObject({ requestedTokens: 10 });
  });
});
