import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import {
  FT_SEARCH_HEALTHY_P50_THRESHOLD_US,
  IInferenceLatencyProService,
  INFERENCE_LATENCY_PRO_SERVICE,
  InferenceLatencyBucket,
  InferenceLatencyProfile,
  InferenceLatencySource,
  InferenceLatencyTrend,
  InferenceLatencyTrendPoint,
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
import { LatencyEntry, bucketEntry, projectToLatencyEntry } from './bucketing';
import { annotateIndexingEvents } from './correlation';
import { computePercentiles } from './percentiles';

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

  constructor(
    connectionRegistry: ConnectionRegistry,
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    private readonly prometheusService: PrometheusService,
    @Optional()
    @Inject(INFERENCE_LATENCY_PRO_SERVICE)
    private readonly proService?: IInferenceLatencyProService,
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
    this.proService?.onConnectionRemoved(connectionId);
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
    bucketMs?: number,
  ): Promise<InferenceLatencyTrend> {
    if (endTime <= startTime) {
      throw new InferenceLatencyValidationError('endTime must be greater than startTime');
    }
    const effectiveBucketMs = bucketMs ?? DEFAULT_TREND_BUCKET_MS;
    if (effectiveBucketMs <= 0) {
      throw new InferenceLatencyValidationError('bucketMs must be positive');
    }
    const binCount = Math.ceil((endTime - startTime) / effectiveBucketMs);
    if (binCount > MAX_TREND_POINTS) {
      throw new InferenceLatencyValidationError(
        `trend window produces ${binCount} bins; cap is ${MAX_TREND_POINTS}. Increase bucketMs or shrink the range.`,
      );
    }

    const connection = this.connectionRegistry.get(connectionId);
    const capabilities = connection.getCapabilities();
    const source: InferenceLatencySource = capabilities.hasCommandLog ? 'commandlog' : 'slowlog';

    // Storage timestamps are second-resolution. Round the window outward so
    // the storage query always returns a superset of the requested ms window
    // (robust against either inclusive `<=` or strict `<` upper bounds in the
    // adapter); the ms-precision filter below is then authoritative.
    const startSec = Math.floor(startTime / 1000);
    const endSec = Math.ceil(endTime / 1000);

    const rawEntries =
      source === 'commandlog'
        ? await this.storage.getCommandLogEntries({
            connectionId,
            startTime: startSec,
            endTime: endSec,
            // COMMANDLOG stores three types (slow, large-request, large-reply).
            // Only `slow` reflects execution time; the large-payload types
            // carry unrelated durations that would pollute percentiles.
            type: 'slow',
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
      const binIndex = Math.floor((tsMs - startTime) / effectiveBucketMs);
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
        capturedAt: startTime + i * effectiveBucketMs,
        p50,
        p95,
        p99,
        count,
      });
    }

    return {
      connectionId,
      bucket,
      startTime,
      endTime,
      bucketMs: effectiveBucketMs,
      source,
      points,
    };
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
    if (this.proService) {
      await this.proService.onProfileTick(
        { connectionId: ctx.connectionId, host: ctx.host, port: ctx.port },
        profile,
      );
    }
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
    const endSec = Math.ceil(endMs / 1000);

    const rawEntries: Array<StoredSlowLogEntry | StoredCommandLogEntry> =
      source === 'commandlog'
        ? await this.storage.getCommandLogEntries({
            connectionId,
            startTime: startSec,
            endTime: endSec,
            // COMMANDLOG stores three types (slow, large-request, large-reply).
            // Only `slow` reflects execution time; the large-payload types
            // carry unrelated durations that would pollute percentiles.
            type: 'slow',
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
      const tsMs = projected.timestamp * 1000;
      // Storage boundaries are second-precision (floored); re-filter at ms
      // precision so sub-second slop cannot leak into the profile and
      // disagree with the trend path for the same logical window.
      if (tsMs < startMs || tsMs >= endMs) continue;
      const normalised: LatencyEntry = { ...projected, timestamp: tsMs };
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

}
