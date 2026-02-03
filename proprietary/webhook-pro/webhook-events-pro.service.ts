import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { WebhookDispatcherService } from '@app/webhooks/webhook-dispatcher.service';
import { WebhookEventType } from '@betterdb/shared';
import { LicenseService } from '@proprietary/license';

/**
 * Webhook Events Pro Service - Generates PRO tier webhook events
 *
 * This service is in the proprietary folder to ensure OCV compliance.
 * PRO tier events are only generated when licensed, while the webhook
 * infrastructure itself (MIT) remains completely open and unrestricted.
 *
 * PRO Events Generated:
 * - slowlog.threshold - Slow query threshold exceeded
 * - replication.lag - Replication lag detected
 * - cluster.failover - Cluster failover occurred
 * - anomaly.detected - Anomaly detection alert
 * - latency.spike - Latency spike detected
 * - connection.spike - Connection spike detected
 */
@Injectable()
export class WebhookEventsProService implements OnModuleInit {
  private readonly logger = new Logger(WebhookEventsProService.name);

  constructor(
    private readonly webhookDispatcher: WebhookDispatcherService,
    private readonly licenseService: LicenseService,
  ) {}

  async onModuleInit() {
    if (this.isEnabled()) {
      this.logger.log('Webhook Pro events service initialized - PRO tier events enabled');
    } else {
      this.logger.log('Webhook Pro events service initialized - PRO tier events disabled (requires license)');
    }
  }

  /**
   * Check if PRO events are enabled
   */
  private isEnabled(): boolean {
    const tier = this.licenseService.getLicenseTier();
    return tier === 'pro' || tier === 'enterprise';
  }

  /**
   * Dispatch slowlog threshold event (PRO+)
   * Called when slowlog count exceeds threshold
   */
  async dispatchSlowlogThreshold(data: {
    slowlogCount: number;
    threshold: number;
    timestamp: number;
    instance: { host: string; port: number };
    connectionId?: string;
  }): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.debug('Slowlog threshold event skipped - requires PRO license');
      return;
    }

    await this.webhookDispatcher.dispatchThresholdAlert(
      WebhookEventType.SLOWLOG_THRESHOLD,
      'slowlog_threshold',
      data.slowlogCount,
      data.threshold,
      true, // isAbove
      {
        slowlogCount: data.slowlogCount,
        threshold: data.threshold,
        message: `Slowlog count (${data.slowlogCount}) exceeds threshold (${data.threshold})`,
        timestamp: data.timestamp,
        instance: data.instance,
      },
      data.connectionId
    );
  }

  /**
   * Dispatch replication lag event (PRO+)
   * Called when replication lag exceeds acceptable threshold
   */
  async dispatchReplicationLag(data: {
    lagSeconds: number;
    threshold: number;
    masterLinkStatus: string;
    timestamp: number;
    instance: { host: string; port: number };
    connectionId?: string;
  }): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.debug('Replication lag event skipped - requires PRO license');
      return;
    }

    await this.webhookDispatcher.dispatchThresholdAlert(
      WebhookEventType.REPLICATION_LAG,
      'replication_lag',
      data.lagSeconds,
      data.threshold,
      true, // isAbove
      {
        lagSeconds: data.lagSeconds,
        threshold: data.threshold,
        masterLinkStatus: data.masterLinkStatus,
        message: `Replication lag (${data.lagSeconds}s) exceeds threshold (${data.threshold}s)`,
        timestamp: data.timestamp,
        instance: data.instance,
      },
      data.connectionId
    );
  }

  /**
   * Dispatch cluster failover event (PRO+)
   * Called when cluster state changes or slot failures detected
   */
  async dispatchClusterFailover(data: {
    clusterState: string;
    previousState?: string;
    slotsAssigned: number;
    slotsFailed: number;
    knownNodes: number;
    timestamp: number;
    instance: { host: string; port: number };
    connectionId?: string;
  }): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.debug('Cluster failover event skipped - requires PRO license');
      return;
    }

    await this.webhookDispatcher.dispatchEvent(
      WebhookEventType.CLUSTER_FAILOVER,
      {
        clusterState: data.clusterState,
        previousState: data.previousState,
        slotsAssigned: data.slotsAssigned,
        slotsFailed: data.slotsFailed,
        knownNodes: data.knownNodes,
        message: `Cluster state changed from ${data.previousState || 'unknown'} to ${data.clusterState}`,
        timestamp: data.timestamp,
        instance: data.instance,
      },
      data.connectionId
    );
  }

  /**
   * Dispatch anomaly detected event (PRO+)
   * Called by anomaly detection service when anomaly found
   */
  async dispatchAnomalyDetected(data: {
    anomalyId: string;
    metricType: string;
    severity: string;
    value: number;
    baseline: number;
    threshold: number;
    message: string;
    timestamp: number;
    instance: { host: string; port: number };
    connectionId?: string;
  }): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.debug('Anomaly detected event skipped - requires PRO license');
      return;
    }

    await this.webhookDispatcher.dispatchEvent(
      WebhookEventType.ANOMALY_DETECTED,
      {
        anomalyId: data.anomalyId,
        metricType: data.metricType,
        severity: data.severity,
        value: data.value,
        baseline: data.baseline,
        threshold: data.threshold,
        message: data.message,
        timestamp: data.timestamp,
        instance: data.instance,
      },
      data.connectionId
    );
  }

  /**
   * Dispatch latency spike event (PRO+)
   * Called when command latency spikes above baseline
   */
  async dispatchLatencySpike(data: {
    currentLatency: number;
    baseline: number;
    threshold: number;
    timestamp: number;
    instance: { host: string; port: number };
    connectionId?: string;
  }): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.debug('Latency spike event skipped - requires PRO license');
      return;
    }

    await this.webhookDispatcher.dispatchThresholdAlert(
      WebhookEventType.LATENCY_SPIKE,
      'latency_spike',
      data.currentLatency,
      data.threshold,
      true, // isAbove
      {
        currentLatency: data.currentLatency,
        baseline: data.baseline,
        threshold: data.threshold,
        message: `Latency spike detected: ${data.currentLatency}ms (baseline: ${data.baseline}ms)`,
        timestamp: data.timestamp,
        instance: data.instance,
      },
      data.connectionId
    );
  }

  /**
   * Dispatch connection spike event (PRO+)
   * Called when connection count spikes above baseline
   */
  async dispatchConnectionSpike(data: {
    currentConnections: number;
    baseline: number;
    threshold: number;
    timestamp: number;
    instance: { host: string; port: number };
    connectionId?: string;
  }): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.debug('Connection spike event skipped - requires PRO license');
      return;
    }

    await this.webhookDispatcher.dispatchThresholdAlert(
      WebhookEventType.CONNECTION_SPIKE,
      'connection_spike',
      data.currentConnections,
      data.threshold,
      true, // isAbove
      {
        currentConnections: data.currentConnections,
        baseline: data.baseline,
        threshold: data.threshold,
        message: `Connection spike detected: ${data.currentConnections} (baseline: ${data.baseline})`,
        timestamp: data.timestamp,
        instance: data.instance,
      },
      data.connectionId
    );
  }
}
