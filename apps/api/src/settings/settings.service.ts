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
  parseRetentionDaysToken,
} from '@betterdb/shared';
import { StoragePort } from '../common/interfaces/storage-port.interface';

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
    const generation = this.cacheGeneration;
    const dbSettings = await this.storageClient.getSettings();
    if (generation !== this.cacheGeneration) return; // a direct write won the race
    // Only ever cache persisted settings. Substituting env-derived defaults
    // here (e.g. after a DB wipe mid-run) would let getLoadedSettings() hand
    // out values that were never saved — and an unsaved LOCAL_RETENTION_DAYS
    // must not be able to trigger deletion.
    if (dbSettings) {
      this.cachedSettings = dbSettings;
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
      localRetentionDays: this.parseLocalRetentionDays(
        this.configService.get('LOCAL_RETENTION_DAYS'),
      ),
      createdAt: now,
      updatedAt: now,
    };
  }

  private parseLocalRetentionDays(raw: string | undefined): number | null {
    return parseRetentionDaysToken(raw);
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
      const days = updates.localRetentionDays;
      if (!Number.isInteger(days) || days < 1 || days > MAX_RETENTION_DAYS) {
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
    this.cacheGeneration++;
    this.cachedSettings = updated;

    return {
      settings: updated,
      source: 'database',
      requiresRestart: false,
    };
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

    this.cacheGeneration++;
    this.cachedSettings = settings;

    return {
      settings,
      source: 'database',
      requiresRestart: true,
    };
  }
}
