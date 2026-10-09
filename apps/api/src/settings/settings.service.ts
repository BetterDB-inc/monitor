import {
  Injectable,
  Inject,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AppSettings,
  SettingsUpdateRequest,
  SettingsResponse,
  MAX_RETENTION_DAYS,
  normalizeRetentionDays,
  parseRetentionDaysToken,
} from '@betterdb/shared';
import { StoragePort } from '../common/interfaces/storage-port.interface';
import { DetectorConfigMap, MetricType, resolveDetectorConfig } from '../anomaly/anomaly.types';

export type DetectorConfigListener = (config: DetectorConfigMap) => void;

@Injectable()
export class SettingsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SettingsService.name);
  private cachedSettings: AppSettings | null = null;
  private cacheRefreshInterval: NodeJS.Timeout | null = null;
  private readonly CACHE_REFRESH_MS = 30000;
  // Bumped on every direct cache write (update/reset). An in-flight periodic
  // refresh that started before the write would otherwise clobber the fresh
  // value with the older database snapshot it read.
  private cacheGeneration = 0;
  // The refresh runs every 30s and nothing re-seeds a wiped row, so a missing
  // settings row would otherwise log the same warning ~2,880 times a day and
  // bury the one actionable line. Warn once per missing episode, reset when
  // the row comes back.
  private warnedSettingsRowMissing = false;
  // Live consumers of detector thresholds (the proprietary AnomalyService)
  // subscribe here rather than being injected into SettingsController: the
  // anomaly module is loaded dynamically and SettingsModule cannot import it.
  private detectorConfigListeners = new Set<DetectorConfigListener>();
  // Serializes detector-config read-merge-write cycles so concurrent PATCHes
  // for different metrics can't overwrite each other's changes.
  private detectorConfigLock: Promise<unknown> = Promise.resolve();

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

  // Every direct cache write restores the settings row, so it also ends any
  // missing-row episode: bump the generation (so an in-flight refresh can't
  // clobber the fresh value), swap the cache, and re-arm the missing-row
  // warning. Centralized so a future direct-write path can't reintroduce the
  // "row came back, then vanished again, warned nothing" gap.
  private commitCacheWrite(settings: AppSettings): void {
    this.cacheGeneration++;
    this.cachedSettings = settings;
    this.warnedSettingsRowMissing = false;
  }

  private async refreshCache(): Promise<void> {
    const generation = this.cacheGeneration;
    const dbSettings = await this.storageClient.getSettings();
    if (generation !== this.cacheGeneration) return; // a direct write won the race
    // Only ever cache persisted settings. Substituting env-derived defaults
    // here (e.g. after a DB wipe mid-run) would let getLoadedSettings() hand
    // out values that were never saved — and an unsaved LOCAL_RETENTION_DAYS
    // must not be able to trigger deletion.
    if (dbSettings) {
      this.cachedSettings = dbSettings;
      this.warnedSettingsRowMissing = false; // episode over — warn again next time
    } else if (this.cachedSettings && !this.warnedSettingsRowMissing) {
      this.warnedSettingsRowMissing = true;
      this.logger.warn(
        'Settings row missing on cache refresh; keeping the previously loaded settings',
      );
    }
  }

  getCachedSettings(): AppSettings {
    return this.cachedSettings || this.buildSettingsFromEnv();
  }

  /**
   * The cached persisted settings, or null before the first cache load.
   * Unlike getCachedSettings() this never falls back to the env-derived
   * defaults — callers that must not act on unconfirmed values (e.g. data
   * deletion) use this and treat null as "not yet known".
   */
  getLoadedSettings(): AppSettings | null {
    return this.cachedSettings;
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
      localRetentionDays: parseRetentionDaysToken(this.configService.get('LOCAL_RETENTION_DAYS')),
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
    if (updates.localRetentionDays !== undefined && updates.localRetentionDays !== null) {
      if (normalizeRetentionDays(updates.localRetentionDays) === null) {
        throw new BadRequestException(
          `localRetentionDays must be null or an integer between 1 and ${MAX_RETENTION_DAYS}`,
        );
      }
    }

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
    this.commitCacheWrite(updated);

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

  updateDetectorConfig(overrides: DetectorConfigMap): Promise<DetectorConfigMap> {
    return this.withDetectorConfigLock(() => this.applyDetectorConfigUpdate(overrides));
  }

  private async applyDetectorConfigUpdate(
    overrides: DetectorConfigMap,
  ): Promise<DetectorConfigMap> {
    // Read from storage, not the cache: the cache can lag a write made by the
    // previous holder of the lock until commitCacheWrite runs.
    const existing = await this.readStoredDetectorConfig();
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
      if (
        hasWarningAbs &&
        hasCriticalAbs &&
        resolved.warningAbsolute >= resolved.criticalAbsolute
      ) {
        throw new BadRequestException(
          `${key}: warningAbsolute (${resolved.warningAbsolute}) must be less than ` +
            `criticalAbsolute (${resolved.criticalAbsolute}) after merging with stored config`,
        );
      }
    }

    const updated = await this.updateSettings({ anomalyDetectorConfig: merged });
    const result = (updated.settings.anomalyDetectorConfig ?? {}) as DetectorConfigMap;
    this.notifyDetectorConfigChange(result);
    return result;
  }

  resetDetectorConfig(): Promise<void> {
    return this.withDetectorConfigLock(async () => {
      await this.updateSettings({ anomalyDetectorConfig: {} });
      this.notifyDetectorConfigChange({});
    });
  }

  private async readStoredDetectorConfig(): Promise<DetectorConfigMap> {
    const stored = await this.storageClient.getSettings();
    return (stored?.anomalyDetectorConfig ?? {}) as DetectorConfigMap;
  }

  private withDetectorConfigLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.detectorConfigLock.then(fn, fn);
    // A rejected update (e.g. validation failure) must not block later ones.
    this.detectorConfigLock = run.catch(() => undefined);
    return run;
  }

  /** Subscribe to detector config changes. Returns an unsubscribe function. */
  onDetectorConfigChange(listener: DetectorConfigListener): () => void {
    this.detectorConfigListeners.add(listener);
    return () => {
      this.detectorConfigListeners.delete(listener);
    };
  }

  // The config is already persisted by the time listeners run, so a failing
  // listener must not turn a successful write into an error for the caller.
  private notifyDetectorConfigChange(config: DetectorConfigMap): void {
    for (const listener of this.detectorConfigListeners) {
      try {
        listener(config);
      } catch (err) {
        this.logger.error(
          `Detector config listener failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  async resetToDefaults(): Promise<SettingsResponse> {
    // The retention window survives a reset. Re-seeding it from
    // LOCAL_RETENTION_DAYS would re-arm data deletion for an operator who
    // explicitly cleared it in the UI and is resetting something unrelated —
    // the docs promise that clearing the window sticks.
    const current = await this.storageClient.getSettings();
    const defaults = this.buildSettingsFromEnv();
    if (current) {
      defaults.localRetentionDays = current.localRetentionDays;
    }
    await this.storageClient.saveSettings(defaults);
    const settings = await this.storageClient.getSettings();

    if (!settings) {
      throw new Error('Failed to reset settings');
    }

    this.commitCacheWrite(settings);

    return {
      settings,
      source: 'database',
      requiresRestart: true,
    };
  }
}
