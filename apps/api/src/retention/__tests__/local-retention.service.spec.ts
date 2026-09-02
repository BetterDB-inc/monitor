import { LocalRetentionService } from '../local-retention.service';
import { MS_PER_DAY } from '../retention-policy.service';

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
      pruneOldAnomalyEvents: jest.fn().mockResolvedValue(0),
      pruneOldCorrelatedGroups: jest.fn().mockResolvedValue(0),
      pruneOldKeyPatternSnapshots: jest.fn().mockResolvedValue(0),
      pruneOldEntries: jest.fn().mockResolvedValue(0),
      pruneOldDeliveries: jest.fn().mockResolvedValue(0),
      pruneOldLatencySnapshots: jest.fn().mockResolvedValue(0),
      pruneOldLatencyHistograms: jest.fn().mockResolvedValue(0),
      pruneOldMemorySnapshots: jest.fn().mockResolvedValue(0),
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
      expect(storage[method]).toHaveBeenCalledWith(expectedCutoff);
    }
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
});
