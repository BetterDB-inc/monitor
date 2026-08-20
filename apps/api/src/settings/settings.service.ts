import { BadRequestException, Injectable, Inject, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppSettings, SettingsUpdateRequest, SettingsResponse } from '@betterdb/shared';
import { DetectorConfigMap, MetricType, resolveDetectorConfig } from '../anomaly/anomaly.types';
import { StoragePort } from '../common/interfaces/storage-port.interface';

@Injectable()
export class SettingsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SettingsService.name);
  private cachedSettings: AppSettings | null = null;
  private cacheRefreshInterval: NodeJS.Timeout | null = null;
  private readonly CACHE_REFRESH_MS = 30000;

  constructor(
    @Inject('STORAGE_CLIENT') private readonly storageClient: StoragePort,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit() {
    const existingSettings = await this.storageClient.getSettings();
    if (!existingSettings) {
      await this.initializeFromEnv();
    }
    await this.refreshCache();

    this.cacheRefreshInterval = setInterval(() => {
      this.refreshCache().catch((err) =>
        this.logger.error('Failed to refresh settings cache:', err),
      );
    }, this.CACHE_REFRESH_MS);
  }

  onModuleDestroy() {
    if (this.cacheRefreshInterval) {
      clearInterval(this.cacheRefreshInterval);
      this.cacheRefreshInterval = null;
    }
  }

  private async refreshCache(): Promise<void> {
    const dbSettings = await this.storageClient.getSettings();
    this.cachedSettings = dbSettings || this.buildSettingsFromEnv();
  }

  getCachedSettings(): AppSettings {
    return this.cachedSettings || this.buildSettingsFromEnv();
  }

  private buildSettingsFromEnv(): AppSettings {
    const now = Date.now();
    return {
      id: 1,
      auditPollIntervalMs: parseInt(this.configService.get('AUDIT_POLL_INTERVAL_MS', '60000'), 10),
      clientAnalyticsPollIntervalMs: parseInt(
        this.configService.get('CLIENT_ANALYTICS_POLL_INTERVAL_MS', '60000'),
        10,
      ),
      anomalyPollIntervalMs: parseInt(
        this.configService.get('ANOMALY_POLL_INTERVAL_MS', '1000'),
        10,
      ),
      anomalyCacheTtlMs: parseInt(this.configService.get('ANOMALY_CACHE_TTL_MS', '3600000'), 10),
      anomalyPrometheusIntervalMs: parseInt(
        this.configService.get('ANOMALY_PROMETHEUS_INTERVAL_MS', '30000'),
        10,
      ),
      metricForecastingEnabled:
        this.configService.get('METRIC_FORECASTING_ENABLED', 'true') === 'true',
      metricForecastingDefaultRollingWindowMs: parseInt(
        this.configService.get('METRIC_FORECASTING_DEFAULT_ROLLING_WINDOW_MS', '21600000'),
        10,
      ),
      metricForecastingDefaultAlertThresholdMs: parseInt(
        this.configService.get('METRIC_FORECASTING_DEFAULT_ALERT_THRESHOLD_MS', '7200000'),
        10,
      ),
      inferenceSlaConfig: {},
      anomalyDetectorConfig: {},
      createdAt: now,
      updatedAt: now,
    };
  }

  private async initializeFromEnv(): Promise<void> {
    await this.storageClient.saveSettings(this.buildSettingsFromEnv());
  }

  async getSettings(): Promise<SettingsResponse> {
    const dbSettings = await this.storageClient.getSettings();

    if (dbSettings) {
      return {
        settings: dbSettings,
        source: 'database',
        requiresRestart: false,
      };
    }

    return {
      settings: this.buildSettingsFromEnv(),
      source: 'environment',
      requiresRestart: false,
    };
  }

  async updateSettings(updates: SettingsUpdateRequest): Promise<SettingsResponse> {
    const current = await this.storageClient.getSettings();

    if (!current) {
      await this.initializeFromEnv();
      const initialized = await this.storageClient.getSettings();
      if (!initialized) {
        throw new Error('Failed to initialize settings');
      }
    }

    const updated = await this.storageClient.updateSettings(updates);
    // Refresh the in-memory cache eagerly. The 30s interval would otherwise
    // leave consumers of getCachedSettings() reading stale data for up to
    // half a minute — notably InferenceLatencyService, whose SLA evaluation
    // runs on a 60s tick and depends on fresh inferenceSlaConfig.
    this.cachedSettings = updated;

    return {
      settings: updated,
      source: 'database',
      requiresRestart: false,
    };
  }

  async getDetectorConfig(): Promise<DetectorConfigMap> {
    const stored = this.getCachedSettings().anomalyDetectorConfig;
    return stored ?? {};
  }

  async updateDetectorConfig(overrides: DetectorConfigMap): Promise<DetectorConfigMap> {
    const existing = await this.getDetectorConfig();
    const merged: DetectorConfigMap = { ...existing };

    for (const key of Object.keys(overrides) as MetricType[]) {
      merged[key] = {
        ...existing[key],
        ...overrides[key],
      };
    }

    for (const key of Object.keys(merged) as MetricType[]) {
      const resolved = resolveDetectorConfig(key as MetricType, merged);

      if (resolved.warningZScore >= resolved.criticalZScore) {
        throw new BadRequestException(
          `${key}: warningZScore (${resolved.warningZScore}) must be less than ` +
            `criticalZScore (${resolved.criticalZScore}) after merging with stored config`,
        );
      }

      const hasWarningAbs = resolved.warningAbsolute !== Number.POSITIVE_INFINITY;
      const hasCriticalAbs = resolved.criticalAbsolute !== Number.POSITIVE_INFINITY;
      if (hasWarningAbs && hasCriticalAbs && resolved.warningAbsolute >= resolved.criticalAbsolute) {
        throw new BadRequestException(
          `${key}: warningAbsolute (${resolved.warningAbsolute}) must be less than ` +
            `criticalAbsolute (${resolved.criticalAbsolute}) after merging with stored config`,
        );
      }
    }

    const updated = await this.updateSettings({ anomalyDetectorConfig: merged });
    return updated.settings.anomalyDetectorConfig as DetectorConfigMap;
  }

  async resetToDefaults(): Promise<SettingsResponse> {
    await this.initializeFromEnv();
    const settings = await this.storageClient.getSettings();

    if (!settings) {
      throw new Error('Failed to reset settings');
    }

    this.cachedSettings = settings;

    return {
      settings,
      source: 'database',
      requiresRestart: true,
    };
  }
}
