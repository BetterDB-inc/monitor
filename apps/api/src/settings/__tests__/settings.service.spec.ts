import { BadRequestException } from '@nestjs/common';
import type { AppSettings } from '@betterdb/shared';
import { SettingsService } from '../settings.service';

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

const configStub = {
  get: jest.fn((_key: string, def?: string) => def),
} as any;

describe('SettingsService', () => {
  it('an in-flight cache refresh does not clobber a newer direct write', async () => {
    const stale = buildSettings({ localRetentionDays: 7 });
    const fresh = buildSettings({ localRetentionDays: null });

    let resolveSlowRead!: (value: AppSettings) => void;
    const storage = {
      getSettings: jest
        .fn()
        // First call: the periodic refresh, held open until after the update.
        .mockImplementationOnce(
          () => new Promise<AppSettings>((resolve) => (resolveSlowRead = resolve)),
        )
        // Second call: updateSettings' current-row check.
        .mockResolvedValue(stale),
      updateSettings: jest.fn().mockResolvedValue(fresh),
    } as any;

    const service = new SettingsService(storage, configStub);

    const refresh = (service as any).refreshCache() as Promise<void>;
    await service.updateSettings({ localRetentionDays: null });
    expect(service.getLoadedSettings()?.localRetentionDays).toBeNull();

    // The stale read finally lands — it must not overwrite the cleared value.
    resolveSlowRead(stale);
    await refresh;
    expect(service.getLoadedSettings()?.localRetentionDays).toBeNull();
  });

  it('rejects localRetentionDays outside the storable integer range', async () => {
    const storage = {
      getSettings: jest.fn().mockResolvedValue(buildSettings()),
      updateSettings: jest.fn().mockResolvedValue(buildSettings()),
    } as any;
    const service = new SettingsService(storage, configStub);

    await expect(service.updateSettings({ localRetentionDays: 2_147_483_648 })).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.updateSettings({ localRetentionDays: 0 })).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.updateSettings({ localRetentionDays: 1.5 })).rejects.toThrow(
      BadRequestException,
    );
  });
});
