import { ScalingReadinessService } from '../scaling-readiness.service';
import { DAY_MS } from '../scoring';
import type { StoredMemorySnapshot } from '../../common/interfaces/storage-port.interface';

const NOW = 1_700_000_000_000;

const snap = (ageMs: number, o: Partial<StoredMemorySnapshot> = {}): StoredMemorySnapshot => ({
  id: `s-${ageMs}`, timestamp: NOW - ageMs, usedMemory: 100, usedMemoryRss: null, usedMemoryPeak: null,
  memFragmentationRatio: null, maxmemory: 1000, allocatorFragRatio: null, opsPerSec: 100,
  cpuSys: 10, cpuUser: 10, ioThreadedReads: null, ioThreadedWrites: null,
  connectedClients: 10, maxclients: 1000, totalKeys: 100, ...o,
});

function setup(options: {
  snapshots?: StoredMemorySnapshot[];
  external?: boolean;
  sentinel?: boolean;
  info?: Record<string, unknown>;
  ioThreads?: string | null | Error;
  forecast?: unknown;
} = {}) {
  const client = {
    getCapabilities: jest.fn().mockReturnValue({ isSentinel: options.sentinel ?? false }),
    getInfoParsed: jest.fn().mockResolvedValue(options.info ?? { server: { io_threads_active: '0' } }),
    getConfigValue: jest.fn().mockImplementation(async () => {
      if (options.ioThreads instanceof Error) throw options.ioThreads;
      return options.ioThreads ?? null;
    }),
  };
  const storage = {
    getMemorySnapshots: jest
      .fn()
      .mockImplementation(async ({ startTime, limit }: { startTime: number; limit: number }) =>
        [...(options.snapshots ?? [])]
          .reverse()
          .filter((s) => s.timestamp >= startTime)
          .slice(0, limit),
      ),
  };
  const registry = {
    get: jest.fn().mockReturnValue(client),
    getConfig: jest.fn().mockReturnValue({ connectionType: options.external ? 'external' : 'direct' }),
  };
  const forecasting = {
    getForecast: jest.fn().mockResolvedValue(
      options.forecast ?? { enabled: true, insufficientData: false, mode: 'trend', ceiling: null },
    ),
  };
  const service = new ScalingReadinessService(storage as any, registry as any, forecasting as any);
  return { service, client, storage, forecasting };
}

const twoDays = () => [snap(2 * DAY_MS), snap(DAY_MS), snap(0)];

describe('ScalingReadinessService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });
  afterEach(() => jest.useRealTimers());

  it('returns a not-applicable result for Sentinel connections', async () => {
    const { service, storage } = setup({ sentinel: true });
    const r = await service.compute('c');
    expect(r.score).toBeNull();
    expect(r.summary).toBe('Not applicable to Sentinel');
    expect(storage.getMemorySnapshots).not.toHaveBeenCalled();
  });

  it('reads the 7-day trend once per 15 minutes', async () => {
    const { service, storage } = setup({ snapshots: twoDays() });
    const weekReads = () =>
      storage.getMemorySnapshots.mock.calls.filter(([o]) => o.limit === 11_000).length;
    await service.compute('c');
    jest.setSystemTime(NOW + 61_000);
    await service.compute('c');
    expect(storage.getMemorySnapshots).toHaveBeenCalledTimes(3);
    expect(weekReads()).toBe(1);
    jest.setSystemTime(NOW + 15 * 60_000);
    await service.compute('c');
    expect(weekReads()).toBe(2);
  });

  it('excludes memory, connections and CPU when the latest sample is stale', async () => {
    const { service } = setup({ snapshots: [snap(2 * DAY_MS), snap(DAY_MS), snap(11 * 60_000)] });
    const r = await service.compute('c');
    for (const key of ['memory', 'connections', 'cpu']) {
      expect(r.dimensions.find((d) => d.key === key)!.excludedReason).toBe(
        'No samples in the last 10 minutes',
      );
    }
    expect(r.dimensions.find((d) => d.key === 'keyspaceGrowth')!.excludedReason).toBeNull();
  });

  it('reads the last 7 days of snapshots for the connection', async () => {
    const { service, storage } = setup({ snapshots: twoDays() });
    await service.compute('c');
    expect(storage.getMemorySnapshots).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'c', startTime: NOW - 7 * DAY_MS }),
    );
  });

  it('scores all five dimensions for a healthy direct connection', async () => {
    const { service } = setup({ snapshots: twoDays() });
    const r = await service.compute('c');
    expect(r.dimensions.every((d) => d.excludedReason === null)).toBe(true);
    expect(r.band).toBe('green');
  });

  it('excludes connections for external connections', async () => {
    const { service, client } = setup({
      external: true,
      snapshots: twoDays().map((s) => ({ ...s, maxclients: null })),
    });
    const r = await service.compute('c');
    expect(r.dimensions.find((d) => d.key === 'connections')!.excludedReason).toBe('Not reported over OTLP');
    expect(client.getConfigValue).not.toHaveBeenCalled();
  });

  it('uses io-threads when threaded I/O is active and caches the lookup', async () => {
    const { service, client } = setup({
      snapshots: [snap(0, { cpuSys: 100, cpuUser: 40 })],
      info: { server: { io_threads_active: '1' } },
      ioThreads: '4',
    });
    const r = await service.compute('c');
    expect(r.dimensions.find((d) => d.key === 'cpu')!.detail).toBe('140% CPU across 4 threads');
    jest.setSystemTime(NOW + 61_000);
    await service.compute('c');
    expect(client.getConfigValue).toHaveBeenCalledTimes(1);
  });

  it('re-reads an inactive io-threads result after a minute', async () => {
    const { service, client } = setup({ snapshots: [snap(0)] });
    await service.compute('c');
    jest.setSystemTime(NOW + 61_000);
    await service.compute('c');
    expect(client.getInfoParsed).toHaveBeenCalledTimes(2);
  });

  it('re-reads the thread lookup after a minute when it failed', async () => {
    const { service, client } = setup({
      snapshots: [snap(0)],
      info: { server: { io_threads_active: '1' } },
      ioThreads: new Error('NOPERM'),
    });
    await service.compute('c');
    jest.setSystemTime(NOW + 61_000);
    await service.compute('c');
    expect(client.getInfoParsed).toHaveBeenCalledTimes(2);
  });

  it('shares one compute between concurrent calls', async () => {
    const { service, storage } = setup({ snapshots: twoDays() });
    await Promise.all([service.compute('c'), service.compute('c')]);
    expect(storage.getMemorySnapshots).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed compute', async () => {
    const { service, storage } = setup({ snapshots: twoDays() });
    storage.getMemorySnapshots.mockRejectedValueOnce(new Error('boom'));
    await expect(service.compute('c')).rejects.toThrow('boom');
    await expect(service.compute('c')).resolves.toMatchObject({ connectionId: 'c' });
  });

  it('falls back to one thread when CONFIG GET is denied', async () => {
    const { service } = setup({
      snapshots: [snap(0)],
      info: { server: { io_threads_active: '1' } },
      ioThreads: new Error('NOPERM'),
    });
    const r = await service.compute('c');
    expect(r.dimensions.find((d) => d.key === 'cpu')!.detail).toBe(
      '20% CPU across 1 thread (thread count could not be read)',
    );
  });

  it('uses the forecasting time-to-limit when an ops ceiling is set', async () => {
    const { service } = setup({
      snapshots: twoDays(),
      forecast: {
        enabled: true, insufficientData: false, mode: 'forecast', ceiling: 1000,
        timeToLimitMs: 15.5 * DAY_MS, timeToLimitHuman: '~15 days',
      },
    });
    const r = await service.compute('c');
    expect(r.dimensions.find((d) => d.key === 'opsTrend')).toMatchObject({
      score: 50,
      detail: '~15 days to the ops/sec ceiling',
    });
  });

  it('falls back to ops growth when forecasting is disabled', async () => {
    const { service } = setup({ snapshots: twoDays(), forecast: { enabled: false } });
    const r = await service.compute('c');
    expect(r.dimensions.find((d) => d.key === 'opsTrend')!.detail).toBe(
      'Ops/sec flat or shrinking week over week',
    );
  });

  it('excludes the throughput trend when no ops were ever recorded', async () => {
    const { service } = setup({ snapshots: twoDays().map((s) => ({ ...s, opsPerSec: 0 })) });
    const r = await service.compute('c');
    expect(r.dimensions.find((d) => d.key === 'opsTrend')!.excludedReason).toBe('No ops samples yet');
  });

  it('excludes keyspace growth without key counts', async () => {
    const { service } = setup({ snapshots: twoDays().map((s) => ({ ...s, totalKeys: null })) });
    const r = await service.compute('c');
    expect(r.dimensions.find((d) => d.key === 'keyspaceGrowth')!.excludedReason).toBe('No key counts yet');
  });

  it('caches results for 60 seconds per connection', async () => {
    const { service, storage } = setup({ snapshots: twoDays() });
    await service.compute('c');
    jest.setSystemTime(NOW + 59_000);
    await service.compute('c');
    expect(storage.getMemorySnapshots).toHaveBeenCalledTimes(2);
    jest.setSystemTime(NOW + 61_000);
    await service.compute('c');
    expect(storage.getMemorySnapshots).toHaveBeenCalledTimes(3);
  });
});
