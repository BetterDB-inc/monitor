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
    localRetentionDays: null,
    updatedAt: now,
    createdAt: now,
    ...overrides,
  };
}

describe('localRetentionDays round-trip', () => {
  describe('SqliteAdapter', () => {
    it('persists and reloads a configured retention window', async () => {
      const storage = new SqliteAdapter({ filepath: ':memory:' });
      await storage.initialize();

      await storage.saveSettings(buildSettings({ localRetentionDays: 30 }));
      const loaded = await storage.getSettings();

      expect(loaded?.localRetentionDays).toBe(30);
      await storage.close();
    });

    it('defaults to null and can be cleared back to null via updateSettings', async () => {
      const storage = new SqliteAdapter({ filepath: ':memory:' });
      await storage.initialize();

      await storage.saveSettings(buildSettings());
      expect((await storage.getSettings())?.localRetentionDays).toBeNull();

      await storage.updateSettings({ localRetentionDays: 14 });
      expect((await storage.getSettings())?.localRetentionDays).toBe(14);

      await storage.updateSettings({ localRetentionDays: null });
      expect((await storage.getSettings())?.localRetentionDays).toBeNull();
      await storage.close();
    });
  });

  describe('MemoryAdapter', () => {
    it('persists the window through save and partial update', async () => {
      const storage = new MemoryAdapter();
      await storage.initialize();

      await storage.saveSettings(buildSettings({ localRetentionDays: 90 }));
      expect((await storage.getSettings())?.localRetentionDays).toBe(90);

      const updated = await storage.updateSettings({ localRetentionDays: null });
      expect(updated.localRetentionDays).toBeNull();
    });
  });
});
