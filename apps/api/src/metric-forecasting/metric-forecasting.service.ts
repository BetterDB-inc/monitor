import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { StoragePort } from '../common/interfaces/storage-port.interface';
import { SettingsService } from '../settings/settings.service';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import type {
  MetricForecast,
  MetricForecastSettings,
  MetricForecastSettingsUpdate,
  MetricKind,
} from '@betterdb/shared';
import {
  METRIC_KIND_META,
  WEBHOOK_EVENTS_PRO_SERVICE,
  WebhookEventType,
  type IWebhookEventsProService,
} from '@betterdb/shared';
import { METRIC_EXTRACTORS } from './metric-extractors';
import { CEILING_RESOLVERS } from './ceiling-resolvers';

const MIN_DATA_POINTS = 3;
const MIN_TIME_SPAN_MS = 30 * 60_000; // 30 minutes
const TREND_THRESHOLD_PERCENT = 5;
const CACHE_TTL_MS = 60_000;
const ALERT_CHECK_INTERVAL_MS = 60_000;

@Injectable()
export class MetricForecastingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MetricForecastingService.name);
  private forecastCache = new Map<string, { forecast: MetricForecast; computedAt: number }>();
  private alertInterval: ReturnType<typeof setInterval> | null = null;
  private pruneInterval: ReturnType<typeof setInterval> | null = null;

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
      this.logger.log('Enabling metric forecasting webhook alerts');
      this.alertInterval = setInterval(() => this.checkAlerts(), ALERT_CHECK_INTERVAL_MS);
    }
    // Prune stale cache entries even in non-Pro deployments
    this.pruneInterval = setInterval(() => this.pruneCache(), CACHE_TTL_MS * 10);
  }

  onModuleDestroy(): void {
    if (this.pruneInterval) {
      clearInterval(this.pruneInterval);
      this.pruneInterval = null;
    }
    if (this.alertInterval) {
      clearInterval(this.alertInterval);
      this.alertInterval = null;
    }
  }

  async getForecast(connectionId: string, metricKind: MetricKind): Promise<MetricForecast> {
    const cacheKey = `${connectionId}:${metricKind}`;

    // Check cache
    const cached = this.forecastCache.get(cacheKey);
    if (cached && Date.now() - cached.computedAt < CACHE_TTL_MS) {
      return cached.forecast;
    }

    // Check global toggle
    const globalSettings = this.settingsService.getCachedSettings();
    if (!globalSettings.metricForecastingEnabled) {
      return this.buildDisabledForecast(connectionId, metricKind);
    }

    // Check per-connection settings
    const settings = await this.getOrCreateSettings(connectionId, metricKind);
    if (!settings.enabled) {
      return this.buildDisabledForecast(connectionId, metricKind);
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

    // Extract metric values
    const extractor = METRIC_EXTRACTORS[metricKind];
    const latestValue = sorted.length > 0 ? extractor(sorted[sorted.length - 1]) : 0;

    // Check sufficient data
    if (sorted.length < MIN_DATA_POINTS) {
      return this.buildInsufficientForecast(
        connectionId, metricKind, settings, latestValue, sorted.length,
      );
    }
    const timeSpan = sorted[sorted.length - 1].timestamp - sorted[0].timestamp;
    if (timeSpan < MIN_TIME_SPAN_MS) {
      return this.buildInsufficientForecast(
        connectionId, metricKind, settings, latestValue, sorted.length,
      );
    }

    // Linear regression on extracted metric
    const points = sorted.map((s) => ({ x: s.timestamp, y: extractor(s) }));
    const { slope, intercept } = this.linearRegression(points);

    // Compute metrics
    const windowStart = sorted[0].timestamp;
    const windowEnd = sorted[sorted.length - 1].timestamp;
    const predictedStart = slope * windowStart + intercept;
    const predictedEnd = slope * windowEnd + intercept;
    const currentValue = latestValue;
    const growthRate = slope * 3_600_000; // units per hour
    const growthPercent =
      predictedStart !== 0
        ? ((predictedEnd - predictedStart) / Math.abs(predictedStart)) * 100
        : predictedEnd !== 0
          ? 100 // growing from zero — treat as significant rise
          : 0;

    const trendDirection: 'rising' | 'falling' | 'stable' =
      growthPercent > TREND_THRESHOLD_PERCENT
        ? 'rising'
        : growthPercent < -TREND_THRESHOLD_PERCENT
          ? 'falling'
          : 'stable';

    // Resolve ceiling
    const latestSnapshot = sorted[sorted.length - 1];
    const resolvedCeiling = CEILING_RESOLVERS[metricKind](settings, latestSnapshot);

    const baseForecast = {
      connectionId,
      metricKind,
      currentValue,
      growthRate,
      growthPercent,
      trendDirection,
      dataPointCount: sorted.length,
      windowMs: settings.rollingWindowMs,
      enabled: true,
      insufficientData: false,
    };

    let forecast: MetricForecast;

    if (resolvedCeiling === null) {
      // Trend mode
      forecast = {
        ...baseForecast,
        mode: 'trend',
        ceiling: null,
        timeToLimitMs: null,
        timeToLimitHuman: this.formatTrendSummary(
          growthPercent,
          trendDirection,
          settings.rollingWindowMs,
        ),
      };
    } else {
      // Forecast mode — use actual current value, not regression estimate,
      // so fast spikes are detected immediately instead of lagging behind the trend line.
      if (currentValue >= resolvedCeiling) {
        forecast = {
          ...baseForecast,
          mode: 'forecast',
          ceiling: resolvedCeiling,
          timeToLimitMs: 0,
          timeToLimitHuman: 'Ceiling already exceeded',
        };
      } else if (trendDirection !== 'rising' || slope <= 0) {
        forecast = {
          ...baseForecast,
          mode: 'forecast',
          ceiling: resolvedCeiling,
          timeToLimitMs: null,
          timeToLimitHuman: 'Not projected to reach ceiling',
        };
      } else {
        const timeToLimitMs = (resolvedCeiling - currentValue) / slope;
        forecast = {
          ...baseForecast,
          mode: 'forecast',
          ceiling: resolvedCeiling,
          timeToLimitMs,
          timeToLimitHuman: this.formatTimeToLimit(timeToLimitMs),
        };
      }
    }

    // Cache
    this.forecastCache.set(cacheKey, { forecast, computedAt: Date.now() });
    return forecast;
  }

  async getSettings(connectionId: string, metricKind: MetricKind): Promise<MetricForecastSettings> {
    return this.getOrCreateSettings(connectionId, metricKind);
  }

  async updateSettings(
    connectionId: string,
    metricKind: MetricKind,
    updates: MetricForecastSettingsUpdate,
  ): Promise<MetricForecastSettings> {
    const current = await this.getOrCreateSettings(connectionId, metricKind);
    const defined = Object.fromEntries(
      Object.entries(updates).filter(([, v]) => v !== undefined),
    );
    const merged: MetricForecastSettings = {
      ...current,
      ...defined,
      connectionId,
      metricKind,
      updatedAt: Date.now(),
    };
    const saved = await this.storage.saveMetricForecastSettings(merged);
    this.forecastCache.delete(`${connectionId}:${metricKind}`);
    return saved;
  }

  private async getOrCreateSettings(
    connectionId: string,
    metricKind: MetricKind,
  ): Promise<MetricForecastSettings> {
    const existing = await this.storage.getMetricForecastSettings(connectionId, metricKind);
    if (existing) return existing;

    const globalSettings = this.settingsService.getCachedSettings();
    if (!globalSettings.metricForecastingEnabled) {
      return {
        connectionId,
        metricKind,
        enabled: false,
        ceiling: null,
        rollingWindowMs: globalSettings.metricForecastingDefaultRollingWindowMs,
        alertThresholdMs: globalSettings.metricForecastingDefaultAlertThresholdMs,
        updatedAt: Date.now(),
      };
    }

    const newSettings: MetricForecastSettings = {
      connectionId,
      metricKind,
      enabled: true,
      ceiling: METRIC_KIND_META[metricKind].defaultCeiling,
      rollingWindowMs: globalSettings.metricForecastingDefaultRollingWindowMs,
      alertThresholdMs: globalSettings.metricForecastingDefaultAlertThresholdMs,
      updatedAt: Date.now(),
    };
    return this.storage.saveMetricForecastSettings(newSettings);
  }

  private linearRegression(points: { x: number; y: number }[]): {
    slope: number;
    intercept: number;
  } {
    const n = points.length;
    if (n === 0) return { slope: 0, intercept: 0 };
    if (n === 1) return { slope: 0, intercept: points[0].y };

    // Normalize x values to avoid catastrophic floating-point cancellation
    // when x values are large epoch timestamps (~1.7e12).
    const x0 = points[0].x;

    let sumX = 0,
      sumY = 0,
      sumXY = 0,
      sumX2 = 0;
    for (const p of points) {
      const xNorm = p.x - x0;
      sumX += xNorm;
      sumY += p.y;
      sumXY += xNorm * p.y;
      sumX2 += xNorm * xNorm;
    }
    const denom = n * sumX2 - sumX * sumX;
    if (denom === 0) return { slope: 0, intercept: sumY / n };
    const slope = (n * sumXY - sumX * sumY) / denom;
    // Compute intercept in normalized space, then adjust back to original timestamps
    const interceptNorm = (sumY - slope * sumX) / n;
    const intercept = interceptNorm - slope * x0;
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

  private buildDisabledForecast(connectionId: string, metricKind: MetricKind): MetricForecast {
    return {
      connectionId,
      metricKind,
      mode: 'trend',
      currentValue: 0,
      growthRate: 0,
      growthPercent: 0,
      trendDirection: 'stable',
      dataPointCount: 0,
      windowMs: 0,
      ceiling: null,
      timeToLimitMs: null,
      timeToLimitHuman: '',
      enabled: false,
      insufficientData: false,
    };
  }

  private buildInsufficientForecast(
    connectionId: string,
    metricKind: MetricKind,
    settings: MetricForecastSettings,
    currentValue: number,
    dataPointCount = 0,
  ): MetricForecast {
    return {
      connectionId,
      metricKind,
      mode: 'trend',
      currentValue,
      growthRate: 0,
      growthPercent: 0,
      trendDirection: 'stable',
      dataPointCount,
      windowMs: settings.rollingWindowMs,
      ceiling: settings.ceiling,
      timeToLimitMs: null,
      timeToLimitHuman: '',
      enabled: true,
      insufficientData: true,
      insufficientDataMessage:
        'Data will be available shortly. At least 30 minutes of monitoring history required.',
    };
  }

  private pruneCache(): void {
    const maxAge = CACHE_TTL_MS * 2;
    const now = Date.now();
    for (const [key, entry] of this.forecastCache) {
      if (now - entry.computedAt > maxAge) {
        this.forecastCache.delete(key);
      }
    }
  }

  private async checkAlerts(): Promise<void> {
    if (!this.webhookEventsProService) {
      this.logger.warn('WebhookEventsProService not initialized');
      return;
    }

    this.pruneCache();

    try {
      const activeSettings = await this.storage.getActiveMetricForecastSettings();
      for (const settings of activeSettings) {
        try {
          const forecast = await this.getForecast(settings.connectionId, settings.metricKind);
          if (!forecast.enabled || forecast.insufficientData) continue;
          if (forecast.ceiling === null) continue;
          this.logger.debug(
            `[checkAlerts] ${WebhookEventType.METRIC_FORECAST_LIMIT} ${settings.connectionId}:${settings.metricKind} — ` +
              `current=${forecast.currentValue}, ceiling=${forecast.ceiling}, ` +
              `timeToLimit=${forecast.timeToLimitMs}, threshold=${settings.alertThresholdMs}, ` +
              `trend=${forecast.trendDirection}`,
          );
          const config = this.connectionRegistry.getConfig(settings.connectionId);
          await this.webhookEventsProService.dispatchMetricForecastLimit({
            event: WebhookEventType.METRIC_FORECAST_LIMIT,
            metricKind: settings.metricKind,
            currentValue: forecast.currentValue,
            ceiling: forecast.ceiling,
            timeToLimitMs: forecast.timeToLimitMs ?? Number.MAX_SAFE_INTEGER,
            threshold: settings.alertThresholdMs,
            growthRate: forecast.growthRate,
            timestamp: Date.now(),
            instance: config ? { host: config.host, port: config.port } : undefined,
            connectionId: settings.connectionId,
          });
        } catch (error) {
          this.logger.error(
            `Alert check failed for ${settings.connectionId}:${settings.metricKind}: ${error instanceof Error ? error.message : 'Unknown error'}`,
          );
        }
      }
    } catch (error) {
      this.logger.error(
        `Alert check iteration failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }
}
