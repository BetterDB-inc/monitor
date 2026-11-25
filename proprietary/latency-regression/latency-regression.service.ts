import { randomUUID } from 'crypto';
import { Injectable, Logger, OnModuleInit, Inject, Optional } from '@nestjs/common';
import {
  StoragePort,
  StoredLatencyHistogram,
} from '@app/common/interfaces/storage-port.interface';
import {
  MultiConnectionPoller,
  ConnectionContext,
} from '@app/common/services/multi-connection-poller';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import { WEBHOOK_EVENTS_PRO_SERVICE, IWebhookEventsProService } from '@betterdb/shared';
import {
  MetricType,
  AnomalyType,
  AnomalySeverity,
  AnomalyEventSink,
  ANOMALY_EVENT_SINK,
} from '../anomaly-detection/types';
import { csvList } from '@app/common/utils/csv-list';
import {
  ADMIN_COMMANDS,
  RegressionDetector,
  parseMajorVersion,
  STALE_SAMPLE_MS,
} from './regression-detector';
import {
  ClusterRefreshPoint,
  CommandP99Point,
  DetectorInput,
  RegressionBasis,
  RegressionFinding,
} from './types';
import {
  IntervalPoint,
  callsPerMinute,
  intervalPoints,
  versionAt,
} from './interval-percentiles';

const POLL_INTERVAL_MS = 60_000;
/** Histogram snapshots read per page when backfilling, to bound memory on the first poll. */
const HISTOGRAM_PAGE = 240;

interface IntervalState {
  last: StoredLatencyHistogram;
  /** Ascending capturedAt, trimmed to SAMPLE_LOOKBACK_MS. */
  points: IntervalPoint[];
}
/** How much latencystats history the detector needs (sustained baseline window). */
const SAMPLE_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** Window used to derive per-command call volume from commandstats deltas. */
const VOLUME_WINDOW_MS = 10 * 60 * 1000;
/** Window of cluster|slots / cluster|shards deltas for topology correlation. */
const CLUSTER_DELTA_WINDOW_MS = 60 * 60 * 1000;
const CLUSTER_REFRESH_COMMANDS = ['cluster|slots', 'cluster|shards'];

/**
 * Commands the detector skips. LATENCY_REGRESSION_IGNORE_COMMANDS replaces the
 * built-in ADMIN_COMMANDS (set but empty turns the filter off), and
 * LATENCY_REGRESSION_EXTRA_IGNORE_COMMANDS is added to whichever list applies.
 */
export function latencyRegressionIgnoreCommands(
  env: Record<string, string | undefined> = process.env,
): Set<string> {
  const replace = env.LATENCY_REGRESSION_IGNORE_COMMANDS;
  const base = replace === undefined ? ADMIN_COMMANDS : csvList(replace);
  const extra = csvList(env.LATENCY_REGRESSION_EXTRA_IGNORE_COMMANDS);
  return new Set([...base, ...extra].map((command) => command.toLowerCase()));
}

/**
 * Pro guard for per-command P99 latency regressions (valkey/valkey#3527).
 * Feeds stored INFO latencystats samples into a pure per-connection
 * RegressionDetector and turns findings into anomaly events + webhooks.
 */
@Injectable()
export class LatencyRegressionService extends MultiConnectionPoller implements OnModuleInit {
  protected readonly logger = new Logger(LatencyRegressionService.name);

  private detectors = new Map<string, RegressionDetector>();
  private intervals = new Map<string, IntervalState>();
  /** Last basis logged per connection, so the choice is logged once per change. */
  private basisLogged = new Map<string, RegressionBasis>();
  // Read once at startup, like the slowlog ignore lists.
  private readonly ignoreCommands = latencyRegressionIgnoreCommands();

  constructor(
    connectionRegistry: ConnectionRegistry,
    @Inject('STORAGE_CLIENT')
    private readonly storage: StoragePort,
    @Optional()
    @Inject(WEBHOOK_EVENTS_PRO_SERVICE)
    private readonly webhookEventsProService?: IWebhookEventsProService,
    @Optional()
    @Inject(ANOMALY_EVENT_SINK)
    private readonly anomalyEventSink?: AnomalyEventSink,
  ) {
    super(connectionRegistry);
  }

  onModuleInit() {
    this.logger.log('Starting P99 latency regression guard...');
    this.start();
  }

  protected getIntervalMs(): number {
    return POLL_INTERVAL_MS;
  }

  protected onConnectionRemoved(connectionId: string): void {
    this.detectors.delete(connectionId);
    this.intervals.delete(connectionId);
    this.basisLogged.delete(connectionId);
  }

  /** First poll: page backwards through 24h of snapshots, then process oldest-first. */
  private async backfillIntervals(
    connectionId: string,
    nowMs: number,
  ): Promise<IntervalState | null> {
    const pages: StoredLatencyHistogram[][] = [];
    let endTime = nowMs;
    const startTime = nowMs - SAMPLE_LOOKBACK_MS;
    for (;;) {
      const page = await this.storage.getLatencyHistograms({
        connectionId,
        startTime,
        endTime,
        limit: HISTOGRAM_PAGE,
      });
      if (page.length === 0) break;
      pages.push(page); // each page is newest-first
      const oldest = page[page.length - 1].timestamp;
      if (page.length < HISTOGRAM_PAGE || oldest <= startTime) break;
      endTime = oldest - 1;
    }
    const snapshots = pages.flat().reverse(); // oldest-first
    if (snapshots.length === 0) return null;
    const points: IntervalPoint[] = [];
    for (let i = 1; i < snapshots.length; i += 1) {
      points.push(...intervalPoints(snapshots[i - 1], snapshots[i]));
    }
    return { last: snapshots[snapshots.length - 1], points };
  }

  /** Rolling per-connection window of interval points; null when no histogram rows exist. */
  private async advanceIntervals(
    connectionId: string,
    nowMs: number,
  ): Promise<IntervalState | null> {
    let state = this.intervals.get(connectionId);
    if (!state) {
      const filled = await this.backfillIntervals(connectionId, nowMs);
      if (!filled) return null;
      state = filled;
    } else {
      const fresh = (
        await this.storage.getLatencyHistograms({
          connectionId,
          startTime: state.last.timestamp + 1,
          endTime: nowMs,
          limit: 10,
        })
      ).reverse();
      for (const snapshot of fresh) {
        state.points.push(...intervalPoints(state.last, snapshot));
        state.last = snapshot;
      }
    }
    const cutoff = nowMs - SAMPLE_LOOKBACK_MS;
    const firstKept = state.points.findIndex((p) => p.capturedAt >= cutoff);
    state.points = firstKept === -1 ? [] : state.points.slice(firstKept);
    this.intervals.set(connectionId, state);
    return state;
  }

  /** Cumulative-path volume gating input: commandstats call deltas for commands seen recently. */
  private async cumulativeCallsPerMin(
    connectionId: string,
    samples: CommandP99Point[],
    nowMs: number,
  ): Promise<Map<string, number>> {
    const recentCommands = new Set<string>();
    for (const s of samples) {
      if (s.capturedAt >= nowMs - STALE_SAMPLE_MS) recentCommands.add(s.command);
    }
    const callsPerMin = new Map<string, number>();
    for (const command of recentCommands) {
      const history = await this.storage.getCommandStatsHistory({
        connectionId,
        command,
        startTime: nowMs - VOLUME_WINDOW_MS,
        endTime: nowMs,
      });
      if (history.length === 0) continue;
      const totalCalls = history.reduce((sum, h) => sum + h.callsDelta, 0);
      // Each stored sample is one ~60s commandstats poll, so callsDelta is ≈ that minute's call
      // count. Average over the samples that ACTUALLY exist, not the fixed VOLUME_WINDOW_MS:
      // before the buffer fills (e.g. shortly after startup) dividing by the full window
      // under-reports the rate — 5 samples at 100 calls/min would read as 50 and be wrongly
      // excluded by the >=MIN_CALLS_PER_MIN gate, so their P99 regression is never evaluated.
      callsPerMin.set(command, totalCalls / history.length);
    }
    return callsPerMin;
  }

  protected async pollConnection(ctx: ConnectionContext): Promise<void> {
    const nowMs = Date.now();

    const stored = await this.storage.getLatencyStatsHistory({
      connectionId: ctx.connectionId,
      startTime: nowMs - SAMPLE_LOOKBACK_MS,
      endTime: nowMs,
    });
    if (stored.length === 0) return;

    // Prefer per-interval P99s derived from LATENCY HISTOGRAM deltas: INFO latencystats is
    // cumulative since server start, so a recent regression barely moves it on a long-lived node.
    let state: IntervalState | null = null;
    try {
      state = await this.advanceIntervals(ctx.connectionId, nowMs);
    } catch (err) {
      this.logger.warn(
        `Failed to read latency histograms for ${ctx.connectionName}, using cumulative latencystats: ${err instanceof Error ? err.message : err}`,
      );
    }
    const basis: RegressionBasis = state && state.points.length > 0 ? 'interval' : 'cumulative';
    if (this.basisLogged.get(ctx.connectionId) !== basis) {
      this.basisLogged.set(ctx.connectionId, basis);
      this.logger.log(
        basis === 'interval'
          ? `latency regression for ${ctx.connectionName}: judging per-interval P99 from LATENCY HISTOGRAM`
          : `latency regression for ${ctx.connectionName}: falling back to cumulative latencystats (no histogram rows)`,
      );
    }

    let samples: CommandP99Point[];
    let callsPerMin: Map<string, number>;
    if (state && basis === 'interval') {
      samples = state.points.map((p) => ({
        command: p.command,
        p99Us: p.p99Us,
        capturedAt: p.capturedAt,
        serverVersion: versionAt(stored, p.capturedAt),
      }));
      callsPerMin = callsPerMinute(state.points, nowMs - VOLUME_WINDOW_MS, nowMs);
    } else {
      samples = stored.map((s) => ({
        command: s.command,
        p99Us: s.p99Us,
        serverVersion: s.serverVersion,
        capturedAt: s.capturedAt,
      }));
      callsPerMin = await this.cumulativeCallsPerMin(ctx.connectionId, samples, nowMs);
    }

    // Topology-refresh correlation input (hourly-spike symptom in #3527).
    const clusterRefreshDeltas: ClusterRefreshPoint[] = [];
    for (const command of CLUSTER_REFRESH_COMMANDS) {
      const history = await this.storage.getCommandStatsHistory({
        connectionId: ctx.connectionId,
        command,
        startTime: nowMs - CLUSTER_DELTA_WINDOW_MS,
        endTime: nowMs,
      });
      for (const h of history) {
        clusterRefreshDeltas.push({ capturedAt: h.capturedAt, callsDelta: h.callsDelta });
      }
    }

    let detector = this.detectors.get(ctx.connectionId);
    if (!detector) {
      detector = new RegressionDetector({ ignoreCommands: this.ignoreCommands });
      this.detectors.set(ctx.connectionId, detector);
    }

    const input: DetectorInput = { nowMs, samples, callsPerMin, clusterRefreshDeltas, basis };
    const findings = detector.evaluate(input);
    this.anomalyEventSink?.reportLatencyDegraded?.(ctx.connectionId, detector.isDegraded());

    for (const finding of findings) {
      await this.handleFinding(finding, ctx, detector);
    }
  }

  private async handleFinding(
    finding: RegressionFinding,
    ctx: ConnectionContext,
    detector: RegressionDetector,
  ): Promise<void> {
    this.logger.warn(`Latency regression on ${ctx.connectionName}: ${finding.message}`);

    const prefetchBatchMaxSize = await this.getPrefetchBatchMaxSize(ctx, finding.currentVersion);
    const runbook = this.buildRunbook(finding, prefetchBatchMaxSize);
    const worst = finding.commands[0];

    const event = {
      // Storage adapters (postgres) require UUID event ids
      id: randomUUID(),
      timestamp: finding.timestamp,
      metricType: MetricType.COMMAND_P99,
      anomalyType: AnomalyType.SPIKE,
      severity:
        finding.severity === 'critical' ? AnomalySeverity.CRITICAL : AnomalySeverity.WARNING,
      value: worst.currentP99Us,
      baseline: worst.baselineP99Us,
      zScore: 0,
      stdDev: 0,
      threshold: worst.degradationFactor,
      message: finding.message,
      kind: finding.kind,
      commands: finding.commands.map((c) => c.command).sort(),
      // Instance metadata, consistent with other anomaly producers.
      sourceHost: ctx.host,
      sourcePort: ctx.port,
      relatedMetrics: finding.topologyRefreshCorrelated
        ? [MetricType.CLUSTER_STATE, MetricType.COMMAND_P99]
        : undefined,
      resolved: false,
      connectionId: ctx.connectionId,
    };
    try {
      this.anomalyEventSink?.stampExternalAnomaly?.(event);
    } catch (err) {
      this.logger.warn(
        `Failed to stamp latency regression event: ${err instanceof Error ? err.message : err}`,
      );
    }

    try {
      await this.storage.saveAnomalyEvent(event, ctx.connectionId);
    } catch (err) {
      // The detector already latched its one-shot/cooldown when it returned this finding. Since
      // no durable record was written, re-arm it so the regression re-emits on the next poll, and
      // do NOT dispatch the webhook — otherwise we would notify without any persisted event.
      this.logger.error(
        `Failed to persist latency regression event — re-arming for retry: ${err instanceof Error ? err.message : err}`,
      );
      detector.revert(finding);
      return;
    }

    try {
      this.anomalyEventSink?.ingestExternalAnomaly(event);
    } catch (err) {
      this.logger.warn(
        `Failed to hand latency regression event to the anomaly sink: ${err instanceof Error ? err.message : err}`,
      );
    }

    if (this.webhookEventsProService) {
      this.webhookEventsProService
        .dispatchLatencyRegressionDetected({
          kind: finding.kind,
          previousVersion: finding.previousVersion,
          currentVersion: finding.currentVersion,
          commands: finding.commands,
          topologyRefreshCorrelated: finding.topologyRefreshCorrelated,
          basis: finding.basis,
          prefetchBatchMaxSize,
          runbook,
          message: finding.message,
          timestamp: finding.timestamp,
          instance: { host: ctx.host, port: ctx.port },
          connectionId: ctx.connectionId,
        })
        .catch((err) => {
          this.logger.error('Failed to dispatch latency.regression.detected webhook', err);
        });
    }
  }

  /** CONFIG GET prefetch-batch-max-size on Valkey 9+; null when unavailable/ACL-denied. */
  private async getPrefetchBatchMaxSize(
    ctx: ConnectionContext,
    currentVersion: string,
  ): Promise<number | null> {
    if (parseMajorVersion(currentVersion) < 9) return null;
    try {
      const value = await ctx.client.getConfigValue('prefetch-batch-max-size');
      if (value === null || value === '') return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private buildRunbook(finding: RegressionFinding, prefetchBatchMaxSize: number | null): string[] {
    const runbook: string[] = [
      'Compare per-command P99 before/after the change via GET /metrics/latencystats/history.',
    ];
    if (parseMajorVersion(finding.currentVersion) >= 9) {
      const current =
        prefetchBatchMaxSize !== null ? `currently ${prefetchBatchMaxSize}` : 'current value unknown';
      runbook.push(
        `Tune prefetch-batch-max-size (${current}, default 16): try 4, or 0 to disable batched prefetching (valkey PR #2092).`,
      );
    }
    runbook.push(
      'Split multi-thousand-command pipelines into smaller batches on the client side.',
    );
    runbook.push(
      finding.topologyRefreshCorrelated
        ? 'Spikes correlate with cluster topology refresh — review the client topology refresh interval.'
        : 'If P99 spikes recur hourly, check the client cluster topology refresh interval.',
    );
    if (finding.kind === 'upgrade_regression') {
      runbook.push(
        'Consider holding the rollout / rolling back; track valkey/valkey#3527 and valkey/valkey#3451 for upstream fixes.',
      );
    }
    return runbook;
  }
}
