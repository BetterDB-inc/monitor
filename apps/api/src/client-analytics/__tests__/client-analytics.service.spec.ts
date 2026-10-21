import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientAnalyticsService } from '../client-analytics.service';
import { ClientAnalyticsAnalysisService } from '../client-analytics-analysis.service';
import { ClientAnalyticsRollupService } from '../client-analytics-rollup.service';
import { QueryBudget } from '../query-budget';
import { RAW_STATS_SPAN_MAX_MS } from '../client-rollup-math';
import { StoragePort } from '../../common/interfaces/storage-port.interface';

const HOUR = 60 * 60_000;
const WINDOW = 24 * HOUR;
const RAW_MAX = RAW_STATS_SPAN_MAX_MS;
const NOW = 1_800_000_000_000;

describe('ClientAnalyticsService', () => {
  it('keeps Sentinel connections in client snapshot polling', () => {
    const service = Object.create(ClientAnalyticsService.prototype) as unknown as { pollsSentinels(): boolean };
    expect(service.pollsSentinels()).toBe(true);
  });

  describe('getStats routing', () => {
    let storage: { getClientAnalyticsStats: jest.Mock; getClientConnectionHistory: jest.Mock };
    let rollup: {
      getLatestStats: jest.Mock;
      getStatsForRange: jest.Mock;
      getWindowStatsWithRetentionPeak: jest.Mock;
      getLatestStatsAllConnections: jest.Mock;
      getWindowMs: jest.Mock;
    };
    let service: ClientAnalyticsService;
    const latest = { currentConnections: 1 } as never;
    const ranged = { currentConnections: 2 } as never;
    const raw = { currentConnections: 3 } as never;
    const allLatest = { currentConnections: 4 } as never;
    const windowed = { currentConnections: 5 } as never;

    beforeEach(() => {
      jest.useFakeTimers({ now: NOW });
      storage = {
        getClientAnalyticsStats: jest.fn().mockResolvedValue(raw),
        getClientConnectionHistory: jest.fn().mockResolvedValue([]),
      };
      rollup = {
        getLatestStats: jest.fn().mockReturnValue(latest),
        getStatsForRange: jest.fn().mockResolvedValue(ranged),
        getWindowStatsWithRetentionPeak: jest.fn().mockResolvedValue(windowed),
        getLatestStatsAllConnections: jest.fn().mockResolvedValue(allLatest),
        getWindowMs: jest.fn().mockReturnValue(WINDOW),
      };
      service = new ClientAnalyticsService(
        {} as never,
        storage as unknown as StoragePort,
        {} as never,
        {} as never,
        {} as never,
        rollup as unknown as ClientAnalyticsRollupService,
        { get: jest.fn() } as unknown as ConfigService,
      );
    });

    afterEach(() => jest.useRealTimers());

    it('serves the in-memory latest window when unbounded with a connection', async () => {
      await expect(service.getStats(undefined, undefined, 'c1')).resolves.toBe(latest);
      expect(storage.getClientAnalyticsStats).not.toHaveBeenCalled();
    });

    it('falls back to the window with the retention peak when no latest exists for the connection', async () => {
      rollup.getLatestStats.mockReturnValue(null);
      await expect(service.getStats(undefined, undefined, 'c1')).resolves.toBe(windowed);
      expect(rollup.getWindowStatsWithRetentionPeak).toHaveBeenCalledWith('c1');
      expect(rollup.getStatsForRange).not.toHaveBeenCalled();
      expect(rollup.getLatestStatsAllConnections).not.toHaveBeenCalled();
      expect(storage.getClientAnalyticsStats).not.toHaveBeenCalled();
    });

    it('serves the memoised all-connection window when unbounded without a connection', async () => {
      await expect(service.getStats()).resolves.toBe(allLatest);
      expect(rollup.getLatestStatsAllConnections).toHaveBeenCalledTimes(1);
      expect(rollup.getStatsForRange).not.toHaveBeenCalled();
      expect(storage.getClientAnalyticsStats).not.toHaveBeenCalled();
    });

    it('uses a bounded raw query for short spans and rollups for long ones', async () => {
      await expect(service.getStats(NOW - HOUR, NOW, 'c1')).resolves.toBe(raw);
      expect(storage.getClientAnalyticsStats).toHaveBeenCalledWith(NOW - HOUR, NOW, 'c1');
      await expect(service.getStats(NOW - RAW_MAX - 1, NOW, 'c1')).resolves.toBe(ranged);
      expect(rollup.getStatsForRange).toHaveBeenCalledWith(NOW - RAW_MAX - 1, NOW, 'c1');
    });

    it('serves a short span without a connection from rollups, never the raw cross-connection fold', async () => {
      await expect(service.getStats(NOW - HOUR, NOW, undefined)).resolves.toBe(ranged);
      expect(rollup.getStatsForRange).toHaveBeenLastCalledWith(NOW - HOUR, NOW, undefined);
      expect(storage.getClientAnalyticsStats).not.toHaveBeenCalled();
    });

    it('fills a missing bound from now and the window', async () => {
      await service.getStats(NOW - HOUR, undefined, 'c1');
      expect(storage.getClientAnalyticsStats).toHaveBeenLastCalledWith(NOW - HOUR, NOW, 'c1');
      await service.getStats(undefined, NOW - HOUR, 'c1');
      expect(rollup.getStatsForRange).toHaveBeenLastCalledWith(NOW - HOUR - WINDOW, NOW - HOUR, 'c1');
    });

    it('treats non-finite stats bounds as absent', async () => {
      await expect(service.getStats(NaN, NaN, 'c1')).resolves.toBe(latest);
      expect(storage.getClientAnalyticsStats).not.toHaveBeenCalled();
      expect(rollup.getStatsForRange).not.toHaveBeenCalled();

      await service.getStats(NOW - HOUR, NaN, 'c1');
      expect(storage.getClientAnalyticsStats).toHaveBeenLastCalledWith(NOW - HOUR, NOW, 'c1');
      await service.getStats(NaN, NOW - HOUR, 'c1');
      expect(rollup.getStatsForRange).toHaveBeenLastCalledWith(NOW - HOUR - WINDOW, NOW - HOUR, 'c1');
      await expect(service.getStats(Infinity, -Infinity)).resolves.toBe(allLatest);
      expect(rollup.getLatestStatsAllConnections).toHaveBeenCalledTimes(1);
      for (const call of [...storage.getClientAnalyticsStats.mock.calls, ...rollup.getStatsForRange.mock.calls]) {
        expect(call.slice(0, 2).every((v: number) => Number.isFinite(v))).toBe(true);
      }
    });

    it('treats non-finite connection history bounds as absent', async () => {
      await service.getConnectionHistory({ name: 'api' }, NaN, NaN, 'c1');
      expect(storage.getClientConnectionHistory).toHaveBeenLastCalledWith({ name: 'api' }, NOW - WINDOW, undefined, 'c1');
      await service.getConnectionHistory({ name: 'api' }, NaN, NOW - HOUR, 'c1');
      expect(storage.getClientConnectionHistory).toHaveBeenLastCalledWith(
        { name: 'api' },
        NOW - HOUR - WINDOW,
        NOW - HOUR,
        'c1',
      );
    });

    it('defaults connection history to the stats window', async () => {
      await service.getConnectionHistory({ name: 'api' }, undefined, undefined, 'c1');
      expect(storage.getClientConnectionHistory).toHaveBeenCalledWith({ name: 'api' }, NOW - WINDOW, undefined, 'c1');
    });
  });

  it('bounds the idle-connections read to the stats window', async () => {
    jest.useFakeTimers({ now: NOW });
    const getClientSnapshots = jest.fn().mockResolvedValue([]);
    // A configured (non-default) window must apply here too.
    const windowMs = 6 * HOUR;
    const analysis = new ClientAnalyticsAnalysisService(
      { getClientSnapshots } as unknown as StoragePort,
      { getWindowMs: () => windowMs } as unknown as ClientAnalyticsRollupService,
    );
    await analysis.getIdleConnections({}, 'c1');
    expect(getClientSnapshots).toHaveBeenCalledWith(expect.objectContaining({ startTime: NOW - windowMs, connectionId: 'c1' }));
    jest.useRealTimers();
  });
});

describe('QueryBudget', () => {
  it('warns once per name over budget, then stays quiet for five minutes', async () => {
    let now = 0;
    const logger = { warn: jest.fn() } as unknown as Logger;
    const budget = new QueryBudget(100, logger, () => now);
    const slow = () => budget.time('getThing', 'c1', async () => {
      now += 150;
      return 1;
    });
    await expect(slow()).resolves.toBe(1);
    await slow();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect((logger.warn as jest.Mock).mock.calls[0][0]).toMatch(/getThing.*c1.*150ms/);
    await budget.time('other', 'c1', async () => {
      now += 150;
    });
    expect(logger.warn).toHaveBeenCalledTimes(2);
    now += 5 * 60_000;
    await slow();
    expect(logger.warn).toHaveBeenCalledTimes(3);
    await budget.time('getThing', 'c1', async () => undefined);
    expect(logger.warn).toHaveBeenCalledTimes(3);
  });

  it('still warns when the call rejects, and rethrows', async () => {
    let now = 0;
    const logger = { warn: jest.fn() } as unknown as Logger;
    const budget = new QueryBudget(10, logger, () => now);
    await expect(
      budget.time('boom', undefined, async () => {
        now += 20;
        throw new Error('x');
      }),
    ).rejects.toThrow('x');
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
