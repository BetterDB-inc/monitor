import { MemoryAdapter } from '../memory.adapter';
import { SqliteAdapter } from '../sqlite.adapter';
import type { AppSettings } from '@betterdb/shared';

function buildSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  const now = Date.now();
  return {
    id: 1,
    auditPollIntervalMs: 60_000,
    clientAnalyticsPollIntervalMs: 60_000,
    anomalyPollIntervalMs: 1_000,
    anomalyCacheTtlMs: 3_600_000,
    anomalyPrometheusIntervalMs: 30_000,
    metricForecastingEnabled: true,
    metricForecastingDefaultRollingWindowMs: 21_600_000,
    metricForecastingDefaultAlertThresholdMs: 7_200_000,
    inferenceSlaConfig: {},
    anomalyDetectorConfig: {},
    localRetentionDays: null,
    updatedAt: now,
    createdAt: now,
    ...overrides,
  };
}

const cfg = {
  connections: { warningZScore: 2.7 },
  acl_denied: { criticalAbsolute: 60 },
} as AppSettings['anomalyDetectorConfig'];

describe('anomalyDetectorConfig round-trip', () => {
  describe('SqliteAdapter', () => {
    it('persists via saveSettings and clears via updateSettings', async () => {
      const storage = new SqliteAdapter({ filepath: ':memory:' });
      await storage.initialize();

      await storage.saveSettings(buildSettings({ anomalyDetectorConfig: cfg }));
      expect((await storage.getSettings())?.anomalyDetectorConfig).toEqual(cfg);

      await storage.updateSettings({ anomalyDetectorConfig: {} });
      expect((await storage.getSettings())?.anomalyDetectorConfig).toEqual({});
      await storage.close();
    });

    it('keeps the config when an unrelated field is updated', async () => {
      const storage = new SqliteAdapter({ filepath: ':memory:' });
      await storage.initialize();

      await storage.saveSettings(buildSettings({ anomalyDetectorConfig: cfg }));
      await storage.updateSettings({ anomalyPollIntervalMs: 2_000 });

      const loaded = await storage.getSettings();
      expect(loaded?.anomalyDetectorConfig).toEqual(cfg);
      expect(loaded?.anomalyPollIntervalMs).toBe(2_000);
      await storage.close();
    });
  });

  describe('disabled absolute threshold (Infinity sentinel)', () => {
    const disabled = {
      acl_denied: { criticalAbsolute: Number.POSITIVE_INFINITY },
    } as AppSettings['anomalyDetectorConfig'];

    it('SqliteAdapter round-trips Infinity, not null', async () => {
      const storage = new SqliteAdapter({ filepath: ':memory:' });
      await storage.initialize();
      await storage.saveSettings(buildSettings({ anomalyDetectorConfig: disabled }));
      expect(
        (await storage.getSettings())?.anomalyDetectorConfig?.acl_denied?.criticalAbsolute,
      ).toBe(Number.POSITIVE_INFINITY);

      // Survives an unrelated whole-row update too.
      await storage.updateSettings({ anomalyPollIntervalMs: 2_000 });
      expect(
        (await storage.getSettings())?.anomalyDetectorConfig?.acl_denied?.criticalAbsolute,
      ).toBe(Number.POSITIVE_INFINITY);
      await storage.close();
    });
  });

  describe('MemoryAdapter', () => {
    it('persists the config through save and partial update', async () => {
      const storage = new MemoryAdapter();
      await storage.initialize();

      await storage.saveSettings(buildSettings({ anomalyDetectorConfig: cfg }));
      expect((await storage.getSettings())?.anomalyDetectorConfig).toEqual(cfg);

      const updated = await storage.updateSettings({ anomalyDetectorConfig: {} });
      expect(updated.anomalyDetectorConfig).toEqual({});
    });
  });
});
