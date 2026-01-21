import { Injectable, Inject, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppSettings, SettingsUpdateRequest, SettingsResponse } from '@betterdb/shared';
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
      clientAnalyticsPollIntervalMs: parseInt(this.configService.get('CLIENT_ANALYTICS_POLL_INTERVAL_MS', '60000'), 10),
      anomalyPollIntervalMs: parseInt(this.configService.get('ANOMALY_POLL_INTERVAL_MS', '1000'), 10),
      anomalyCacheTtlMs: parseInt(this.configService.get('ANOMALY_CACHE_TTL_MS', '3600000'), 10),
      anomalyPrometheusIntervalMs: parseInt(this.configService.get('ANOMALY_PROMETHEUS_INTERVAL_MS', '30000'), 10),
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

    return {
      settings: updated,
      source: 'database',
      requiresRestart: false,
    };
  }

  async resetToDefaults(): Promise<SettingsResponse> {
    await this.initializeFromEnv();
    const settings = await this.storageClient.getSettings();

    if (!settings) {
      throw new Error('Failed to reset settings');
    }

    return {
      settings,
      source: 'database',
      requiresRestart: true,
    };
  }
}
