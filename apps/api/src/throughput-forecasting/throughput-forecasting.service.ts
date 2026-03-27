import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import type { StoragePort } from '../common/interfaces/storage-port.interface';
import { SettingsService } from '../settings/settings.service';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import type {
  ThroughputForecast,
  ThroughputSettings,
  ThroughputSettingsUpdate,
} from '@betterdb/shared';
import { WEBHOOK_EVENTS_PRO_SERVICE, type IWebhookEventsProService } from '@betterdb/shared';

const MIN_DATA_POINTS = 3;
const MIN_TIME_SPAN_MS = 30 * 60_000; // 30 minutes
const TREND_THRESHOLD_PERCENT = 5;
const CACHE_TTL_MS = 60_000;
const ALERT_CHECK_INTERVAL_MS = 60_000;

@Injectable()
export class ThroughputForecastingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ThroughputForecastingService.name);
  private forecastCache = new Map<string, { forecast: ThroughputForecast; computedAt: number }>();
  private alertInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    private readonly settingsService: SettingsService,
    private readonly connectionRegistry: ConnectionRegistry,
    @Optional()
    @Inject(WEBHOOK_EVENTS_PRO_SERVICE)
    private readonly webhookEventsProService?: IWebhookEventsProService,
  ) {}

  onModuleInit(): void {
    if (this.webhookEventsProService) {
      this.logger.log('Enabling throughput forecasting webhook alerts');
      this.alertInterval = setInterval(() => this.checkAlerts(), ALERT_CHECK_INTERVAL_MS);
    }
  }

  onModuleDestroy(): void {
    if (this.alertInterval) {
      this.logger.log('Disabling throughput forecasting webhook alerts');
      clearInterval(this.alertInterval);
      this.alertInterval = null;
    }
  }

  async getForecast(connectionId: string): Promise<ThroughputForecast> {
    // Check cache
    const cached = this.forecastCache.get(connectionId);
    if (cached && Date.now() - cached.computedAt < CACHE_TTL_MS) {
      return cached.forecast;
    }

    // Check global toggle
    const globalSettings = this.settingsService.getCachedSettings();
    if (!globalSettings.throughputForecastingEnabled) {
      return this.buildDisabledForecast(connectionId);
    }

    // Check per-connection settings
    const settings = await this.getOrCreateSettings(connectionId);
    if (!settings.enabled) {
      return this.buildDisabledForecast(connectionId);
    }

    // Query snapshots
    const now = Date.now();
    const snapshots = await this.storage.getMemorySnapshots({
      connectionId,
      startTime: now - settings.rollingWindowMs,
      limit: 1500,
    });

    // Reverse to ascending (query returns DESC)
    const sorted = [...snapshots].reverse();

    // Check sufficient data
    const latestOps = sorted.length > 0 ? sorted[sorted.length - 1].opsPerSec : 0;
    if (sorted.length < MIN_DATA_POINTS) {
      return this.buildInsufficientForecast(connectionId, settings, latestOps);
    }
    const timeSpan = sorted[sorted.length - 1].timestamp - sorted[0].timestamp;
    if (timeSpan < MIN_TIME_SPAN_MS) {
      return this.buildInsufficientForecast(connectionId, settings, latestOps);
    }

    // Linear regression
    const points = sorted.map((s) => ({ x: s.timestamp, y: s.opsPerSec }));
    const { slope, intercept } = this.linearRegression(points);

    // Compute metrics
    const windowStart = sorted[0].timestamp;
    const windowEnd = sorted[sorted.length - 1].timestamp;
    const predictedStart = slope * windowStart + intercept;
    const predictedEnd = slope * windowEnd + intercept;
    const currentOpsPerSec = latestOps;
    const growthRate = slope * 3_600_000; // ops/sec per hour
    const growthPercent =
      predictedStart !== 0 ? ((predictedEnd - predictedStart) / Math.abs(predictedStart)) * 100 : 0;

    const trendDirection: 'rising' | 'falling' | 'stable' =
      growthPercent > TREND_THRESHOLD_PERCENT
        ? 'rising'
        : growthPercent < -TREND_THRESHOLD_PERCENT
          ? 'falling'
          : 'stable';

    const baseForecast = {
      connectionId,
      currentOpsPerSec,
      growthRate,
      growthPercent,
      trendDirection,
      dataPointCount: sorted.length,
      windowMs: settings.rollingWindowMs,
      enabled: true,
      insufficientData: false,
    };

    let forecast: ThroughputForecast;

    if (settings.opsCeiling === null) {
      // Trend mode
      forecast = {
        ...baseForecast,
        mode: 'trend',
        opsCeiling: null,
        timeToLimitMs: null,
        timeToLimitHuman: this.formatTrendSummary(
          growthPercent,
          trendDirection,
          settings.rollingWindowMs,
        ),
      };
    } else {
      // Forecast mode
      const currentPredicted = slope * now + intercept;

      if (currentPredicted >= settings.opsCeiling) {
        forecast = {
          ...baseForecast,
          mode: 'forecast',
          opsCeiling: settings.opsCeiling,
          timeToLimitMs: 0,
          timeToLimitHuman: 'Ceiling already exceeded',
        };
      } else if (trendDirection !== 'rising' || slope <= 0) {
        forecast = {
          ...baseForecast,
          mode: 'forecast',
          opsCeiling: settings.opsCeiling,
          timeToLimitMs: null,
          timeToLimitHuman: 'Not projected to reach ceiling',
        };
      } else {
        const timeToLimitMs = (settings.opsCeiling - currentPredicted) / slope;
        forecast = {
          ...baseForecast,
          mode: 'forecast',
          opsCeiling: settings.opsCeiling,
          timeToLimitMs,
          timeToLimitHuman: this.formatTimeToLimit(timeToLimitMs),
        };
      }
    }

    // Cache
    this.forecastCache.set(connectionId, { forecast, computedAt: Date.now() });
    return forecast;
  }

  async getSettings(connectionId: string): Promise<ThroughputSettings> {
    return this.getOrCreateSettings(connectionId);
  }

  async updateSettings(
    connectionId: string,
    updates: ThroughputSettingsUpdate,
  ): Promise<ThroughputSettings> {
    const current = await this.getOrCreateSettings(connectionId);
    const merged: ThroughputSettings = {
      ...current,
      ...updates,
      connectionId,
      updatedAt: Date.now(),
    };
    const saved = await this.storage.saveThroughputSettings(merged);
    this.forecastCache.delete(connectionId);
    return saved;
  }

  private async getOrCreateSettings(connectionId: string): Promise<ThroughputSettings> {
    const existing = await this.storage.getThroughputSettings(connectionId);
    if (existing) return existing;

    const globalSettings = this.settingsService.getCachedSettings();
    if (!globalSettings.throughputForecastingEnabled) {
      return {
        connectionId,
        enabled: false,
        opsCeiling: null,
        rollingWindowMs: globalSettings.throughputForecastingDefaultRollingWindowMs,
        alertThresholdMs: globalSettings.throughputForecastingDefaultAlertThresholdMs,
        updatedAt: Date.now(),
      };
    }

    const newSettings: ThroughputSettings = {
      connectionId,
      enabled: true,
      opsCeiling: null,
      rollingWindowMs: globalSettings.throughputForecastingDefaultRollingWindowMs,
      alertThresholdMs: globalSettings.throughputForecastingDefaultAlertThresholdMs,
      updatedAt: Date.now(),
    };
    return this.storage.saveThroughputSettings(newSettings);
  }

  private linearRegression(points: { x: number; y: number }[]): {
    slope: number;
    intercept: number;
  } {
    const n = points.length;
    if (n === 0) return { slope: 0, intercept: 0 };
    if (n === 1) return { slope: 0, intercept: points[0].y };

    let sumX = 0,
      sumY = 0,
      sumXY = 0,
      sumX2 = 0;
    for (const p of points) {
      sumX += p.x;
      sumY += p.y;
      sumXY += p.x * p.y;
      sumX2 += p.x * p.x;
    }
    const denom = n * sumX2 - sumX * sumX;
    if (denom === 0) return { slope: 0, intercept: sumY / n };
    const slope = (n * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / n;
    return { slope, intercept };
  }

  private formatTimeToLimit(ms: number): string {
    if (ms < 3_600_000) return `~${Math.round(ms / 60_000)}m at current growth rate`;
    if (ms < 86_400_000) return `~${(ms / 3_600_000).toFixed(1)}h at current growth rate`;
    return `~${(ms / 86_400_000).toFixed(1)}d at current growth rate`;
  }

  private formatTrendSummary(growthPercent: number, direction: string, windowMs: number): string {
    const windowHours = windowMs / 3_600_000;
    const sign = growthPercent >= 0 ? '+' : '';
    return `${sign}${growthPercent.toFixed(1)}% over ${windowHours}h, ${direction}`;
  }

  private buildDisabledForecast(connectionId: string): ThroughputForecast {
    return {
      connectionId,
      mode: 'trend',
      currentOpsPerSec: 0,
      growthRate: 0,
      growthPercent: 0,
      trendDirection: 'stable',
      dataPointCount: 0,
      windowMs: 0,
      opsCeiling: null,
      timeToLimitMs: null,
      timeToLimitHuman: '',
      enabled: false,
      insufficientData: false,
    };
  }

  private buildInsufficientForecast(
    connectionId: string,
    settings: ThroughputSettings,
    currentOpsPerSec: number,
  ): ThroughputForecast {
    return {
      connectionId,
      mode: 'trend',
      currentOpsPerSec,
      growthRate: 0,
      growthPercent: 0,
      trendDirection: 'stable',
      dataPointCount: 0,
      windowMs: settings.rollingWindowMs,
      opsCeiling: settings.opsCeiling,
      timeToLimitMs: null,
      timeToLimitHuman: '',
      enabled: true,
      insufficientData: true,
      insufficientDataMessage:
        'Data will be available shortly. At least 30 minutes of monitoring history required.',
    };
  }

  private async checkAlerts(): Promise<void> {
    if (!this.webhookEventsProService) return;

    const globalSettings = this.settingsService.getCachedSettings();
    if (!globalSettings.throughputForecastingEnabled) return;

    try {
      const activeSettings = await this.storage.getActiveThroughputSettings();
      for (const settings of activeSettings) {
        const forecast = await this.getForecast(settings.connectionId);
        if (
          forecast.timeToLimitMs !== null &&
          forecast.timeToLimitMs > 0 &&
          forecast.opsCeiling !== null
        ) {
          const config = this.connectionRegistry.getConfig(settings.connectionId);
          if (config) {
            await this.webhookEventsProService.dispatchThroughputLimit({
              currentOpsPerSec: forecast.currentOpsPerSec,
              opsCeiling: forecast.opsCeiling,
              timeToLimitMs: forecast.timeToLimitMs,
              threshold: settings.alertThresholdMs,
              growthRate: forecast.growthRate,
              timestamp: Date.now(),
              instance: { host: config.host, port: config.port },
              connectionId: settings.connectionId,
            });
          }
        }
      }
    } catch (err) {
      this.logger.warn(`Alert check failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
