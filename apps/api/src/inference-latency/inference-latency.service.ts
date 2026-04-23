import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import {
  FT_SEARCH_HEALTHY_P50_THRESHOLD_US,
  IWebhookEventsProService,
  InferenceLatencyBucket,
  InferenceLatencyProfile,
  InferenceLatencySource,
  InferenceLatencyTrend,
  InferenceLatencyTrendPoint,
  WEBHOOK_EVENTS_PRO_SERVICE,
} from '@betterdb/shared';
import {
  MultiConnectionPoller,
  ConnectionContext,
} from '../common/services/multi-connection-poller';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import {
  StoragePort,
  StoredCommandLogEntry,
  StoredSlowLogEntry,
} from '../common/interfaces/storage-port.interface';
import { PrometheusService } from '../prometheus/prometheus.service';
import { SettingsService } from '../settings/settings.service';
import { LatencyEntry, bucketEntry, projectToLatencyEntry } from './bucketing';
import { annotateIndexingEvents } from './correlation';
import { computePercentiles } from './percentiles';
import { SlaState, evaluateSla } from './sla';

const DEFAULT_PROFILE_WINDOW_MS = 15 * 60 * 1000;
// Prometheus gauges + SLA evaluation share the same window as the UI default
// so dashboard tiles, docs, and Grafana always reflect the same percentile.
const POLL_TICK_WINDOW_MS = DEFAULT_PROFILE_WINDOW_MS;
const MAX_ENTRIES_PER_PROFILE = 100_000;
const POLL_INTERVAL_MS = 60_000;
const FT_SEARCH_BUCKET_PREFIX = 'FT.SEARCH:';
const DEFAULT_TREND_BUCKET_MS = 60_000;
const MAX_TREND_POINTS = 1_440;

/**
 * Thrown for caller-supplied bad inputs that should surface as 4xx.
 * Anything else bubbling out of getTrend/getProfile should stay a 5xx.
 */
export class InferenceLatencyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InferenceLatencyValidationError';
  }
}

export interface ProfileWindow {
  startMs: number;
  endMs: number;
}

@Injectable()
export class InferenceLatencyService extends MultiConnectionPoller implements OnModuleInit {
  protected readonly logger = new Logger(InferenceLatencyService.name);
  private readonly slaState = new Map<string, SlaState>();

  constructor(
    connectionRegistry: ConnectionRegistry,
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    private readonly prometheusService: PrometheusService,
    private readonly settingsService: SettingsService,
    @Optional()
    @Inject(WEBHOOK_EVENTS_PRO_SERVICE)
    private readonly webhookEventsProService?: IWebhookEventsProService,
  ) {
    super(connectionRegistry);
  }

  protected getIntervalMs(): number {
    return POLL_INTERVAL_MS;
  }

  async onModuleInit(): Promise<void> {
    this.logger.log(`Starting inference-latency evaluation loop (${POLL_INTERVAL_MS}ms)`);
    this.start();
  }

  protected onConnectionRemoved(connectionId: string): void {
    const prefix = `${connectionId}|`;
    for (const key of Array.from(this.slaState.keys())) {
      if (key.startsWith(prefix)) this.slaState.delete(key);
    }
  }

  async getProfile(
    connectionId: string,
    options: { windowMs?: number; startTime?: number; endTime?: number } = {},
  ): Promise<InferenceLatencyProfile> {
    const window = this.resolveProfileWindow(options);
    return this.computeProfile(connectionId, window);
  }

  async getTrend(
    connectionId: string,
    bucket: string,
    startTime: number,
    endTime: number,
    bucketMs: number = DEFAULT_TREND_BUCKET_MS,
  ): Promise<InferenceLatencyTrend> {
    if (endTime <= startTime) {
      throw new InferenceLatencyValidationError('endTime must be greater than startTime');
    }
    if (bucketMs <= 0) {
      throw new InferenceLatencyValidationError('bucketMs must be positive');
    }
    const binCount = Math.ceil((endTime - startTime) / bucketMs);
    if (binCount > MAX_TREND_POINTS) {
      throw new InferenceLatencyValidationError(
        `trend window produces ${binCount} bins; cap is ${MAX_TREND_POINTS}. Increase bucketMs or shrink the range.`,
      );
    }

    const connection = this.connectionRegistry.get(connectionId);
    const capabilities = connection.getCapabilities();
    const source: InferenceLatencySource = capabilities.hasCommandLog ? 'commandlog' : 'slowlog';

    const startSec = Math.floor(startTime / 1000);
    const endSec = Math.floor(endTime / 1000);

    const rawEntries =
      source === 'commandlog'
        ? await this.storage.getCommandLogEntries({
            connectionId,
            startTime: startSec,
            endTime: endSec,
            limit: MAX_ENTRIES_PER_PROFILE,
          })
        : await this.storage.getSlowLogEntries({
            connectionId,
            startTime: startSec,
            endTime: endSec,
            limit: MAX_ENTRIES_PER_PROFILE,
          });

    const binsByIndex = new Map<number, number[]>();
    for (const raw of rawEntries) {
      if (bucketEntry(raw.command) !== bucket) continue;
      // Route every storage row through the same projection the profile path
      // uses, so a timestamp/unit change in StoredCommandLogEntry /
      // StoredSlowLogEntry breaks exactly one place (bucketing.ts) instead of
      // silently desynchronising the profile and trend pipelines.
      const projected = projectToLatencyEntry(raw);
      const tsMs = projected.timestamp * 1000;
      if (tsMs < startTime || tsMs >= endTime) continue;
      const binIndex = Math.floor((tsMs - startTime) / bucketMs);
      let arr = binsByIndex.get(binIndex);
      if (!arr) {
        arr = [];
        binsByIndex.set(binIndex, arr);
      }
      arr.push(projected.duration);
    }

    const points: InferenceLatencyTrendPoint[] = [];
    for (let i = 0; i < binCount; i += 1) {
      const durations = binsByIndex.get(i);
      if (!durations || durations.length === 0) continue;
      const { p50, p95, p99, count } = computePercentiles(durations);
      points.push({
        capturedAt: startTime + i * bucketMs,
        p50,
        p95,
        p99,
        count,
      });
    }

    return { connectionId, bucket, startTime, endTime, bucketMs, source, points };
  }

  protected async pollConnection(ctx: ConnectionContext): Promise<void> {
    const endMs = Date.now();
    const profile = await this.computeProfile(ctx.connectionId, {
      startMs: endMs - POLL_TICK_WINDOW_MS,
      endMs,
    });
    this.prometheusService.updateInferenceLatencyMetrics(
      ctx.connectionId,
      profile.buckets.map((b) => ({
        bucket: b.bucket,
        p50: b.p50,
        p95: b.p95,
        p99: b.p99,
        unhealthy: b.unhealthy,
      })),
    );
    await this.evaluateSlas(ctx, profile);
  }

  private resolveProfileWindow(options: {
    windowMs?: number;
    startTime?: number;
    endTime?: number;
  }): ProfileWindow {
    const hasStart = options.startTime !== undefined;
    const hasEnd = options.endTime !== undefined;
    if (hasStart !== hasEnd) {
      throw new InferenceLatencyValidationError(
        'startTime and endTime must be provided together',
      );
    }
    if (hasStart && hasEnd) {
      if (options.endTime! <= options.startTime!) {
        throw new InferenceLatencyValidationError('endTime must be greater than startTime');
      }
      return { startMs: options.startTime!, endMs: options.endTime! };
    }
    const windowMs = Math.max(1_000, options.windowMs ?? DEFAULT_PROFILE_WINDOW_MS);
    const endMs = Date.now();
    return { startMs: endMs - windowMs, endMs };
  }

  private async computeProfile(
    connectionId: string,
    window: ProfileWindow,
  ): Promise<InferenceLatencyProfile> {
    const connection = this.connectionRegistry.get(connectionId);
    const capabilities = connection.getCapabilities();
    const source: InferenceLatencySource = capabilities.hasCommandLog ? 'commandlog' : 'slowlog';

    const { startMs, endMs } = window;
    const windowMs = endMs - startMs;
    const startSec = Math.floor(startMs / 1000);
    const endSec = Math.floor(endMs / 1000);

    const rawEntries: Array<StoredSlowLogEntry | StoredCommandLogEntry> =
      source === 'commandlog'
        ? await this.storage.getCommandLogEntries({
            connectionId,
            startTime: startSec,
            endTime: endSec,
            limit: MAX_ENTRIES_PER_PROFILE,
          })
        : await this.storage.getSlowLogEntries({
            connectionId,
            startTime: startSec,
            endTime: endSec,
            limit: MAX_ENTRIES_PER_PROFILE,
          });

    const entriesByBucket = new Map<string, LatencyEntry[]>();
    for (const raw of rawEntries) {
      const bucket = bucketEntry(raw.command);
      if (!bucket) continue;
      const projected = projectToLatencyEntry(raw);
      const normalised: LatencyEntry = { ...projected, timestamp: projected.timestamp * 1000 };
      let arr = entriesByBucket.get(bucket);
      if (!arr) {
        arr = [];
        entriesByBucket.set(bucket, arr);
      }
      arr.push(normalised);
    }

    const snapshots = await this.storage.getVectorIndexSnapshots({
      connectionId,
      startTime: startMs,
      endTime: endMs,
    });

    const buckets: InferenceLatencyBucket[] = [];
    for (const [bucketKey, entries] of entriesByBucket) {
      const { p50, p95, p99, count } = computePercentiles(entries.map((e) => e.duration));
      const unhealthy =
        bucketKey.startsWith(FT_SEARCH_BUCKET_PREFIX) && p50 > FT_SEARCH_HEALTHY_P50_THRESHOLD_US;
      const namedEvents = annotateIndexingEvents({
        bucketKey,
        entries,
        snapshots,
        windowStartMs: startMs,
        windowEndMs: endMs,
      });
      buckets.push({ bucket: bucketKey, p50, p95, p99, count, unhealthy, namedEvents });
    }

    const thresholdDirective =
      source === 'commandlog' ? 'commandlog-execution-slower-than' : 'slowlog-log-slower-than';
    const thresholdRaw = await connection.getConfigValue(thresholdDirective).catch(() => null);
    const thresholdUs = thresholdRaw === null ? 0 : Number(thresholdRaw) || 0;

    return {
      connectionId,
      windowMs,
      source,
      thresholdDirective,
      thresholdUs,
      buckets,
      generatedAt: Date.now(),
    };
  }

  private async evaluateSlas(
    ctx: ConnectionContext,
    profile: InferenceLatencyProfile,
  ): Promise<void> {
    const settings = this.settingsService.getCachedSettings();
    const slaConfig = settings.inferenceSlaConfig ?? {};
    const now = Date.now();
    const breaches: Array<{ indexName: string; breached: boolean }> = [];

    for (const bucket of profile.buckets) {
      if (!bucket.bucket.startsWith(FT_SEARCH_BUCKET_PREFIX)) continue;
      const indexName = bucket.bucket.slice(FT_SEARCH_BUCKET_PREFIX.length);
      const config = slaConfig[indexName];
      if (!config || !config.enabled) continue;

      const result = evaluateSla({
        connectionId: ctx.connectionId,
        indexName,
        currentP99Us: bucket.p99,
        thresholdUs: config.p99ThresholdUs,
        now,
        state: this.slaState,
      });

      breaches.push({ indexName, breached: bucket.p99 > config.p99ThresholdUs });

      if (result.fired && this.webhookEventsProService) {
        try {
          await this.webhookEventsProService.dispatchInferenceSlaBreach({
            indexName,
            currentP99Us: bucket.p99,
            thresholdUs: config.p99ThresholdUs,
            windowMs: profile.windowMs,
            timestamp: now,
            instance: { host: ctx.host, port: ctx.port, connectionId: ctx.connectionId },
            connectionId: ctx.connectionId,
          });
        } catch (error) {
          this.logger.warn(
            `dispatchInferenceSlaBreach failed for ${ctx.connectionId}/${indexName}: ${(error as Error).message}`,
          );
        }
      }
    }

    this.prometheusService.updateInferenceSlaBreachMetrics(ctx.connectionId, breaches);
  }
}
