import { Test, TestingModule } from '@nestjs/testing';
import { MemoryAdapter } from '../../storage/adapters/memory.adapter';
import { ThroughputForecastingService } from '../throughput-forecasting.service';
import { SettingsService } from '../../settings/settings.service';
import { ConnectionRegistry } from '../../connections/connection-registry.service';
import type { AppSettings } from '@betterdb/shared';
import type { ThroughputSettings } from '@betterdb/shared';
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
    throughputForecastingEnabled: true,
    throughputForecastingDefaultRollingWindowMs: 21600000,
    throughputForecastingDefaultAlertThresholdMs: 7200000,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeThroughputSettings(overrides?: Partial<ThroughputSettings>): ThroughputSettings {
  return {
    connectionId: 'conn-1',
    enabled: true,
    opsCeiling: null,
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
  startOps: number;
  endOps: number;
  connectionId?: string;
}): StoredMemorySnapshot[] {
  const snapshots: StoredMemorySnapshot[] = [];
  for (let i = 0; i < opts.count; i++) {
    const t = i / (opts.count - 1);
    snapshots.push({
      id: `snap-${i}`,
      timestamp: opts.startTime + i * opts.intervalMs,
      usedMemory: 1000000,
      usedMemoryRss: 1200000,
      usedMemoryPeak: 1500000,
      memFragmentationRatio: 1.2,
      maxmemory: 0,
      allocatorFragRatio: 1.0,
      opsPerSec: Math.round(opts.startOps + t * (opts.endOps - opts.startOps)),
      cpuSys: 1.0,
      cpuUser: 2.0,
      ioThreadedReads: 0,
      ioThreadedWrites: 0,
      connectionId: opts.connectionId ?? 'conn-1',
    });
  }
  return snapshots;
}

// ── Test Suite ──

describe('ThroughputForecastingService', () => {
  let service: ThroughputForecastingService;
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
        ThroughputForecastingService,
        { provide: 'STORAGE_CLIENT', useValue: storage },
        { provide: SettingsService, useValue: settingsService },
        {
          provide: ConnectionRegistry,
          useValue: { list: jest.fn().mockReturnValue([]), getConfig: jest.fn() },
        },
      ],
    }).compile();

    service = module.get(ThroughputForecastingService);
  });

  // ── Slice 1: Storage Round-Trip ──

  describe('Slice 1: Storage round-trip', () => {
    it('1a: saves and retrieves throughput settings', async () => {
      const settings = makeThroughputSettings({ connectionId: 'conn-1', opsCeiling: 80000 });
      await storage.saveThroughputSettings(settings);
      const result = await storage.getThroughputSettings('conn-1');
      expect(result).not.toBeNull();
      expect(result!.connectionId).toBe('conn-1');
      expect(result!.opsCeiling).toBe(80000);
      expect(result!.enabled).toBe(true);
      expect(result!.rollingWindowMs).toBe(21600000);
    });

    it('1b: returns null for missing connection', async () => {
      const result = await storage.getThroughputSettings('conn-unknown');
      expect(result).toBeNull();
    });

    it('1c: upsert overwrites existing settings', async () => {
      await storage.saveThroughputSettings(makeThroughputSettings({ opsCeiling: 50000 }));
      await storage.saveThroughputSettings(makeThroughputSettings({ opsCeiling: 90000 }));
      const result = await storage.getThroughputSettings('conn-1');
      expect(result!.opsCeiling).toBe(90000);
    });

    it('1d: delete removes settings and returns true', async () => {
      await storage.saveThroughputSettings(makeThroughputSettings());
      const deleted = await storage.deleteThroughputSettings('conn-1');
      expect(deleted).toBe(true);
      const result = await storage.getThroughputSettings('conn-1');
      expect(result).toBeNull();
    });

    it('1e: delete non-existent returns false', async () => {
      const deleted = await storage.deleteThroughputSettings('conn-unknown');
      expect(deleted).toBe(false);
    });

    it('1f: getActiveThroughputSettings filters correctly', async () => {
      await storage.saveThroughputSettings(
        makeThroughputSettings({ connectionId: 'conn-a', enabled: true, opsCeiling: 80000 }),
      );
      await storage.saveThroughputSettings(
        makeThroughputSettings({ connectionId: 'conn-b', enabled: true, opsCeiling: null }),
      );
      await storage.saveThroughputSettings(
        makeThroughputSettings({ connectionId: 'conn-c', enabled: false, opsCeiling: 80000 }),
      );
      const active = await storage.getActiveThroughputSettings();
      expect(active).toHaveLength(1);
      expect(active[0].connectionId).toBe('conn-a');
    });
  });

  // ── Slice 2: Rising Trend, No Ceiling ──

  describe('Slice 2: Rising trend, no ceiling', () => {
    it('2a: returns rising trend with correct direction and growth', async () => {
      const now = Date.now();
      const snapshots = generateSnapshots({
        count: 60,
        startTime: now - 60 * 60_000,
        intervalMs: 60_000,
        startOps: 10_000,
        endOps: 20_000,
        connectionId: 'conn-1',
      });
      await storage.saveMemorySnapshots(snapshots, 'conn-1');

      const forecast = await service.getForecast('conn-1');

      expect(forecast.mode).toBe('trend');
      expect(forecast.trendDirection).toBe('rising');
      expect(forecast.growthPercent).toBeGreaterThan(5);
      expect(forecast.timeToLimitMs).toBeNull();
      expect(forecast.opsCeiling).toBeNull();
      expect(forecast.currentOpsPerSec).toBeGreaterThanOrEqual(19_000);
      expect(forecast.insufficientData).toBe(false);
      expect(forecast.enabled).toBe(true);
      expect(forecast.dataPointCount).toBe(60);
    });
  });

  // ── Slice 3: Rising Trend with Ceiling ──

  describe('Slice 3: Rising trend with ceiling', () => {
    it('3a: returns forecast with time-to-limit', async () => {
      const now = Date.now();
      const snapshots = generateSnapshots({
        count: 60,
        startTime: now - 60 * 60_000,
        intervalMs: 60_000,
        startOps: 40_000,
        endOps: 50_000,
        connectionId: 'conn-1',
      });
      await storage.saveMemorySnapshots(snapshots, 'conn-1');
      await storage.saveThroughputSettings(makeThroughputSettings({ opsCeiling: 80_000 }));

      const forecast = await service.getForecast('conn-1');

      expect(forecast.mode).toBe('forecast');
      expect(forecast.timeToLimitMs).toBeGreaterThan(0);
      expect(forecast.timeToLimitHuman).toContain('at current growth rate');
      expect(forecast.opsCeiling).toBe(80_000);
    });

    it('3b: time-to-limit is approximately correct', async () => {
      const now = Date.now();
      // Growth: 10k/hr, current ~50k, ceiling 80k => ~3h to limit
      const snapshots = generateSnapshots({
        count: 60,
        startTime: now - 60 * 60_000,
        intervalMs: 60_000,
        startOps: 40_000,
        endOps: 50_000,
        connectionId: 'conn-1',
      });
      await storage.saveMemorySnapshots(snapshots, 'conn-1');
      await storage.saveThroughputSettings(makeThroughputSettings({ opsCeiling: 80_000 }));

      const forecast = await service.getForecast('conn-1');
      const threeHoursMs = 3 * 3_600_000;

      expect(forecast.timeToLimitMs).toBeGreaterThan(threeHoursMs * 0.8);
      expect(forecast.timeToLimitMs).toBeLessThan(threeHoursMs * 1.2);
    });
  });

  // ── Slice 4: Falling/Stable Trend with Ceiling ──

  describe('Slice 4: Falling/stable trend with ceiling', () => {
    it('4a: falling trend returns not projected', async () => {
      const now = Date.now();
      const snapshots = generateSnapshots({
        count: 60,
        startTime: now - 60 * 60_000,
        intervalMs: 60_000,
        startOps: 50_000,
        endOps: 40_000,
        connectionId: 'conn-1',
      });
      await storage.saveMemorySnapshots(snapshots, 'conn-1');
      await storage.saveThroughputSettings(makeThroughputSettings({ opsCeiling: 80_000 }));

      const forecast = await service.getForecast('conn-1');

      expect(forecast.mode).toBe('forecast');
      expect(forecast.trendDirection).toBe('falling');
      expect(forecast.timeToLimitMs).toBeNull();
      expect(forecast.timeToLimitHuman).toContain('Not projected');
    });

    it('4b: stable trend returns not projected', async () => {
      const now = Date.now();
      const snapshots = generateSnapshots({
        count: 60,
        startTime: now - 60 * 60_000,
        intervalMs: 60_000,
        startOps: 50_000,
        endOps: 50_000,
        connectionId: 'conn-1',
      });
      await storage.saveMemorySnapshots(snapshots, 'conn-1');
      await storage.saveThroughputSettings(makeThroughputSettings({ opsCeiling: 80_000 }));

      const forecast = await service.getForecast('conn-1');

      expect(forecast.mode).toBe('forecast');
      expect(forecast.trendDirection).toBe('stable');
      expect(forecast.timeToLimitMs).toBeNull();
    });
  });

  // ── Slice 5: Ceiling Already Exceeded ──

  describe('Slice 5: Ceiling already exceeded', () => {
    it('5a: returns exceeded when ops above ceiling', async () => {
      const now = Date.now();
      const snapshots = generateSnapshots({
        count: 60,
        startTime: now - 60 * 60_000,
        intervalMs: 60_000,
        startOps: 85_000,
        endOps: 90_000,
        connectionId: 'conn-1',
      });
      await storage.saveMemorySnapshots(snapshots, 'conn-1');
      await storage.saveThroughputSettings(makeThroughputSettings({ opsCeiling: 80_000 }));

      const forecast = await service.getForecast('conn-1');

      expect(forecast.mode).toBe('forecast');
      expect(forecast.timeToLimitHuman).toMatch(/exceeded/i);
    });
  });

  // ── Slice 6: Insufficient Data ──

  describe('Slice 6: Insufficient data', () => {
    it('6a: no snapshots returns insufficient data', async () => {
      const forecast = await service.getForecast('conn-1');
      expect(forecast.insufficientData).toBe(true);
      expect(forecast.insufficientDataMessage).toBeDefined();
    });

    it('6b: only 2 snapshots returns insufficient', async () => {
      const now = Date.now();
      const snapshots = generateSnapshots({
        count: 2,
        startTime: now - 10 * 60_000,
        intervalMs: 5 * 60_000,
        startOps: 10_000,
        endOps: 20_000,
        connectionId: 'conn-1',
      });
      await storage.saveMemorySnapshots(snapshots, 'conn-1');

      const forecast = await service.getForecast('conn-1');
      expect(forecast.insufficientData).toBe(true);
    });

    it('6c: 5 snapshots but < 30 min span returns insufficient', async () => {
      const now = Date.now();
      const snapshots = generateSnapshots({
        count: 5,
        startTime: now - 20 * 60_000,
        intervalMs: 5 * 60_000,
        startOps: 10_000,
        endOps: 20_000,
        connectionId: 'conn-1',
      });
      await storage.saveMemorySnapshots(snapshots, 'conn-1');

      const forecast = await service.getForecast('conn-1');
      expect(forecast.insufficientData).toBe(true);
    });

    it('6d: exactly 30 min is sufficient', async () => {
      const now = Date.now();
      const snapshots = generateSnapshots({
        count: 31,
        startTime: now - 30 * 60_000,
        intervalMs: 60_000,
        startOps: 10_000,
        endOps: 20_000,
        connectionId: 'conn-1',
      });
      await storage.saveMemorySnapshots(snapshots, 'conn-1');

      const forecast = await service.getForecast('conn-1');
      expect(forecast.insufficientData).toBe(false);
    });

    it('6e: insufficient data still returns currentOpsPerSec', async () => {
      const now = Date.now();
      const snapshots = generateSnapshots({
        count: 2,
        startTime: now - 10 * 60_000,
        intervalMs: 5 * 60_000,
        startOps: 40_000,
        endOps: 45_000,
        connectionId: 'conn-1',
      });
      await storage.saveMemorySnapshots(snapshots, 'conn-1');

      const forecast = await service.getForecast('conn-1');
      expect(forecast.insufficientData).toBe(true);
      expect(forecast.currentOpsPerSec).toBe(45_000);
    });
  });

  // ── Slice 7: Lazy Settings Creation ──

  describe('Slice 7: Lazy settings creation', () => {
    it('7a: first access creates row from global defaults', async () => {
      settingsService.getCachedSettings.mockReturnValue(
        mockGlobalSettings({ throughputForecastingDefaultRollingWindowMs: 43200000 }),
      );

      const settings = await service.getSettings('conn-1');

      expect(settings.rollingWindowMs).toBe(43200000);
      expect(settings.enabled).toBe(true);
      expect(settings.opsCeiling).toBeNull();

      // Verify row was persisted
      const persisted = await storage.getThroughputSettings('conn-1');
      expect(persisted).not.toBeNull();
      expect(persisted!.rollingWindowMs).toBe(43200000);
    });

    it('7b: global disabled returns disabled settings without persisting', async () => {
      settingsService.getCachedSettings.mockReturnValue(
        mockGlobalSettings({ throughputForecastingEnabled: false }),
      );

      const settings = await service.getSettings('conn-1');

      expect(settings.enabled).toBe(false);

      // Verify no row was persisted
      const persisted = await storage.getThroughputSettings('conn-1');
      expect(persisted).toBeNull();
    });
  });

  // ── Slice 8: Update Settings and Cache Invalidation ──

  describe('Slice 8: Update settings', () => {
    it('8a: update merges with existing settings', async () => {
      const now = Date.now();
      await storage.saveMemorySnapshots(
        generateSnapshots({
          count: 60,
          startTime: now - 60 * 60_000,
          intervalMs: 60_000,
          startOps: 10_000,
          endOps: 20_000,
          connectionId: 'conn-1',
        }),
        'conn-1',
      );

      const updated = await service.updateSettings('conn-1', { opsCeiling: 80_000 });

      expect(updated.opsCeiling).toBe(80_000);
      expect(updated.rollingWindowMs).toBe(21600000); // unchanged default
    });

    it('8b: update invalidates forecast cache', async () => {
      const now = Date.now();
      await storage.saveMemorySnapshots(
        generateSnapshots({
          count: 60,
          startTime: now - 60 * 60_000,
          intervalMs: 60_000,
          startOps: 40_000,
          endOps: 50_000,
          connectionId: 'conn-1',
        }),
        'conn-1',
      );

      // First forecast: trend mode (no ceiling)
      const first = await service.getForecast('conn-1');
      expect(first.mode).toBe('trend');

      // Update settings with a ceiling
      await service.updateSettings('conn-1', { opsCeiling: 80_000 });

      // Second forecast should reflect new ceiling, not cached result
      const second = await service.getForecast('conn-1');
      expect(second.mode).toBe('forecast');
    });
  });

  // ── Slice 9: Per-Connection Disabled ──

  describe('Slice 9: Per-connection disabled', () => {
    it('9a: disabled connection returns enabled false', async () => {
      await storage.saveThroughputSettings(makeThroughputSettings({ enabled: false }));

      const forecast = await service.getForecast('conn-1');

      expect(forecast.enabled).toBe(false);
    });

    it('9b: re-enable returns valid forecast', async () => {
      const now = Date.now();
      await storage.saveMemorySnapshots(
        generateSnapshots({
          count: 60,
          startTime: now - 60 * 60_000,
          intervalMs: 60_000,
          startOps: 10_000,
          endOps: 20_000,
          connectionId: 'conn-1',
        }),
        'conn-1',
      );
      await storage.saveThroughputSettings(makeThroughputSettings({ enabled: false }));

      // Disable returns enabled false
      const disabled = await service.getForecast('conn-1');
      expect(disabled.enabled).toBe(false);

      // Re-enable
      await service.updateSettings('conn-1', { enabled: true });
      const enabled = await service.getForecast('conn-1');
      expect(enabled.enabled).toBe(true);
      expect(enabled.insufficientData).toBe(false);
    });
  });

  // ── Slice 10: Forecast Cache ──

  describe('Slice 10: Forecast cache', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('10a: second call within TTL uses cache', async () => {
      const now = Date.now();
      await storage.saveMemorySnapshots(
        generateSnapshots({
          count: 60,
          startTime: now - 60 * 60_000,
          intervalMs: 60_000,
          startOps: 10_000,
          endOps: 20_000,
          connectionId: 'conn-1',
        }),
        'conn-1',
      );

      const spy = jest.spyOn(storage, 'getMemorySnapshots');

      await service.getForecast('conn-1');
      await service.getForecast('conn-1');

      expect(spy.mock.calls.length).toBe(1);
    });

    it('10b: call after TTL expires recomputes', async () => {
      const now = Date.now();
      await storage.saveMemorySnapshots(
        generateSnapshots({
          count: 60,
          startTime: now - 60 * 60_000,
          intervalMs: 60_000,
          startOps: 10_000,
          endOps: 20_000,
          connectionId: 'conn-1',
        }),
        'conn-1',
      );

      const spy = jest.spyOn(storage, 'getMemorySnapshots');

      await service.getForecast('conn-1');
      jest.advanceTimersByTime(61_000);
      await service.getForecast('conn-1');

      expect(spy.mock.calls.length).toBe(2);
    });
  });
});
