import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  IInferenceLatencyProService,
  IWebhookEventsProService,
  InferenceLatencyProfile,
  InferenceProfileTickContext,
  WEBHOOK_EVENTS_PRO_SERVICE,
} from '@betterdb/shared';
import { PrometheusService } from '@app/prometheus/prometheus.service';
import { SettingsService } from '@app/settings/settings.service';
import { SlaState, evaluateSla } from './sla';

const FT_SEARCH_BUCKET_PREFIX = 'FT.SEARCH:';

@Injectable()
export class InferenceLatencyProService implements IInferenceLatencyProService {
  private readonly logger = new Logger(InferenceLatencyProService.name);
  private readonly slaState = new Map<string, SlaState>();

  constructor(
    private readonly prometheusService: PrometheusService,
    private readonly settingsService: SettingsService,
    @Optional()
    @Inject(WEBHOOK_EVENTS_PRO_SERVICE)
    private readonly webhookEventsProService?: IWebhookEventsProService,
  ) {}

  async onProfileTick(
    ctx: InferenceProfileTickContext,
    profile: InferenceLatencyProfile,
  ): Promise<void> {
    const settings = this.settingsService.getCachedSettings();
    const slaConfig = settings.inferenceSlaConfig ?? {};
    const now = Date.now();
    const evaluatedIndexes = new Set<string>();

    // Build the authoritative set of (connection, index) pairs that SHOULD
    // retain state on this tick. Drive it from config, not from traffic —
    // a tick with no FT.SEARCH traffic must not wipe the debounce state of
    // a still-breaching index.
    const configuredKeys = new Set<string>();
    for (const [indexName, entry] of Object.entries(slaConfig)) {
      if (entry?.enabled) {
        configuredKeys.add(`${ctx.connectionId}|${indexName}`);
      }
    }

    const breachByIndex = new Map<string, boolean>();

    for (const bucket of profile.buckets) {
      if (!bucket.bucket.startsWith(FT_SEARCH_BUCKET_PREFIX)) {
        continue;
      }
      const indexName = bucket.bucket.slice(FT_SEARCH_BUCKET_PREFIX.length);
      const config = slaConfig[indexName];
      if (!config || !config.enabled) {
        continue;
      }

      const result = evaluateSla({
        connectionId: ctx.connectionId,
        indexName,
        currentP99Us: bucket.p99,
        thresholdUs: config.p99ThresholdUs,
        now,
        state: this.slaState,
      });

      evaluatedIndexes.add(indexName);
      breachByIndex.set(indexName, bucket.p99 > config.p99ThresholdUs);

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

    // Fill in configured-but-quiet indexes so the Prometheus time-series stays
    // continuous. "No traffic" ≠ "no data"; carry forward the debounce state
    // (breached if a prior fire wasn't resolved, not breached otherwise) so
    // Grafana doesn't flip to a false 'resolved' when an index goes quiet.
    for (const [indexName, entry] of Object.entries(slaConfig)) {
      if (!entry?.enabled) {
        continue;
      }
      if (evaluatedIndexes.has(indexName)) {
        continue;
      }
      const prior = this.slaState.get(`${ctx.connectionId}|${indexName}`);
      breachByIndex.set(indexName, Boolean(prior) && !prior!.resolved);
    }

    const breaches = Array.from(breachByIndex, ([indexName, breached]) => ({
      indexName,
      breached,
    }));

    // Drop debounce state only for indexes whose SLA was disabled or removed
    // from the config — not for indexes that simply had no FT.SEARCH traffic
    // this tick.
    const prefix = `${ctx.connectionId}|`;
    for (const key of Array.from(this.slaState.keys())) {
      if (key.startsWith(prefix) && !configuredKeys.has(key)) {
        this.slaState.delete(key);
      }
    }

    this.prometheusService.updateInferenceSlaBreachMetrics(ctx.connectionId, breaches);
  }

  onConnectionRemoved(connectionId: string): void {
    const prefix = `${connectionId}|`;
    for (const key of Array.from(this.slaState.keys())) {
      if (key.startsWith(prefix)) {
        this.slaState.delete(key);
      }
    }
  }
}
