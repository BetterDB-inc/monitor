import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import {
  WebhookDispatcherService,
  type DispatchFilter,
} from '@app/webhooks/webhook-dispatcher.service';
import {
  WebhookEventType,
  type CveCriticalDetectedData,
  type IWebhookEventsProService,
  type KvCacheEvictionRiskData,
  type KvCacheHitRateLowData,
  type LatencyRegressionDetectedData,
  type ReplicationDivergenceData,
  type ReplicationRecoveredData,
  type MetricKind,
  type RetryAmplificationDetectedData,
  type ScalingReadinessLowData,
  type WebhookInstanceInfo,
} from '@betterdb/shared';
import { LicenseService } from '@proprietary/licenses';
import { ReplicaPairing } from './replica-pairing';

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
export class WebhookEventsProService implements OnModuleInit, IWebhookEventsProService {
  private readonly logger = new Logger(WebhookEventsProService.name);
  private readonly replicaPairing = new ReplicaPairing();
  private readonly stalls = new Map<string, ReplicaStall>();
  private readonly lagAlerts = new Set<string>();
  private readonly stallOpenings = new Map<string, number>();

  constructor(
    private readonly webhookDispatcher: WebhookDispatcherService,
    private readonly licenseService: LicenseService,
  ) {}

  async onModuleInit() {
    if (this.isEnabled()) {
      this.logger.log('Webhook Pro events service initialized - PRO tier events enabled');
    } else {
      this.logger.log(
        'Webhook Pro events service initialized - PRO tier events disabled (requires license)',
      );
    }
  }

  /**
   * Check if PRO events are enabled
   */
  isEnabled(): boolean {
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

    await this.webhookDispatcher.dispatchThresholdAlertPerWebhook(
      WebhookEventType.SLOWLOG_THRESHOLD,
      'slowlog_threshold',
      data.slowlogCount,
      'slowlogCount',
      true, // isAbove
      (threshold) => ({
        slowlogCount: data.slowlogCount,
        threshold,
        message: `Slowlog count (${data.slowlogCount}) exceeds threshold (${threshold})`,
        timestamp: data.timestamp,
        instance: data.instance,
      }),
      data.connectionId,
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
    connectionId: string;
  }): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.debug('Replication lag event skipped - requires PRO license');
      return;
    }

    await this.webhookDispatcher.dispatchThresholdAlertPerWebhook(
      WebhookEventType.REPLICATION_LAG,
      'replication_lag',
      data.lagSeconds,
      'replicationLagSeconds',
      true, // isAbove
      (threshold) => ({
        lagSeconds: data.lagSeconds,
        threshold,
        masterLinkStatus: data.masterLinkStatus,
        message: `Replication lag (${data.lagSeconds}s) exceeds threshold (${threshold}s)`,
        timestamp: data.timestamp,
        instance: data.instance,
      }),
      data.connectionId,
      this.lagAlertFilter(data.connectionId),
    );
    this.forgetLagAlerts(data.connectionId, (webhookId) =>
      this.webhookDispatcher.isThresholdAlertActive(
        'replication_lag',
        data.connectionId,
        webhookId,
      ),
    );
  }

  clearReplicationLag(connectionId: string): void {
    this.webhookDispatcher.clearThresholdAlertPerWebhook('replication_lag', connectionId);
    this.forgetLagAlerts(connectionId);
  }

  observeReplication(
    connectionId: string,
    replication: Record<string, string | undefined> | undefined,
    instance: WebhookInstanceInfo,
  ): void {
    if (!this.isEnabled()) {
      this.replicaPairing.forget(connectionId);
      return;
    }
    this.replicaPairing.observe(connectionId, replication, instance);
  }

  forgetReplication(connectionId: string): void {
    this.replicaPairing.forget(connectionId);
    this.stallOpenings.delete(connectionId);
    for (const key of this.stalls.keys()) {
      if (key.startsWith(`${connectionId}\0`)) this.stalls.delete(key);
    }
    this.forgetLagAlerts(connectionId);
  }

  endReplicationStall(connectionId: string, replica: string): void {
    this.stalls.delete(stallKey(connectionId, replica));
  }

  private forgetLagAlerts(
    replicaConnectionId: string,
    keep: (webhookId: string) => boolean = () => false,
  ): void {
    const prefix = `${replicaConnectionId}\0`;
    for (const key of this.lagAlerts) {
      if (key.startsWith(prefix) && !keep(key.slice(prefix.length))) {
        this.lagAlerts.delete(key);
      }
    }
  }

  private lagAlertFilter(replicaConnectionId: string): DispatchFilter {
    const openings = this.stallOpenings.get(replicaConnectionId) ?? 0;
    return {
      skip: (webhook) => {
        const pair = this.replicaPairing.primaryFor(replicaConnectionId);
        const stall = pair && this.stalls.get(stallKey(pair.primaryConnectionId, pair.replicaAddr));
        return (
          !!stall?.notAcking.has(webhook.id) &&
          webhook.events.includes(WebhookEventType.REPLICATION_DIVERGENCE)
        );
      },
      onDelivered: (webhookId) => {
        if ((this.stallOpenings.get(replicaConnectionId) ?? 0) !== openings) return;
        this.lagAlerts.add(stallKey(replicaConnectionId, webhookId));
      },
    };
  }

  private divergenceFilter(
    primaryConnectionId: string,
    replica: string,
    reason: ReplicationDivergenceData['reason'],
  ): DispatchFilter {
    const key = stallKey(primaryConnectionId, replica);
    const opened = !this.stalls.has(key);
    const stall = this.stalls.get(key) ?? {
      delivered: new Set<string>(),
      notAcking: new Set<string>(),
      covered: new Set<string>(),
    };
    this.stalls.set(key, stall);
    const replicaConnectionId = this.replicaPairing.replicaConnectionFor(
      primaryConnectionId,
      replica,
    );
    if (opened && reason === 'not_acking' && replicaConnectionId) {
      this.stallOpenings.set(
        replicaConnectionId,
        (this.stallOpenings.get(replicaConnectionId) ?? 0) + 1,
      );
    }
    const covered =
      opened && reason === 'not_acking' ? this.takeLagAlerts(primaryConnectionId, replica) : [];
    covered.forEach((webhookId) => stall.covered.add(webhookId));
    return {
      skip: covered.length
        ? (webhook) =>
            covered.includes(webhook.id) &&
            webhook.events.includes(WebhookEventType.REPLICATION_LAG)
        : undefined,
      onDelivered: (webhookId) => {
        stall.delivered.add(webhookId);
        if (reason === 'not_acking') stall.notAcking.add(webhookId);
      },
    };
  }

  private takeLagAlerts(primaryConnectionId: string, replica: string): string[] {
    const replicaConnectionId = this.replicaPairing.replicaConnectionFor(
      primaryConnectionId,
      replica,
    );
    if (!replicaConnectionId) return [];
    const prefix = `${replicaConnectionId}\0`;
    const taken = [...this.lagAlerts]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
    this.forgetLagAlerts(replicaConnectionId);
    return taken.filter((webhookId) =>
      this.webhookDispatcher.isThresholdAlertActive(
        'replication_lag',
        replicaConnectionId,
        webhookId,
      ),
    );
  }

  /**
   * Dispatch cluster failover event (PRO+)
   * Called when cluster state changes or slot failures detected
   */
  async dispatchClusterFailover(data: {
    clusterState: string;
    previousState?: string;
    /**
     * What tripped the detection. A clean failover leaves cluster_state
     * unchanged, so without this the message below reads "changed from ok to
     * ok" and tells an operator nothing.
     */
    reasons?: string[];
    /**
     * Which nodes moved and how. Empty for a state-only or slot-failure
     * trigger; a consumer paging on a clean failover needs it to know what
     * actually changed.
     */
    changedNodes?: Array<{ nodeId: string; reason: string; from: string; to: string }>;
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
        reasons: data.reasons,
        changedNodes: data.changedNodes,
        message: clusterFailoverMessage(data),
        timestamp: data.timestamp,
        instance: data.instance,
      },
      data.connectionId,
    );
  }

  /**
   * Dispatch cluster demoted-writes event (PRO+)
   * Called when a node the cluster has already demoted keeps answering as a
   * master and keeps taking traffic. Distinct from cluster.failover: the
   * failover is over, and this is the window in which writes are accepted and
   * then discarded when the client's slot cache catches up.
   */
  async dispatchClusterDemotedWrites(data: {
    nodeId: string;
    nodeAddress: string;
    disagreementMs: number;
    demotedForMs: number;
    opsPerSec: number;
    writeCallsDelta?: number;
    severity: 'critical' | 'warning';
    message: string;
    timestamp: number;
    instance: { host: string; port: number };
    connectionId?: string;
  }): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.debug('Cluster demoted writes event skipped - requires PRO license');
      return;
    }

    await this.webhookDispatcher.dispatchEvent(
      WebhookEventType.CLUSTER_DEMOTED_WRITES,
      {
        nodeId: data.nodeId,
        nodeAddress: data.nodeAddress,
        disagreementMs: data.disagreementMs,
        demotedForMs: data.demotedForMs,
        opsPerSec: data.opsPerSec,
        writeCallsDelta: data.writeCallsDelta,
        severity: data.severity,
        message: data.message,
        timestamp: data.timestamp,
        instance: data.instance,
      },
      data.connectionId,
    );
  }

  async dispatchClusterBusCorruption(data: {
    crcMismatchTotal: number;
    crcMismatchDelta: number;
    knownNodes: number;
    timestamp: number;
    instance: { host: string; port: number };
    connectionId?: string;
  }): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.debug('Cluster bus corruption event skipped - requires PRO license');
      return;
    }

    await this.webhookDispatcher.dispatchEvent(
      WebhookEventType.CLUSTER_BUS_CORRUPTION,
      {
        crcMismatchTotal: data.crcMismatchTotal,
        crcMismatchDelta: data.crcMismatchDelta,
        knownNodes: data.knownNodes,
        message: `Cluster bus rejected ${data.crcMismatchDelta} corrupted message(s) via CRC check (total ${data.crcMismatchTotal})`,
        timestamp: data.timestamp,
        instance: data.instance,
      },
      data.connectionId,
    );
  }

  /**
   * Dispatch failover started event (PRO+)
   * Called when a node transitions from master to replica (demotion detected)
   */
  async dispatchFailoverStarted(data: {
    previousRole: string;
    newRole: string;
    timestamp: number;
    instance: { host: string; port: number };
    connectionId?: string;
  }): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.debug('Failover started event skipped - requires PRO license');
      return;
    }

    await this.webhookDispatcher.dispatchEvent(
      WebhookEventType.FAILOVER_STARTED,
      {
        previousRole: data.previousRole,
        newRole: data.newRole,
        message: `Failover started: node role changed from ${data.previousRole} to ${data.newRole}`,
        timestamp: data.timestamp,
        instance: data.instance,
      },
      data.connectionId,
    );
  }

  /**
   * Dispatch failover completed event (PRO+)
   * Called when a node transitions from replica to master (promotion detected)
   */
  async dispatchFailoverCompleted(data: {
    previousRole: string;
    newRole: string;
    timestamp: number;
    instance: { host: string; port: number };
    connectionId?: string;
  }): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.debug('Failover completed event skipped - requires PRO license');
      return;
    }

    await this.webhookDispatcher.dispatchEvent(
      WebhookEventType.FAILOVER_COMPLETED,
      {
        previousRole: data.previousRole,
        newRole: data.newRole,
        message: `Failover completed: node promoted from ${data.previousRole} to ${data.newRole}`,
        timestamp: data.timestamp,
        instance: data.instance,
      },
      data.connectionId,
    );
  }

  /**
   * Dispatch data loss detected event (PRO+)
   * Called when a primary restarts with an empty dataset (about to wipe
   * replicas via full resync) or a replica has been wiped by a full resync
   * from a (near-)empty primary. See valkey/valkey#579.
   */
  async dispatchDataLossDetected(data: {
    kind: 'primary_restarted_empty' | 'replica_wiped';
    previousKeys: number;
    currentKeys: number;
    previousReplid: string;
    newReplid: string;
    connectedSlaves: number;
    role: string;
    message: string;
    timestamp: number;
    instance: { host: string; port: number };
    connectionId?: string;
  }): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.debug('Data loss detected event skipped - requires PRO license');
      return;
    }

    await this.webhookDispatcher.dispatchEvent(
      WebhookEventType.DATA_LOSS_DETECTED,
      {
        kind: data.kind,
        previousKeys: data.previousKeys,
        currentKeys: data.currentKeys,
        previousReplid: data.previousReplid,
        newReplid: data.newReplid,
        connectedSlaves: data.connectedSlaves,
        role: data.role,
        message: data.message,
        timestamp: data.timestamp,
        instance: data.instance,
      },
      data.connectionId,
    );
  }

  /**
   * Dispatch latency regression detected event (PRO+)
   * Called when per-command P99 latency degrades after a server version
   * change (upgrade regression) or sustains above its rolling baseline
   * (sustained degradation). See valkey/valkey#3527.
   */
  async dispatchLatencyRegressionDetected(data: LatencyRegressionDetectedData): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.debug('Latency regression event skipped - requires PRO license');
      return;
    }

    await this.webhookDispatcher.dispatchEvent(
      WebhookEventType.LATENCY_REGRESSION_DETECTED,
      {
        kind: data.kind,
        previousVersion: data.previousVersion,
        currentVersion: data.currentVersion,
        commands: data.commands,
        topologyRefreshCorrelated: data.topologyRefreshCorrelated,
        prefetchBatchMaxSize: data.prefetchBatchMaxSize ?? null,
        runbook: data.runbook,
        message: data.message,
        timestamp: data.timestamp,
        instance: data.instance,
      },
      data.connectionId,
    );
  }

  async dispatchRetryAmplificationDetected(data: RetryAmplificationDetectedData): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.debug('Retry amplification event skipped - requires PRO license');
      return;
    }

    await this.webhookDispatcher.dispatchEvent(
      WebhookEventType.RETRY_AMPLIFICATION_DETECTED,
      {
        metricType: 'retry_amplification',
        value: Math.round(data.loadRatio * 100) / 100,
        baseline: 1,
        level: data.level,
        trigger: data.trigger,
        windows: data.windows,
        loadRatio: data.loadRatio,
        pattern: data.pattern,
        correlation: data.correlation,
        topContributors: data.topContributors,
        message: data.message,
        timestamp: data.timestamp,
        instance: data.instance,
      },
      data.connectionId,
    );
  }

  async dispatchReplicationDivergence(data: ReplicationDivergenceData): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.debug('Replication divergence event skipped - requires PRO license');
      return;
    }

    const { connectionId, ...payload } = data;
    await this.webhookDispatcher.dispatchEvent(
      WebhookEventType.REPLICATION_DIVERGENCE,
      payload,
      connectionId,
      connectionId ? this.divergenceFilter(connectionId, data.replica, data.reason) : undefined,
    );
  }

  async dispatchReplicationRecovered(data: ReplicationRecoveredData): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.debug('Replication recovered event skipped - requires PRO license');
      return;
    }

    const { connectionId, ...payload } = data;
    const stall = connectionId ? this.stalls.get(stallKey(connectionId, data.replica)) : undefined;
    await this.webhookDispatcher.dispatchEvent(
      WebhookEventType.REPLICATION_RECOVERED,
      payload,
      connectionId,
      stall?.covered.size
        ? {
            skip: (webhook) =>
              stall.covered.has(webhook.id) &&
              !stall.delivered.has(webhook.id) &&
              webhook.events.includes(WebhookEventType.REPLICATION_LAG) &&
              webhook.events.includes(WebhookEventType.REPLICATION_DIVERGENCE),
          }
        : undefined,
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
      data.connectionId,
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
      `latency_spike:${data.connectionId ?? 'default'}`,
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
      data.connectionId,
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
      `connection_spike:${data.connectionId ?? 'default'}`,
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
      data.connectionId,
    );
  }

  /**
   * Dispatch metric forecast limit event (PRO+)
   * Called when projected time-to-limit drops below configured threshold
   */
  async dispatchMetricForecastLimit(data: {
    event: WebhookEventType;
    metricKind: MetricKind;
    currentValue: number;
    ceiling: number | null;
    timeToLimitMs: number;
    threshold: number;
    growthRate: number;
    timestamp: number;
    instance?: { host: string; port: number };
    connectionId: string;
  }): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.log('Metric forecast limit event skipped - requires PRO license');
      return;
    }

    const ceilingLabel = data.ceiling != null ? data.ceiling : 'unknown';
    const timeHours = (data.timeToLimitMs / 3_600_000).toFixed(1);

    await this.webhookDispatcher.dispatchThresholdAlert(
      data.event,
      `metric_forecast_limit:${data.connectionId}:${data.metricKind}`,
      data.timeToLimitMs,
      data.threshold,
      false, // isAbove = false: fire when timeToLimit drops BELOW threshold
      {
        metricKind: data.metricKind,
        currentValue: data.currentValue,
        ceiling: data.ceiling,
        timeToLimitMs: data.timeToLimitMs,
        growthRate: data.growthRate,
        message: `${data.metricKind} projected to reach ceiling (${ceilingLabel}) in ~${timeHours}h at current growth rate`,
        timestamp: data.timestamp,
        instance: data.instance,
      },
      data.connectionId,
    );
  }

  async dispatchScalingReadinessLow(data: ScalingReadinessLowData): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.log('Scaling readiness low event skipped - requires PRO license');
      return;
    }
    await this.webhookDispatcher.dispatchThresholdAlert(
      WebhookEventType.SCALING_READINESS_LOW,
      `scaling_readiness_low:${data.connectionId}`,
      data.score,
      data.threshold,
      false,
      {
        score: data.score,
        threshold: data.threshold,
        band: data.band,
        bindingDimension: data.bindingDimension,
        summary: data.summary,
        dimensions: data.dimensions,
        message: `Scaling readiness ${data.score} dropped to ${data.threshold} or below: ${data.summary}`,
        timestamp: data.timestamp,
        instance: data.instance,
      },
      data.connectionId,
    );
  }

  async dispatchKvCacheHitRateLow(data: KvCacheHitRateLowData): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.log('KV cache hit rate low event skipped - requires PRO license');
      return;
    }
    await this.webhookDispatcher.dispatchThresholdAlert(
      WebhookEventType.KV_CACHE_HIT_RATE_LOW,
      `kv_cache_hit_rate_low:${data.engineId}:${data.model}`,
      data.hitRate,
      data.threshold,
      false,
      {
        ...data,
        message: `LMCache hit rate for ${data.model} on ${data.engineName} is ${(data.hitRate * 100).toFixed(1)}% (threshold ${(data.threshold * 100).toFixed(1)}%)`,
      },
      data.connectionId,
    );
  }

  async dispatchKvCacheEvictionRisk(data: KvCacheEvictionRiskData): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.log('KV cache eviction risk event skipped - requires PRO license');
      return;
    }
    await this.webhookDispatcher.dispatchThresholdAlert(
      WebhookEventType.KV_CACHE_EVICTION_RISK,
      `kv_cache_eviction_risk:${data.connectionId}:${data.reason}`,
      data.active ? 1 : 0,
      1,
      true,
      {
        ...data,
        message:
          data.reason === 'unevictable'
            ? `LMCache keys have no TTL under ${data.policy}; Valkey cannot evict them`
            : 'Valkey is evicting keys while LMCache holds most of its memory',
      },
      data.connectionId,
    );
  }

  /**
   * Dispatch inference SLA breach event (PRO+)
   * Called when a configured per-index p99 SLA is breached. Debounce + resolution
   * re-arm are owned by InferenceLatencyService, so this goes directly through
   * dispatchEvent and does not use dispatchThresholdAlert's own alert-state.
   */
  async dispatchInferenceSlaBreach(data: {
    indexName: string;
    currentP99Us: number;
    thresholdUs: number;
    windowMs: number;
    timestamp: number;
    instance: WebhookInstanceInfo;
    connectionId?: string;
  }): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.debug('Inference SLA breach event skipped - requires PRO license');
      return;
    }

    await this.webhookDispatcher.dispatchEvent(
      WebhookEventType.INFERENCE_SLA_BREACH,
      {
        indexName: data.indexName,
        currentP99Us: data.currentP99Us,
        thresholdUs: data.thresholdUs,
        windowMs: data.windowMs,
        message: `Inference SLA breach on ${data.indexName}: p99 ${data.currentP99Us}µs > threshold ${data.thresholdUs}µs`,
        timestamp: data.timestamp,
        instance: data.instance,
      },
      data.connectionId,
    );
  }

  /**
   * Dispatch CVE critical event (PRO+)
   * @returns true when delivered (or skipped); false when delivery failed.
   */
  async dispatchCveCriticalDetected(data: CveCriticalDetectedData): Promise<boolean> {
    if (!this.isEnabled()) {
      this.logger.debug('CVE critical detected event skipped - requires PRO license');
      return true;
    }

    const delivered = await this.webhookDispatcher.dispatchEvent(
      WebhookEventType.CVE_CRITICAL_DETECTED,
      {
        criticalCount: data.criticalCount,
        kevCount: data.kevCount,
        fingerprint: data.fingerprint,
        datasetVersion: data.datasetVersion,
        topFindings: data.topFindings,
        drift: data.drift,
        partial: data.partial,
        message: data.message,
        timestamp: data.timestamp,
        instance: data.instance,
      },
      data.connectionId,
    );
    return delivered !== false;
  }
}

const TOPOLOGY_REASON_LABELS: Record<string, string> = {
  role_change: 'a node changed role',
  primary_change: "a shard's primary changed",
  epoch_bump: 'a configEpoch advanced',
  cluster_state: 'cluster state changed',
  slot_failures: 'slots entered a failed state',
};

export function clusterFailoverMessage(data: {
  clusterState: string;
  previousState?: string;
  reasons?: string[];
}): string {
  // A caller that declares its reasons is trusted over the raw states:
  // cluster_state is only recorded on ok -> fail, so a topology failover seen
  // on the same poll as a fail -> ok recovery would otherwise be reported as
  // that recovery and bury the real signal.
  //
  // A caller that declares none keeps the original state-difference wording.
  // anomaly.service dispatches without reasons and is the only path reporting
  // fail -> ok recovery, so gating on reasons unconditionally would strip the
  // from/to wording from every recovery alert.
  const reasons = data.reasons ?? [];
  const stateWasTheSignal =
    reasons.length > 0
      ? reasons.includes('cluster_state')
      : data.previousState !== undefined && data.previousState !== data.clusterState;

  const labels = reasons
    .filter((reason) => {
      return reason !== 'cluster_state';
    })
    .map((reason) => {
      return TOPOLOGY_REASON_LABELS[reason] ?? reason;
    })
    .join(', ');

  if (stateWasTheSignal) {
    const transition = `Cluster state changed from ${data.previousState ?? 'unknown'} to ${data.clusterState}`;
    // An outage trips the CLUSTER INFO edge and churns the topology on the same
    // poll. Reporting only the transition drops which nodes actually moved.
    if (labels === '') {
      return transition;
    }
    return `${transition} (also: ${labels})`;
  }

  // cluster_state held steady, so the topology is what moved. Naming the signal
  // is the only thing that tells an operator what happened.
  if (labels === '') {
    return `Cluster failover detected (state ${data.clusterState})`;
  }
  return `Cluster failover detected while state stayed ${data.clusterState}: ${labels}`;
}

interface ReplicaStall {
  delivered: Set<string>;
  notAcking: Set<string>;
  covered: Set<string>;
}

function stallKey(primaryConnectionId: string, replica: string): string {
  return `${primaryConnectionId}\0${replica}`;
}
