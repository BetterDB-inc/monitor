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
  IntervalVolume,
  callsPerMinute,
  diffSnapshots,
  versionTimeline,
} from './interval-percentiles';

const POLL_INTERVAL_MS = 60_000;
/** Histogram snapshots per page on the first-poll backfill. Only one page is held at a time. */
const HISTOGRAM_PAGE = 240;
/** Page size for the per-poll incremental read. Paging continues until a short page. */
const INCREMENTAL_PAGE = 10;

interface IntervalState {
  last: StoredLatencyHistogram;
  /** Ascending capturedAt, trimmed to SAMPLE_LOOKBACK_MS. */
  points: IntervalPoint[];
  /** Every interval's call volume (not only P99-eligible ones), ascending, trimmed to VOLUME_WINDOW_MS. */
  volumes: IntervalVolume[];
}

/** Why a poll used the cumulative basis. Shown in the log line. */
type FallbackReason =
  | 'no histogram rows'
  | 'not enough histogram data yet'
  | 'too few calls per interval'
  | 'histogram rows are stale'
  | 'histogram read failed';

function trimBefore<T extends { capturedAt: number }>(items: T[], cutoff: number): T[] {
  const first = items.findIndex((p) => p.capturedAt >= cutoff);
  if (first === -1) return [];
  return first === 0 ? items : items.slice(first);
}

/** How much latencystats history the detector needs (sustained baseline window). */
const SAMPLE_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** Window used to derive per-command call volume from commandstats deltas. */
const VOLUME_WINDOW_MS = 10 * 60 * 1000;
/** Window of cluster|slots / cluster|shards deltas for topology correlation. */
const CLUSTER_DELTA_WINDOW_MS = 60 * 60 * 1000;
const CLUSTER_REFRESH_COMMANDS = ['cluster|slots', 'cluster|shards'];

/**
 * First runbook step. It depends on the basis, because the latencystats history is cumulative.
 * Both routes pick the connection from the X-Connection-Id header. Without it the latencystats
 * route reads the default connection and the histograms route mixes every connection's rows.
 */
function firstRunbookStep(basis: RegressionBasis, connectionId: string): string {
  const header = `with the X-Connection-Id header set to ${connectionId}`;
  if (basis === 'cumulative') {
    return `Compare per-command P99 before/after the change via GET /metrics/latencystats/history ${header}.`;
  }
  return `This finding uses per-minute P99s from consecutive LATENCY HISTOGRAM snapshots: compare the bucket deltas of each command before and after the change via GET /latency-analytics/histograms ${header} (and startTime, endTime, limit). GET /metrics/latencystats/history is cumulative since server start and can look flat for this regression.`;
}

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
  /** Last (basis, reason) logged per connection, so each change is logged once (read failures included). */
  private basisLogged = new Map<string, string>();
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

  /**
   * Reads every snapshot in [startTime, endTime] one page at a time. The adapters return
   * newest-first with LIMIT, so paging runs backwards in time. Each consecutive pair is diffed
   * as soon as both are seen, so only one page of snapshots is in memory, and no snapshot is
   * skipped however many piled up. `anchor` is the newest snapshot already processed: it is
   * diffed against the oldest snapshot read. Returns null when the range has no snapshots.
   */
  private async readHistogramRange(
    connectionId: string,
    startTime: number,
    endTime: number,
    pageSize: number,
    anchor?: StoredLatencyHistogram,
  ): Promise<{
    newest: StoredLatencyHistogram;
    points: IntervalPoint[];
    volumes: IntervalVolume[];
  } | null> {
    let newest: StoredLatencyHistogram | undefined;
    let newer: StoredLatencyHistogram | undefined; // oldest snapshot seen so far
    const points: IntervalPoint[] = [];
    const volumes: IntervalVolume[] = [];
    const take = (older: StoredLatencyHistogram, younger: StoredLatencyHistogram) => {
      const diff = diffSnapshots(older, younger);
      for (const p of diff.points) points.push(p);
      for (const v of diff.volumes) volumes.push(v);
    };
    let cursor = endTime;
    for (;;) {
      const page = await this.storage.getLatencyHistograms({
        connectionId,
        startTime,
        endTime: cursor,
        limit: pageSize,
      });
      if (page.length === 0) break;
      page.sort((a, b) => b.timestamp - a.timestamp); // adapters already do this; cheap guard
      for (const snapshot of page) {
        if (!newest) newest = snapshot;
        if (newer) take(snapshot, newer);
        newer = snapshot;
      }
      const oldest = page[page.length - 1].timestamp;
      if (page.length < pageSize || oldest <= startTime) break;
      cursor = oldest - 1;
    }
    if (!newest || !newer) return null;
    if (anchor) take(anchor, newer);
    // Built newest-first; flip to ascending capturedAt (points of one interval share capturedAt).
    points.reverse();
    volumes.reverse();
    return { newest, points, volumes };
  }

  /** Rolling per-connection window of interval points; null when the connection has no histogram rows. */
  private async advanceIntervals(
    connectionId: string,
    nowMs: number,
  ): Promise<IntervalState | null> {
    let state = this.intervals.get(connectionId);
    if (!state) {
      const read = await this.readHistogramRange(
        connectionId,
        nowMs - SAMPLE_LOOKBACK_MS,
        nowMs,
        HISTOGRAM_PAGE,
      );
      if (!read) return null;
      state = { last: read.newest, points: read.points, volumes: read.volumes };
    } else {
      const read = await this.readHistogramRange(
        connectionId,
        state.last.timestamp + 1,
        nowMs,
        INCREMENTAL_PAGE,
        state.last,
      );
      if (read) {
        for (const p of read.points) state.points.push(p);
        for (const v of read.volumes) state.volumes.push(v);
        state.last = read.newest;
      }
    }
    state.points = trimBefore(state.points, nowMs - SAMPLE_LOOKBACK_MS);
    state.volumes = trimBefore(state.volumes, nowMs - VOLUME_WINDOW_MS);
    this.intervals.set(connectionId, state);
    return state;
  }

  /** Logs the basis choice once per (basis, reason) change, so a lasting read failure warns once. */
  private logBasis(
    ctx: ConnectionContext,
    basis: RegressionBasis,
    reason?: FallbackReason,
    error?: string,
  ): void {
    const key = basis === 'interval' ? 'interval' : `cumulative:${reason}`;
    if (this.basisLogged.get(ctx.connectionId) === key) return;
    this.basisLogged.set(ctx.connectionId, key);
    if (basis === 'interval') {
      this.logger.log(
        `latency regression for ${ctx.connectionName}: judging per-interval P99 from LATENCY HISTOGRAM`,
      );
      return;
    }
    const message = `latency regression for ${ctx.connectionName}: falling back to cumulative latencystats (${reason})`;
    if (reason === 'histogram read failed') this.logger.warn(`${message}: ${error}`);
    else this.logger.log(message);
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
    let readError: string | undefined;
    try {
      state = await this.advanceIntervals(ctx.connectionId, nowMs);
    } catch (err) {
      readError = err instanceof Error ? err.message : String(err);
    }

    // Interval mode only while histogram collection is live. If it stops (e.g. polling was
    // disabled), old points stay in the 24h window but the detector rejects them as stale, so
    // fall back to the fresh cumulative samples instead of judging nothing for up to 24h.
    const newestPoint = state?.points[state.points.length - 1];
    const intervalFresh =
      newestPoint !== undefined && newestPoint.capturedAt >= nowMs - STALE_SAMPLE_MS;
    const basis: RegressionBasis = state && intervalFresh ? 'interval' : 'cumulative';
    let reason: FallbackReason | undefined;
    if (basis === 'cumulative') {
      // A fresh newest snapshot means collection is alive, even when it yields no P99 points.
      if (readError !== undefined) reason = 'histogram read failed';
      else if (!state) reason = 'no histogram rows';
      else if (state.last.timestamp < nowMs - STALE_SAMPLE_MS) reason = 'histogram rows are stale';
      else if (state.points.length === 0 && state.volumes.length === 0) {
        reason = 'not enough histogram data yet';
      } else reason = 'too few calls per interval';
    }
    this.logBasis(ctx, basis, reason, readError);

    let samples: CommandP99Point[];
    let callsPerMin: Map<string, number>;
    if (state && basis === 'interval') {
      const versionOf = versionTimeline(stored); // built once per poll
      samples = state.points.map((p) => ({
        command: p.command,
        p99Us: p.p99Us,
        capturedAt: p.capturedAt,
        serverVersion: versionOf(p.capturedAt),
      }));
      callsPerMin = callsPerMinute(state.volumes, nowMs - VOLUME_WINDOW_MS, nowMs);
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
    const runbook = this.buildRunbook(finding, prefetchBatchMaxSize, ctx.connectionId);
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

  private buildRunbook(
    finding: RegressionFinding,
    prefetchBatchMaxSize: number | null,
    connectionId: string,
  ): string[] {
    const runbook: string[] = [firstRunbookStep(finding.basis, connectionId)];
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
