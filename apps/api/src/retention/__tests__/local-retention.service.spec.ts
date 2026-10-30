import { Logger } from '@nestjs/common';
import { clientRollupBucketStart } from '@betterdb/shared';
import { LocalRetentionService } from '../local-retention.service';
import { MS_PER_DAY } from '../retention-policy.service';
import { runRetentionSweep } from '../retention-sweep';

const NOW = 1_700_000_000_000;

describe('LocalRetentionService', () => {
  let originalCloudMode: string | undefined;
  let storage: any;

  beforeEach(() => {
    originalCloudMode = process.env.CLOUD_MODE;
    delete process.env.CLOUD_MODE;

    storage = {
      pruneOldSlowLogEntries: jest.fn().mockResolvedValue(1),
      pruneOldCommandLogEntries: jest.fn().mockResolvedValue(2),
      pruneOldClientSnapshots: jest.fn().mockResolvedValue(0),
      pruneOldClientAnalyticsRollups: jest.fn().mockResolvedValue(0),
      pruneOldAnomalyEvents: jest.fn().mockResolvedValue(0),
      pruneOldCorrelatedGroups: jest.fn().mockResolvedValue(0),
      pruneOldKeyPatternSnapshots: jest.fn().mockResolvedValue(0),
      pruneOldHotKeys: jest.fn().mockResolvedValue(0),
      pruneOldEntries: jest.fn().mockResolvedValue(0),
      pruneOldDeliveries: jest.fn().mockResolvedValue(0),
      pruneOldLatencySnapshots: jest.fn().mockResolvedValue(0),
      pruneOldLatencyHistograms: jest.fn().mockResolvedValue(0),
      pruneOldMemorySnapshots: jest.fn().mockResolvedValue(0),
      pruneOldScalingReadinessScores: jest.fn().mockResolvedValue(3),
      pruneOldKvCacheFootprintSnapshots: jest.fn().mockResolvedValue(4),
      pruneOldKvCacheEngineSamples: jest.fn().mockResolvedValue(5),
      pruneOldCaptureChunks: jest.fn().mockResolvedValue(0),
      pruneOldCaptureSessions: jest.fn().mockResolvedValue(0),
      pruneOldCaptureTriggers: jest.fn().mockResolvedValue(0),
      pruneOldScheduledCaptures: jest.fn().mockResolvedValue(0),
      pruneOldAiCacheSamples: jest.fn().mockResolvedValue(0),
      pruneOldOtelSpans: jest.fn().mockResolvedValue(0),
      pruneOldCommandStatsSamples: jest.fn().mockResolvedValue(0),
      pruneOldLatencyStatsSamples: jest.fn().mockResolvedValue(0),
      pruneOldVectorIndexSnapshots: jest.fn().mockResolvedValue(0),
    };

    jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalCloudMode === undefined) {
      delete process.env.CLOUD_MODE;
    } else {
      process.env.CLOUD_MODE = originalCloudMode;
    }
  });

  // Repository-backed store, attached non-enumerable so the "every prune
  // method" loops below keep iterating only the pruneOld* mocks.
  const maintenanceWindows = { prune: jest.fn() };
  beforeEach(() => {
    maintenanceWindows.prune.mockReset().mockResolvedValue(7);
    Object.defineProperty(storage, 'getMaintenanceWindowRepository', {
      value: () => maintenanceWindows,
      enumerable: false,
    });
  });

  const makeService = (localRetentionDays: number | null) => {
    const retentionPolicy = {
      getLocalRetentionDays: jest.fn().mockReturnValue(localRetentionDays),
    } as any;
    return new LocalRetentionService(storage, retentionPolicy);
  };

  it('does not prune when no retention window is configured', async () => {
    await makeService(null).runSweep();
    expect(storage.pruneOldSlowLogEntries).not.toHaveBeenCalled();
  });

  it('prunes every store with the configured cutoff', async () => {
    await makeService(30).runSweep();

    const expectedCutoff = NOW - 30 * MS_PER_DAY;
    for (const method of Object.keys(storage)) {
      expect(storage[method]).toHaveBeenCalledTimes(1);
      // Rollups compare bucket_start: the cutoff is aligned down to its bucket.
      expect(storage[method]).toHaveBeenCalledWith(
        method === 'pruneOldClientAnalyticsRollups' ? clientRollupBucketStart(expectedCutoff) : expectedCutoff,
      );
    }
  });

  it('reports pruned scaling readiness scores under their own name', async () => {
    const results = await runRetentionSweep(storage, 1_234, { error: jest.fn() } as any);

    expect(storage.pruneOldScalingReadinessScores).toHaveBeenCalledWith(1_234);
    expect(results.scaling_readiness_scores).toBe(3);
  });

  it('reports pruned kv cache rows under their own names', async () => {
    const results = await runRetentionSweep(storage, 1_234, { error: jest.fn() } as any);

    expect(storage.pruneOldKvCacheFootprintSnapshots).toHaveBeenCalledWith(1_234);
    expect(storage.pruneOldKvCacheEngineSamples).toHaveBeenCalledWith(1_234);
    expect(results.kv_cache_footprint_snapshots).toBe(4);
    expect(results.kv_cache_engine_samples).toBe(5);
  });

  it('sweeps client analytics rollups so removed connections do not keep them forever', async () => {
    storage.pruneOldClientAnalyticsRollups.mockResolvedValue(4);
    const results = await runRetentionSweep(storage, 5_678, { error: jest.fn() } as any);

    // 5_678 lies inside the first bucket: nothing wholly before it, so bucket 0 survives.
    expect(storage.pruneOldClientAnalyticsRollups).toHaveBeenCalledWith(0);
    expect(results.client_analytics_rollups).toBe(4);
  });

  it('keeps the rollup bucket that straddles the cutoff, whose later raw rows survive the raw prune', async () => {
    const bucketStart = clientRollupBucketStart(NOW);
    const cutoff = bucketStart + 120_000;
    const logger = { error: jest.fn() } as unknown as Logger;
    await runRetentionSweep(storage, cutoff, logger);

    expect(storage.pruneOldClientSnapshots).toHaveBeenCalledWith(cutoff);
    expect(storage.pruneOldClientAnalyticsRollups).toHaveBeenCalledWith(bucketStart);
    // An aligned cutoff passes through unchanged.
    await runRetentionSweep(storage, bucketStart, logger);
    expect(storage.pruneOldClientAnalyticsRollups).toHaveBeenLastCalledWith(bucketStart);
  });

  it('does nothing in cloud mode even when a window is configured', async () => {
    process.env.CLOUD_MODE = 'true';
    await makeService(30).runSweep();
    expect(storage.pruneOldSlowLogEntries).not.toHaveBeenCalled();
  });

  it('continues pruning other stores when one throws', async () => {
    storage.pruneOldCommandLogEntries.mockRejectedValue(new Error('db error'));

    await makeService(30).runSweep();

    for (const method of Object.keys(storage)) {
      expect(storage[method]).toHaveBeenCalledTimes(1);
    }
  });

  it('does not schedule any timers in cloud mode', () => {
    process.env.CLOUD_MODE = 'true';
    jest.useFakeTimers();
    const service = makeService(30);
    service.onModuleInit();
    expect(jest.getTimerCount()).toBe(0);
    service.onModuleDestroy();
    jest.useRealTimers();
  });

  it('prunes ended maintenance windows with the same cutoff', async () => {
    const results = await runRetentionSweep(storage, 1_234, { error: jest.fn() } as any);

    expect(maintenanceWindows.prune).toHaveBeenCalledWith(1_234);
    expect(results.maintenance_windows).toBe(7);
  });
});
