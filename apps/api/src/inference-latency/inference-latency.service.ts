import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import {
  FT_SEARCH_HEALTHY_P50_THRESHOLD_US,
  IWebhookEventsProService,
  InferenceLatencyBucket,
  InferenceLatencyProfile,
  InferenceLatencySource,
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

const SLA_EVAL_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_PROFILE_WINDOW_MS = 15 * 60 * 1000;
const MAX_ENTRIES_PER_PROFILE = 100_000;
const POLL_INTERVAL_MS = 60_000;
const FT_SEARCH_BUCKET_PREFIX = 'FT.SEARCH:';

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

  async getProfile(connectionId: string, windowMs?: number): Promise<InferenceLatencyProfile> {
    const effectiveWindow = Math.max(1_000, windowMs ?? DEFAULT_PROFILE_WINDOW_MS);
    return this.computeProfile(connectionId, effectiveWindow);
  }

  protected async pollConnection(ctx: ConnectionContext): Promise<void> {
    const profile = await this.computeProfile(ctx.connectionId, SLA_EVAL_WINDOW_MS);
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

  private async computeProfile(
    connectionId: string,
    windowMs: number,
  ): Promise<InferenceLatencyProfile> {
    const connection = this.connectionRegistry.get(connectionId);
    const capabilities = connection.getCapabilities();
    const source: InferenceLatencySource = capabilities.hasCommandLog ? 'commandlog' : 'slowlog';

    const nowMs = Date.now();
    const startSec = Math.floor((nowMs - windowMs) / 1000);
    const endSec = Math.floor(nowMs / 1000);

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
      startTime: nowMs - windowMs,
      endTime: nowMs,
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
        windowStartMs: nowMs - windowMs,
        windowEndMs: nowMs,
      });
      buckets.push({ bucket: bucketKey, p50, p95, p99, count, unhealthy, namedEvents });
    }

    const thresholdDirective =
      source === 'commandlog' ? 'command-log-slow-time-threshold' : 'slowlog-log-slower-than';
    const thresholdRaw = await connection.getConfigValue(thresholdDirective).catch(() => null);
    const thresholdUs = thresholdRaw === null ? 0 : Number(thresholdRaw) || 0;

    return {
      connectionId,
      windowMs,
      source,
      thresholdDirective,
      thresholdUs,
      buckets,
      generatedAt: nowMs,
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

      breaches.push({ indexName, breached: bucket.p99 >= config.p99ThresholdUs });

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
