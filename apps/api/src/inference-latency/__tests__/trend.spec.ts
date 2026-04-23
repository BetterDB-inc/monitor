/* eslint-disable @typescript-eslint/no-explicit-any */
import { Test } from '@nestjs/testing';
import { InferenceLatencyService } from '../inference-latency.service';
import { ConnectionRegistry } from '../../connections/connection-registry.service';
import { SettingsService } from '../../settings/settings.service';
import { PrometheusService } from '../../prometheus/prometheus.service';

describe('InferenceLatencyService.getTrend', () => {
  let storage: any;
  let service: InferenceLatencyService;

  async function build(capabilities: { hasCommandLog: boolean }) {
    storage = {
      getCommandLogEntries: jest.fn().mockResolvedValue([]),
      getSlowLogEntries: jest.fn().mockResolvedValue([]),
      getVectorIndexSnapshots: jest.fn().mockResolvedValue([]),
    };

    const registry = {
      get: jest.fn().mockReturnValue({
        getCapabilities: () => capabilities,
        getConfigValue: jest.fn().mockResolvedValue(null),
      }),
    };

    const module = await Test.createTestingModule({
      providers: [
        InferenceLatencyService,
        { provide: 'STORAGE_CLIENT', useValue: storage },
        { provide: ConnectionRegistry, useValue: registry },
        { provide: PrometheusService, useValue: {} },
        { provide: SettingsService, useValue: { getCachedSettings: () => ({}) } },
      ],
    }).compile();

    service = module.get(InferenceLatencyService);
    return { storage, registry };
  }

  function slowlogEntry(timestampSec: number, duration: number, command: string[] = ['GET', 'k']) {
    return {
      id: 1,
      timestamp: timestampSec,
      duration,
      command,
      clientAddress: '',
      clientName: '',
      capturedAt: timestampSec * 1000,
      sourceHost: 'h',
      sourcePort: 6379,
    };
  }

  it('returns empty points when no entries fall in any bin', async () => {
    await build({ hasCommandLog: false });
    const result = await service.getTrend('conn-1', 'read', 1_000, 61_000, 10_000);
    expect(result.points).toEqual([]);
    expect(result.bucketMs).toBe(10_000);
    expect(result.source).toBe('slowlog');
  });

  it('produces one point per non-empty bin with nearest-rank percentiles', async () => {
    await build({ hasCommandLog: true });
    storage.getCommandLogEntries.mockResolvedValueOnce([
      slowlogEntry(1, 100),
      slowlogEntry(1, 200),
      slowlogEntry(1, 300),
      slowlogEntry(11, 5_000),
    ]);
    const result = await service.getTrend('conn-1', 'read', 0, 20_000, 10_000);
    expect(result.points).toHaveLength(2);
    expect(result.points[0].count).toBe(3);
    expect(result.points[0].p50).toBe(200);
    expect(result.points[1].p50).toBe(5_000);
  });

  it('filters out entries whose command does not match the requested bucket', async () => {
    await build({ hasCommandLog: false });
    storage.getSlowLogEntries.mockResolvedValueOnce([
      slowlogEntry(1, 100, ['GET', 'k']),
      slowlogEntry(2, 200, ['SET', 'k', 'v']),
    ]);
    const result = await service.getTrend('conn-1', 'write', 0, 10_000, 10_000);
    expect(result.points).toHaveLength(1);
    expect(result.points[0].count).toBe(1);
    expect(result.points[0].p50).toBe(200);
  });

  it('rejects end <= start', async () => {
    await build({ hasCommandLog: false });
    await expect(service.getTrend('conn-1', 'read', 10, 10)).rejects.toThrow();
  });

  it('rejects too-narrow bucketMs for the window (over MAX_TREND_POINTS)', async () => {
    await build({ hasCommandLog: false });
    // 1-day window / 1-second bins = 86_400 bins >> 1_440 cap
    await expect(
      service.getTrend('conn-1', 'read', 0, 86_400_000, 1_000),
    ).rejects.toThrow(/cap is 1440/);
  });
});
