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
    updatedAt: now,
    createdAt: now,
    ...overrides,
  };
}

describe('inference_sla_config round-trip', () => {
  describe('MemoryAdapter', () => {
    it('persists and reloads inferenceSlaConfig across saveSettings', async () => {
      const storage = new MemoryAdapter();
      await storage.initialize();
      const config = {
        idx_cache: { p99ThresholdUs: 15_000, enabled: true },
        idx_docs: { p99ThresholdUs: 25_000, enabled: false },
      };

      await storage.saveSettings(buildSettings({ inferenceSlaConfig: config }));
      const loaded = await storage.getSettings();

      expect(loaded?.inferenceSlaConfig).toEqual(config);
    });

    it('applies partial updateSettings to inferenceSlaConfig', async () => {
      const storage = new MemoryAdapter();
      await storage.initialize();
      await storage.saveSettings(buildSettings());

      const updated = await storage.updateSettings({
        inferenceSlaConfig: { idx_new: { p99ThresholdUs: 10_000, enabled: true } },
      });

      expect(updated.inferenceSlaConfig).toEqual({
        idx_new: { p99ThresholdUs: 10_000, enabled: true },
      });
    });
  });

  describe('SqliteAdapter', () => {
    it('persists and reloads inferenceSlaConfig through the JSON column', async () => {
      const storage = new SqliteAdapter({ filepath: ':memory:' });
      await storage.initialize();
      const config = {
        idx_cache: { p99ThresholdUs: 12_000, enabled: true },
      };

      await storage.saveSettings(buildSettings({ inferenceSlaConfig: config }));
      const loaded = await storage.getSettings();

      expect(loaded?.inferenceSlaConfig).toEqual(config);
      await storage.close();
    });

    it('defaults inferenceSlaConfig to {} when no settings row exists yet', async () => {
      const storage = new SqliteAdapter({ filepath: ':memory:' });
      await storage.initialize();

      await storage.saveSettings(
        buildSettings({ inferenceSlaConfig: undefined as unknown as AppSettings['inferenceSlaConfig'] }),
      );
      const loaded = await storage.getSettings();

      expect(loaded?.inferenceSlaConfig).toEqual({});
      await storage.close();
    });
  });
});
