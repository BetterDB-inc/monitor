import { Test, TestingModule } from '@nestjs/testing';
import { MemoryAdapter } from '../../storage/adapters/memory.adapter';
import { MetricForecastingService } from '../metric-forecasting.service';
import { SettingsService } from '../../settings/settings.service';
import { ConnectionRegistry } from '../../connections/connection-registry.service';
import type { AppSettings, MetricForecastSettings, MetricKind } from '@betterdb/shared';
import type { StoredMemorySnapshot } from '../../common/interfaces/storage-port.interface';

// ── Test Helpers ──

function mockGlobalSettings(overrides?: Partial<AppSettings>): AppSettings {
  return {
    id: 1,
    auditPollIntervalMs: 60000,
    clientAnalyticsPollIntervalMs: 60000,
    anomalyPollIntervalMs: 1000,
    anomalyCacheTtlMs: 3600000,
    anomalyPrometheusIntervalMs: 30000,
    metricForecastingEnabled: true,
    metricForecastingDefaultRollingWindowMs: 21600000,
    metricForecastingDefaultAlertThresholdMs: 7200000,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeSettings(overrides?: Partial<MetricForecastSettings>): MetricForecastSettings {
  return {
    connectionId: 'conn-1',
    metricKind: 'opsPerSec',
    enabled: true,
    ceiling: null,
    rollingWindowMs: 21600000,
    alertThresholdMs: 7200000,
    updatedAt: Date.now(),
    ...overrides,
  };
}

function generateSnapshots(opts: {
  count: number;
  startTime: number;
  intervalMs: number;
  startOps?: number;
  endOps?: number;
  startMemory?: number;
  endMemory?: number;
  startCpuSys?: number;
  endCpuSys?: number;
  startCpuUser?: number;
  endCpuUser?: number;
  startFragRatio?: number;
  endFragRatio?: number;
  maxmemory?: number;
  connectionId?: string;
}): StoredMemorySnapshot[] {
  const snapshots: StoredMemorySnapshot[] = [];
  for (let i = 0; i < opts.count; i++) {
    const t = opts.count > 1 ? i / (opts.count - 1) : 0;
    snapshots.push({
      id: `snap-${i}`,
      timestamp: opts.startTime + i * opts.intervalMs,
      usedMemory: Math.round((opts.startMemory ?? 1_000_000) + t * ((opts.endMemory ?? 1_000_000) - (opts.startMemory ?? 1_000_000))),
      usedMemoryRss: 1_200_000,
      usedMemoryPeak: 1_500_000,
      memFragmentationRatio: (opts.startFragRatio ?? 1.2) + t * ((opts.endFragRatio ?? 1.2) - (opts.startFragRatio ?? 1.2)),
      maxmemory: opts.maxmemory ?? 0,
      allocatorFragRatio: 1.0,
      opsPerSec: Math.round((opts.startOps ?? 10_000) + t * ((opts.endOps ?? 10_000) - (opts.startOps ?? 10_000))),
      cpuSys: (opts.startCpuSys ?? 1.0) + t * ((opts.endCpuSys ?? 1.0) - (opts.startCpuSys ?? 1.0)),
      cpuUser: (opts.startCpuUser ?? 2.0) + t * ((opts.endCpuUser ?? 2.0) - (opts.startCpuUser ?? 2.0)),
      ioThreadedReads: 0,
      ioThreadedWrites: 0,
      connectionId: opts.connectionId ?? 'conn-1',
    });
  }
  return snapshots;
}

// ── Test Suite ──

describe('MetricForecastingService', () => {
  let service: MetricForecastingService;
  let storage: MemoryAdapter;
  let settingsService: { getCachedSettings: jest.Mock };

  beforeEach(async () => {
    storage = new MemoryAdapter();
    await storage.initialize();

    settingsService = {
      getCachedSettings: jest.fn().mockReturnValue(mockGlobalSettings()),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MetricForecastingService,
        { provide: 'STORAGE_CLIENT', useValue: storage },
        { provide: SettingsService, useValue: settingsService },
        {
          provide: ConnectionRegistry,
          useValue: { list: jest.fn().mockReturnValue([]), getConfig: jest.fn() },
        },
      ],
    }).compile();

    service = module.get(MetricForecastingService);
  });

  // ── Storage Round-Trip ──

  describe('storage round-trip', () => {
    it('saves and retrieves metric forecast settings', async () => {
      const settings = makeSettings({ ceiling: 80_000 });
      await storage.saveMetricForecastSettings(settings);
      const result = await storage.getMetricForecastSettings('conn-1', 'opsPerSec');
      expect(result).not.toBeNull();
      expect(result!.connectionId).toBe('conn-1');
      expect(result!.metricKind).toBe('opsPerSec');
      expect(result!.ceiling).toBe(80_000);
    });

    it('returns null for missing settings', async () => {
      const result = await storage.getMetricForecastSettings('conn-unknown', 'opsPerSec');
      expect(result).toBeNull();
    });

    it('upsert overwrites existing settings', async () => {
      await storage.saveMetricForecastSettings(makeSettings({ ceiling: 50_000 }));
      await storage.saveMetricForecastSettings(makeSettings({ ceiling: 90_000 }));
      const result = await storage.getMetricForecastSettings('conn-1', 'opsPerSec');
      expect(result!.ceiling).toBe(90_000);
    });

    it('different metric kinds are independent', async () => {
      await storage.saveMetricForecastSettings(makeSettings({ metricKind: 'opsPerSec', ceiling: 80_000 }));
      await storage.saveMetricForecastSettings(makeSettings({ metricKind: 'usedMemory', ceiling: 200_000_000 }));
      const ops = await storage.getMetricForecastSettings('conn-1', 'opsPerSec');
      const mem = await storage.getMetricForecastSettings('conn-1', 'usedMemory');
      expect(ops!.ceiling).toBe(80_000);
      expect(mem!.ceiling).toBe(200_000_000);
    });

    it('getActiveMetricForecastSettings filters correctly', async () => {
      await storage.saveMetricForecastSettings(
        makeSettings({ connectionId: 'a', metricKind: 'opsPerSec', enabled: true, ceiling: 80_000 }),
      );
      await storage.saveMetricForecastSettings(
        makeSettings({ connectionId: 'b', metricKind: 'usedMemory', enabled: true, ceiling: null }),
      );
      await storage.saveMetricForecastSettings(
        makeSettings({ connectionId: 'c', metricKind: 'cpuTotal', enabled: false, ceiling: 80 }),
      );
      const active = await storage.getActiveMetricForecastSettings();
      expect(active).toHaveLength(1);
      expect(active[0].connectionId).toBe('a');
    });
  });

  // ── opsPerSec (same behavior as throughput) ──

  describe('opsPerSec: rising trend, no ceiling', () => {
    it('returns rising trend with correct direction', async () => {
      const now = Date.now();
      await storage.saveMemorySnapshots(
        generateSnapshots({
          count: 60, startTime: now - 60 * 60_000, intervalMs: 60_000,
          startOps: 10_000, endOps: 20_000, connectionId: 'conn-1',
        }),
        'conn-1',
      );

      const forecast = await service.getForecast('conn-1', 'opsPerSec');

      expect(forecast.metricKind).toBe('opsPerSec');
      expect(forecast.mode).toBe('trend');
      expect(forecast.trendDirection).toBe('rising');
      expect(forecast.growthPercent).toBeGreaterThan(5);
      expect(forecast.ceiling).toBeNull();
      expect(forecast.currentValue).toBeGreaterThanOrEqual(19_000);
      expect(forecast.insufficientData).toBe(false);
    });
  });

  describe('opsPerSec: rising trend with ceiling', () => {
    it('returns forecast with time-to-limit', async () => {
      const now = Date.now();
      await storage.saveMemorySnapshots(
        generateSnapshots({
          count: 60, startTime: now - 60 * 60_000, intervalMs: 60_000,
          startOps: 40_000, endOps: 50_000, connectionId: 'conn-1',
        }),
        'conn-1',
      );
      await storage.saveMetricForecastSettings(makeSettings({ ceiling: 80_000 }));

      const forecast = await service.getForecast('conn-1', 'opsPerSec');

      expect(forecast.mode).toBe('forecast');
      expect(forecast.timeToLimitMs).toBeGreaterThan(0);
      expect(forecast.ceiling).toBe(80_000);
    });
  });

  // ── usedMemory ──

  describe('usedMemory: rising trend with auto-detected ceiling', () => {
    it('auto-detects ceiling from maxmemory', async () => {
      const now = Date.now();
      await storage.saveMemorySnapshots(
        generateSnapshots({
          count: 60, startTime: now - 60 * 60_000, intervalMs: 60_000,
          startMemory: 50_000_000, endMemory: 80_000_000,
          maxmemory: 100_000_000, connectionId: 'conn-1',
        }),
        'conn-1',
      );

      const forecast = await service.getForecast('conn-1', 'usedMemory');

      expect(forecast.metricKind).toBe('usedMemory');
      expect(forecast.mode).toBe('forecast');
      expect(forecast.ceiling).toBe(100_000_000);
      expect(forecast.timeToLimitMs).toBeGreaterThan(0);
    });

    it('uses trend mode when maxmemory is 0 and no ceiling set', async () => {
      const now = Date.now();
      await storage.saveMemorySnapshots(
        generateSnapshots({
          count: 60, startTime: now - 60 * 60_000, intervalMs: 60_000,
          startMemory: 50_000_000, endMemory: 80_000_000,
          maxmemory: 0, connectionId: 'conn-1',
        }),
        'conn-1',
      );

      const forecast = await service.getForecast('conn-1', 'usedMemory');

      expect(forecast.mode).toBe('trend');
      expect(forecast.ceiling).toBeNull();
    });
  });

  // ── cpuTotal ──

  describe('cpuTotal: rising trend with default ceiling', () => {
    it('uses default ceiling of 100%', async () => {
      const now = Date.now();
      await storage.saveMemorySnapshots(
        generateSnapshots({
          count: 60, startTime: now - 60 * 60_000, intervalMs: 60_000,
          startCpuSys: 10, endCpuSys: 20, startCpuUser: 20, endCpuUser: 40,
          connectionId: 'conn-1',
        }),
        'conn-1',
      );

      const forecast = await service.getForecast('conn-1', 'cpuTotal');

      expect(forecast.metricKind).toBe('cpuTotal');
      expect(forecast.mode).toBe('forecast');
      expect(forecast.ceiling).toBe(100);
      expect(forecast.trendDirection).toBe('rising');
      expect(forecast.timeToLimitMs).toBeGreaterThan(0);
    });
  });

  // ── memFragmentation ──

  describe('memFragmentation: rising trend with default ceiling', () => {
    it('uses default ceiling of 1.5', async () => {
      const now = Date.now();
      await storage.saveMemorySnapshots(
        generateSnapshots({
          count: 60, startTime: now - 60 * 60_000, intervalMs: 60_000,
          startFragRatio: 1.0, endFragRatio: 1.3,
          connectionId: 'conn-1',
        }),
        'conn-1',
      );

      const forecast = await service.getForecast('conn-1', 'memFragmentation');

      expect(forecast.metricKind).toBe('memFragmentation');
      expect(forecast.mode).toBe('forecast');
      expect(forecast.ceiling).toBe(1.5);
      expect(forecast.trendDirection).toBe('rising');
      expect(forecast.timeToLimitMs).toBeGreaterThan(0);
    });
  });

  // ── Insufficient data ──

  describe('insufficient data', () => {
    it.each<MetricKind>(['opsPerSec', 'usedMemory', 'cpuTotal', 'memFragmentation'])(
      '%s: no snapshots returns insufficient data',
      async (metricKind) => {
        const forecast = await service.getForecast('conn-1', metricKind);
        expect(forecast.insufficientData).toBe(true);
        expect(forecast.metricKind).toBe(metricKind);
      },
    );
  });

  // ── Disabled ──

  describe('disabled', () => {
    it('globally disabled returns enabled=false', async () => {
      settingsService.getCachedSettings.mockReturnValue(
        mockGlobalSettings({ metricForecastingEnabled: false }),
      );
      const forecast = await service.getForecast('conn-1', 'usedMemory');
      expect(forecast.enabled).toBe(false);
    });

    it('per-connection disabled returns enabled=false', async () => {
      await storage.saveMetricForecastSettings(
        makeSettings({ metricKind: 'cpuTotal', enabled: false }),
      );
      const forecast = await service.getForecast('conn-1', 'cpuTotal');
      expect(forecast.enabled).toBe(false);
    });
  });

  // ── Settings management ──

  describe('settings management', () => {
    it('first access creates settings from global defaults', async () => {
      const settings = await service.getSettings('conn-1', 'usedMemory');
      expect(settings.metricKind).toBe('usedMemory');
      expect(settings.enabled).toBe(true);
      expect(settings.ceiling).toBeNull();
      expect(settings.rollingWindowMs).toBe(21600000);
    });

    it('update merges with existing settings', async () => {
      const updated = await service.updateSettings('conn-1', 'opsPerSec', { ceiling: 80_000 });
      expect(updated.ceiling).toBe(80_000);
      expect(updated.rollingWindowMs).toBe(21600000);
    });

    it('update invalidates forecast cache', async () => {
      const now = Date.now();
      await storage.saveMemorySnapshots(
        generateSnapshots({
          count: 60, startTime: now - 60 * 60_000, intervalMs: 60_000,
          startOps: 40_000, endOps: 50_000, connectionId: 'conn-1',
        }),
        'conn-1',
      );

      const first = await service.getForecast('conn-1', 'opsPerSec');
      expect(first.mode).toBe('trend');

      await service.updateSettings('conn-1', 'opsPerSec', { ceiling: 80_000 });

      const second = await service.getForecast('conn-1', 'opsPerSec');
      expect(second.mode).toBe('forecast');
    });
  });

  // ── Ceiling exceeded ── (H2)

  describe('ceiling already exceeded', () => {
    it('memory above maxmemory returns exceeded', async () => {
      const now = Date.now();
      await storage.saveMemorySnapshots(
        generateSnapshots({
          count: 60, startTime: now - 60 * 60_000, intervalMs: 60_000,
          startMemory: 90_000_000, endMemory: 110_000_000,
          maxmemory: 100_000_000, connectionId: 'conn-1',
        }),
        'conn-1',
      );

      const forecast = await service.getForecast('conn-1', 'usedMemory');

      expect(forecast.mode).toBe('forecast');
      expect(forecast.timeToLimitMs).toBe(0);
      expect(forecast.timeToLimitHuman).toMatch(/exceeded/i);
    });

    it('CPU above ceiling returns exceeded', async () => {
      const now = Date.now();
      await storage.saveMemorySnapshots(
        generateSnapshots({
          count: 60, startTime: now - 60 * 60_000, intervalMs: 60_000,
          startCpuSys: 40, endCpuSys: 55, startCpuUser: 40, endCpuUser: 55,
          connectionId: 'conn-1',
        }),
        'conn-1',
      );

      const forecast = await service.getForecast('conn-1', 'cpuTotal');

      expect(forecast.mode).toBe('forecast');
      expect(forecast.timeToLimitMs).toBe(0);
      expect(forecast.timeToLimitHuman).toMatch(/exceeded/i);
    });
  });

  // ── Falling/stable for non-ops metrics ── (H3)

  describe('falling/stable trends with ceiling', () => {
    it('falling memory returns not projected', async () => {
      const now = Date.now();
      await storage.saveMemorySnapshots(
        generateSnapshots({
          count: 60, startTime: now - 60 * 60_000, intervalMs: 60_000,
          startMemory: 80_000_000, endMemory: 60_000_000,
          maxmemory: 100_000_000, connectionId: 'conn-1',
        }),
        'conn-1',
      );

      const forecast = await service.getForecast('conn-1', 'usedMemory');

      expect(forecast.mode).toBe('forecast');
      expect(forecast.trendDirection).toBe('falling');
      expect(forecast.timeToLimitMs).toBeNull();
      expect(forecast.timeToLimitHuman).toContain('Not projected');
    });

    it('stable CPU returns not projected', async () => {
      const now = Date.now();
      await storage.saveMemorySnapshots(
        generateSnapshots({
          count: 60, startTime: now - 60 * 60_000, intervalMs: 60_000,
          startCpuSys: 25, endCpuSys: 25, startCpuUser: 25, endCpuUser: 25,
          connectionId: 'conn-1',
        }),
        'conn-1',
      );

      const forecast = await service.getForecast('conn-1', 'cpuTotal');

      expect(forecast.mode).toBe('forecast');
      expect(forecast.trendDirection).toBe('stable');
      expect(forecast.timeToLimitMs).toBeNull();
    });

    it('falling fragmentation returns not projected', async () => {
      const now = Date.now();
      await storage.saveMemorySnapshots(
        generateSnapshots({
          count: 60, startTime: now - 60 * 60_000, intervalMs: 60_000,
          startFragRatio: 1.4, endFragRatio: 1.1,
          connectionId: 'conn-1',
        }),
        'conn-1',
      );

      const forecast = await service.getForecast('conn-1', 'memFragmentation');

      expect(forecast.trendDirection).toBe('falling');
      expect(forecast.timeToLimitMs).toBeNull();
    });
  });

  // ── Zero slope / flat values ── (H4)

  describe('zero slope (identical values)', () => {
    it('flat opsPerSec returns stable trend', async () => {
      const now = Date.now();
      await storage.saveMemorySnapshots(
        generateSnapshots({
          count: 60, startTime: now - 60 * 60_000, intervalMs: 60_000,
          startOps: 5_000, endOps: 5_000, connectionId: 'conn-1',
        }),
        'conn-1',
      );

      const forecast = await service.getForecast('conn-1', 'opsPerSec');

      expect(forecast.trendDirection).toBe('stable');
      expect(forecast.growthRate).toBeCloseTo(0, 1);
      expect(forecast.growthPercent).toBeCloseTo(0, 1);
    });

    it('flat memory with ceiling returns not projected', async () => {
      const now = Date.now();
      await storage.saveMemorySnapshots(
        generateSnapshots({
          count: 60, startTime: now - 60 * 60_000, intervalMs: 60_000,
          startMemory: 50_000_000, endMemory: 50_000_000,
          maxmemory: 100_000_000, connectionId: 'conn-1',
        }),
        'conn-1',
      );

      const forecast = await service.getForecast('conn-1', 'usedMemory');

      expect(forecast.trendDirection).toBe('stable');
      expect(forecast.timeToLimitMs).toBeNull();
    });
  });

  // ── Connection isolation ── (M1)

  describe('connection isolation', () => {
    it('different connections return independent forecasts', async () => {
      const now = Date.now();
      await storage.saveMemorySnapshots(
        generateSnapshots({
          count: 60, startTime: now - 60 * 60_000, intervalMs: 60_000,
          startOps: 10_000, endOps: 20_000, connectionId: 'conn-a',
        }),
        'conn-a',
      );
      await storage.saveMemorySnapshots(
        generateSnapshots({
          count: 60, startTime: now - 60 * 60_000, intervalMs: 60_000,
          startOps: 50_000, endOps: 40_000, connectionId: 'conn-b',
        }),
        'conn-b',
      );

      const forecastA = await service.getForecast('conn-a', 'opsPerSec');
      const forecastB = await service.getForecast('conn-b', 'opsPerSec');

      expect(forecastA.trendDirection).toBe('rising');
      expect(forecastB.trendDirection).toBe('falling');
    });
  });

  // ── Boundary conditions ── (M2)

  describe('data sufficiency boundaries', () => {
    it('exactly 3 snapshots spanning 30 min is sufficient', async () => {
      const now = Date.now();
      await storage.saveMemorySnapshots(
        generateSnapshots({
          count: 3, startTime: now - 30 * 60_000, intervalMs: 15 * 60_000,
          startOps: 10_000, endOps: 20_000, connectionId: 'conn-1',
        }),
        'conn-1',
      );

      const forecast = await service.getForecast('conn-1', 'opsPerSec');
      expect(forecast.insufficientData).toBe(false);
    });

    it('3 snapshots spanning 29 min is insufficient', async () => {
      const now = Date.now();
      await storage.saveMemorySnapshots(
        generateSnapshots({
          count: 3, startTime: now - 29 * 60_000, intervalMs: 14.5 * 60_000,
          startOps: 10_000, endOps: 20_000, connectionId: 'conn-1',
        }),
        'conn-1',
      );

      const forecast = await service.getForecast('conn-1', 'opsPerSec');
      expect(forecast.insufficientData).toBe(true);
    });

    it('2 snapshots spanning 60 min is insufficient (below MIN_DATA_POINTS)', async () => {
      const now = Date.now();
      await storage.saveMemorySnapshots(
        generateSnapshots({
          count: 2, startTime: now - 60 * 60_000, intervalMs: 60 * 60_000,
          startOps: 10_000, endOps: 20_000, connectionId: 'conn-1',
        }),
        'conn-1',
      );

      const forecast = await service.getForecast('conn-1', 'opsPerSec');
      expect(forecast.insufficientData).toBe(true);
    });
  });

  // ── Alert dispatch ── (H1)

  describe('checkAlerts', () => {
    let webhookService: { dispatchMetricForecastLimit: jest.Mock };
    let connectionRegistry: { list: jest.Mock; getConfig: jest.Mock };

    beforeEach(async () => {
      storage = new MemoryAdapter();
      await storage.initialize();

      webhookService = {
        dispatchMetricForecastLimit: jest.fn().mockResolvedValue(undefined),
      };
      connectionRegistry = {
        list: jest.fn().mockReturnValue([]),
        getConfig: jest.fn().mockReturnValue({ host: 'localhost', port: 6380 }),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          MetricForecastingService,
          { provide: 'STORAGE_CLIENT', useValue: storage },
          { provide: SettingsService, useValue: { getCachedSettings: jest.fn().mockReturnValue(mockGlobalSettings()) } },
          { provide: ConnectionRegistry, useValue: connectionRegistry },
          { provide: 'WEBHOOK_EVENTS_PRO_SERVICE', useValue: webhookService },
        ],
      }).compile();

      service = module.get(MetricForecastingService);
    });

    it('dispatches alert when time-to-limit is within threshold', async () => {
      const now = Date.now();
      // Rising ops, ceiling 80k, should project ~3h to limit
      await storage.saveMemorySnapshots(
        generateSnapshots({
          count: 60, startTime: now - 60 * 60_000, intervalMs: 60_000,
          startOps: 40_000, endOps: 50_000, connectionId: 'conn-1',
        }),
        'conn-1',
      );
      // Set ceiling + alert threshold of 4h so the ~3h projection triggers
      await storage.saveMetricForecastSettings(
        makeSettings({
          ceiling: 80_000,
          alertThresholdMs: 4 * 3_600_000,
        }),
      );

      // Trigger the private checkAlerts by accessing it via prototype
      await (service as any).checkAlerts();

      expect(webhookService.dispatchMetricForecastLimit).toHaveBeenCalledTimes(1);
      expect(webhookService.dispatchMetricForecastLimit).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'metric_forecast.limit',
          metricKind: 'opsPerSec',
          connectionId: 'conn-1',
        }),
      );
    });

    it('dispatches with safe values for hysteresis recovery when time-to-limit exceeds threshold', async () => {
      const now = Date.now();
      await storage.saveMemorySnapshots(
        generateSnapshots({
          count: 60, startTime: now - 60 * 60_000, intervalMs: 60_000,
          startOps: 40_000, endOps: 50_000, connectionId: 'conn-1',
        }),
        'conn-1',
      );
      // Ceiling very far away, alert threshold small
      await storage.saveMetricForecastSettings(
        makeSettings({
          ceiling: 500_000,
          alertThresholdMs: 1_800_000, // 30 min — projection is much longer
        }),
      );

      await (service as any).checkAlerts();

      expect(webhookService.dispatchMetricForecastLimit).toHaveBeenCalledTimes(1);
      const call = webhookService.dispatchMetricForecastLimit.mock.calls[0][0];
      expect(call.timeToLimitMs).toBeGreaterThan(1_800_000);
    });

    it('does not dispatch for disabled settings', async () => {
      await storage.saveMetricForecastSettings(
        makeSettings({
          ceiling: 80_000,
          enabled: false,
          alertThresholdMs: 999_999_999,
        }),
      );

      await (service as any).checkAlerts();

      expect(webhookService.dispatchMetricForecastLimit).not.toHaveBeenCalled();
    });
  });

  // ── Cache ──

  describe('forecast cache', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('second call within TTL uses cache', async () => {
      const now = Date.now();
      await storage.saveMemorySnapshots(
        generateSnapshots({
          count: 60, startTime: now - 60 * 60_000, intervalMs: 60_000,
          startOps: 10_000, endOps: 20_000, connectionId: 'conn-1',
        }),
        'conn-1',
      );

      const spy = jest.spyOn(storage, 'getMemorySnapshots');
      await service.getForecast('conn-1', 'opsPerSec');
      await service.getForecast('conn-1', 'opsPerSec');
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('different metric kinds have separate caches', async () => {
      const now = Date.now();
      await storage.saveMemorySnapshots(
        generateSnapshots({
          count: 60, startTime: now - 60 * 60_000, intervalMs: 60_000,
          startOps: 10_000, endOps: 20_000, connectionId: 'conn-1',
        }),
        'conn-1',
      );

      const spy = jest.spyOn(storage, 'getMemorySnapshots');
      await service.getForecast('conn-1', 'opsPerSec');
      await service.getForecast('conn-1', 'usedMemory');
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('cache expires after TTL', async () => {
      const now = Date.now();
      await storage.saveMemorySnapshots(
        generateSnapshots({
          count: 60, startTime: now - 60 * 60_000, intervalMs: 60_000,
          startOps: 10_000, endOps: 20_000, connectionId: 'conn-1',
        }),
        'conn-1',
      );

      const spy = jest.spyOn(storage, 'getMemorySnapshots');
      await service.getForecast('conn-1', 'opsPerSec');
      jest.advanceTimersByTime(61_000);
      await service.getForecast('conn-1', 'opsPerSec');
      expect(spy).toHaveBeenCalledTimes(2);
    });
  });
});
