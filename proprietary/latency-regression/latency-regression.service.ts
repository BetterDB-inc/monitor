import { randomUUID } from 'crypto';
import { Injectable, Logger, OnModuleInit, Inject, Optional } from '@nestjs/common';
import { StoragePort } from '@app/common/interfaces/storage-port.interface';
import {
  MultiConnectionPoller,
  ConnectionContext,
} from '@app/common/services/multi-connection-poller';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import { WEBHOOK_EVENTS_PRO_SERVICE, IWebhookEventsProService } from '@betterdb/shared';
import { MetricType, AnomalyType } from '../anomaly-detection/types';
import { RegressionDetector, parseMajorVersion, STALE_SAMPLE_MS } from './regression-detector';
import { ClusterRefreshPoint, DetectorInput, RegressionFinding } from './types';

const POLL_INTERVAL_MS = 60_000;
/** How much latencystats history the detector needs (sustained baseline window). */
const SAMPLE_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** Window used to derive per-command call volume from commandstats deltas. */
const VOLUME_WINDOW_MS = 10 * 60 * 1000;
/** Window of cluster|slots / cluster|shards deltas for topology correlation. */
const CLUSTER_DELTA_WINDOW_MS = 60 * 60 * 1000;
const CLUSTER_REFRESH_COMMANDS = ['cluster|slots', 'cluster|shards'];

/**
 * Pro guard for per-command P99 latency regressions (valkey/valkey#3527).
 * Feeds stored INFO latencystats samples into a pure per-connection
 * RegressionDetector and turns findings into anomaly events + webhooks.
 */
@Injectable()
export class LatencyRegressionService extends MultiConnectionPoller implements OnModuleInit {
  protected readonly logger = new Logger(LatencyRegressionService.name);

  private detectors = new Map<string, RegressionDetector>();

  constructor(
    connectionRegistry: ConnectionRegistry,
    @Inject('STORAGE_CLIENT')
    private readonly storage: StoragePort,
    @Optional()
    @Inject(WEBHOOK_EVENTS_PRO_SERVICE)
    private readonly webhookEventsProService?: IWebhookEventsProService,
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
  }

  protected async pollConnection(ctx: ConnectionContext): Promise<void> {
    const nowMs = Date.now();

    const stored = await this.storage.getLatencyStatsHistory({
      connectionId: ctx.connectionId,
      startTime: nowMs - SAMPLE_LOOKBACK_MS,
      endTime: nowMs,
    });
    if (stored.length === 0) return;

    const samples = stored.map((s) => ({
      command: s.command,
      p99Us: s.p99Us,
      serverVersion: s.serverVersion,
      capturedAt: s.capturedAt,
    }));

    // Volume gating input: commandstats call deltas for commands seen recently.
    const recentCommands = new Set<string>();
    for (const s of samples) {
      if (s.capturedAt >= nowMs - STALE_SAMPLE_MS) recentCommands.add(s.command);
    }
    const callsPerMin = new Map<string, number>();
    for (const command of recentCommands) {
      const history = await this.storage.getCommandStatsHistory({
        connectionId: ctx.connectionId,
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
      detector = new RegressionDetector();
      this.detectors.set(ctx.connectionId, detector);
    }

    const input: DetectorInput = { nowMs, samples, callsPerMin, clusterRefreshDeltas };
    const findings = detector.evaluate(input);

    for (const finding of findings) {
      await this.handleFinding(finding, ctx);
    }
  }

  private async handleFinding(finding: RegressionFinding, ctx: ConnectionContext): Promise<void> {
    this.logger.warn(`Latency regression on ${ctx.connectionName}: ${finding.message}`);

    const prefetchBatchMaxSize = await this.getPrefetchBatchMaxSize(ctx, finding.currentVersion);
    const runbook = this.buildRunbook(finding, prefetchBatchMaxSize);
    const worst = finding.commands[0];

    try {
      await this.storage.saveAnomalyEvent(
        {
          // Storage adapters (postgres) require UUID event ids
          id: randomUUID(),
          timestamp: finding.timestamp,
          metricType: MetricType.COMMAND_P99,
          anomalyType: AnomalyType.SPIKE,
          severity: finding.severity,
          value: worst.currentP99Us,
          baseline: worst.baselineP99Us,
          zScore: 0,
          stdDev: 0,
          threshold: worst.degradationFactor,
          message: finding.message,
          // Instance metadata, consistent with other anomaly producers.
          sourceHost: ctx.host,
          sourcePort: ctx.port,
          relatedMetrics: finding.topologyRefreshCorrelated
            ? [MetricType.CLUSTER_STATE, MetricType.COMMAND_P99]
            : undefined,
          resolved: false,
          connectionId: ctx.connectionId,
        },
        ctx.connectionId,
      );
    } catch (err) {
      this.logger.error(
        `Failed to persist latency regression event: ${err instanceof Error ? err.message : err}`,
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
