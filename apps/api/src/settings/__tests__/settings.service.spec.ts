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

  it('keeps the previous cache when a runtime refresh finds no settings row', async () => {
    const saved = buildSettings({ localRetentionDays: 30 });
    const storage = {
      getSettings: jest
        .fn()
        .mockResolvedValueOnce(saved) // first refresh: row exists
        .mockResolvedValue(null), // later refresh: DB wiped mid-run
    } as any;
    const service = new SettingsService(storage, configStub);

    await (service as any).refreshCache();
    expect(service.getLoadedSettings()?.localRetentionDays).toBe(30);

    // The env-derived fallback must never be presented as persisted settings.
    await (service as any).refreshCache();
    expect(service.getLoadedSettings()?.localRetentionDays).toBe(30);
  });

  it('resetToDefaults preserves the retention window instead of re-seeding it from env', async () => {
    const current = buildSettings({ localRetentionDays: null });
    const storage = {
      getSettings: jest.fn().mockResolvedValue(current),
      saveSettings: jest.fn().mockResolvedValue(current),
    } as any;
    // Env var set: a reset must NOT re-arm deletion the operator cleared.
    const config = {
      get: jest.fn((key: string, def?: string) => (key === 'LOCAL_RETENTION_DAYS' ? '7' : def)),
    } as any;
    const service = new SettingsService(storage, config);

    await service.resetToDefaults();

    expect(storage.saveSettings).toHaveBeenCalledTimes(1);
    expect(storage.saveSettings.mock.calls[0][0].localRetentionDays).toBeNull();
  });

  it('pins the MAX_RETENTION_DAYS boundary at 36,500 days', async () => {
    // The cap exists to keep days * MS_PER_DAY inside the JS Date range —
    // restoring a larger bound would make the sweep's cutoff formatting
    // throw for validation-legal values.
    const storage = {
      getSettings: jest.fn().mockResolvedValue(buildSettings()),
      updateSettings: jest
        .fn()
        .mockImplementation(async (updates) => buildSettings(updates)),
    } as any;
    const service = new SettingsService(storage, configStub);

    const accepted = await service.updateSettings({ localRetentionDays: 36_500 });
    expect(accepted.settings.localRetentionDays).toBe(36_500);

    await expect(service.updateSettings({ localRetentionDays: 36_501 })).rejects.toThrow(
      BadRequestException,
    );
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
