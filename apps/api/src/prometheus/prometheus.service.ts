import { Injectable, OnModuleInit, Inject, Logger, Optional, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Registry, Gauge, Counter, Histogram, collectDefaultMetrics } from 'prom-client';
import {
  WebhookEventType,
  IWebhookEventsProService,
  IWebhookEventsEnterpriseService,
  WEBHOOK_EVENTS_PRO_SERVICE,
  WEBHOOK_EVENTS_ENTERPRISE_SERVICE,
} from '@betterdb/shared';
import { StoragePort } from '../common/interfaces/storage-port.interface';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';
import { SlowLogAnalyticsService } from '../slowlog-analytics/slowlog-analytics.service';
import { CommandLogAnalyticsService } from '../commandlog-analytics/commandlog-analytics.service';
import { HealthService } from '../health/health.service';
import { DatabasePort } from '../common/interfaces/database-port.interface';
import { MultiConnectionPoller, ConnectionContext } from '../common/services/multi-connection-poller';

// Per-connection state for tracking previous values and stale labels
interface ConnectionMetricState {
  previousClusterState: string | null;
  previousSlotsFail: number;
  currentKeyspaceDbLabels: Set<string>;
  currentClusterSlotLabels: Set<string>;
  // Storage-based metric labels (per-connection)
  currentAclReasonLabels: Set<string>;
  currentAclUserLabels: Set<string>;
  currentClientNameLabels: Set<string>;
  currentClientUserLabels: Set<string>;
  currentSlowlogPatternLabels: Set<string>;
  currentCommandlogRequestPatternLabels: Set<string>;
  currentCommandlogReplyPatternLabels: Set<string>;
  // Anomaly detection labels (per-connection)
  currentAnomalyMetricLabels: Set<string>;
  currentCorrelatedPatternLabels: Set<string>;
}

@Injectable()
export class PrometheusService extends MultiConnectionPoller implements OnModuleInit {
  protected readonly logger = new Logger(PrometheusService.name);
  private registry: Registry;
  private readonly pollIntervalMs: number;

  // Per-connection state tracking
  private perConnectionState = new Map<string, ConnectionMetricState>();

  // ACL Audit Metrics
  private aclDeniedTotal: Gauge;
  private aclDeniedByReason: Gauge;
  private aclDeniedByUser: Gauge;

  // Client Analytics Metrics
  private clientConnectionsCurrent: Gauge;
  private clientConnectionsByName: Gauge;
  private clientConnectionsByUser: Gauge;
  private clientConnectionsPeak: Gauge;

  // Slowlog Pattern Metrics
  private slowlogPatternCount: Gauge;
  private slowlogPatternDuration: Gauge;
  private slowlogPatternPercentage: Gauge;

  // COMMANDLOG Metrics (Valkey-specific)
  private commandlogLargeRequestCount: Gauge;
  private commandlogLargeReplyCount: Gauge;
  private commandlogLargeRequestByPattern: Gauge;
  private commandlogLargeReplyByPattern: Gauge;

  // Standard INFO Metrics - Server
  private uptimeInSeconds: Gauge;
  private instanceInfo: Gauge;

  // Standard INFO Metrics - Clients
  private connectedClients: Gauge;
  private blockedClients: Gauge;
  private trackingClients: Gauge;

  // Standard INFO Metrics - Memory
  private memoryUsedBytes: Gauge;
  private memoryUsedRssBytes: Gauge;
  private memoryUsedPeakBytes: Gauge;
  private memoryMaxBytes: Gauge;
  private memoryFragmentationRatio: Gauge;
  private memoryFragmentationBytes: Gauge;

  // Standard INFO Metrics - Stats
  private connectionsReceivedTotal: Gauge;
  private commandsProcessedTotal: Gauge;
  private instantaneousOpsPerSec: Gauge;
  private instantaneousInputKbps: Gauge;
  private instantaneousOutputKbps: Gauge;
  private keyspaceHitsTotal: Gauge;
  private keyspaceMissesTotal: Gauge;
  private evictedKeysTotal: Gauge;
  private expiredKeysTotal: Gauge;
  private pubsubChannels: Gauge;
  private pubsubPatterns: Gauge;

  // Standard INFO Metrics - Replication
  private connectedSlaves: Gauge;
  private replicationOffset: Gauge;
  private masterLinkUp: Gauge;
  private masterLastIoSecondsAgo: Gauge;

  // Keyspace Metrics (per db)
  private dbKeys: Gauge;
  private dbKeysExpiring: Gauge;
  private dbAvgTtlSeconds: Gauge;

  // Cluster Metrics
  private clusterEnabled: Gauge;
  private clusterKnownNodes: Gauge;
  private clusterSize: Gauge;
  private clusterSlotsAssigned: Gauge;
  private clusterSlotsOk: Gauge;
  private clusterSlotsFail: Gauge;
  private clusterSlotsPfail: Gauge;

  // Cluster Slot Metrics (Valkey 8.0+ specific)
  private clusterSlotKeys: Gauge;
  private clusterSlotExpires: Gauge;
  private clusterSlotReadsTotal: Gauge;
  private clusterSlotWritesTotal: Gauge;

  // Slowlog Raw Metrics
  private slowlogLength: Gauge;
  private slowlogLastId: Gauge;

  // Poll Counter Metric
  private pollsTotal: Counter;

  // Poll Duration Metric
  private pollDuration: Histogram;

  // Anomaly Detection Metrics
  private anomalyEventsTotal: Counter;
  private anomalyEventsCurrent: Gauge;
  private anomalyBySeverity: Gauge;
  private anomalyByMetric: Gauge;
  private correlatedGroupsTotal: Counter;
  private correlatedGroupsBySeverity: Gauge;
  private correlatedGroupsByPattern: Gauge;
  private anomalyDetectionBufferReady: Gauge;
  private anomalyDetectionBufferMean: Gauge;
  private anomalyDetectionBufferStdDev: Gauge;

  constructor(
    @Inject('STORAGE_CLIENT') private storage: StoragePort,
    connectionRegistry: ConnectionRegistry,
    private readonly configService: ConfigService,
    private readonly slowLogAnalytics: SlowLogAnalyticsService,
    private readonly commandLogAnalytics: CommandLogAnalyticsService,
    @Inject(forwardRef(() => HealthService)) private readonly healthService: HealthService,
    @Optional() private readonly webhookDispatcher?: WebhookDispatcherService,
    @Optional() @Inject(WEBHOOK_EVENTS_PRO_SERVICE) private readonly webhookEventsProService?: IWebhookEventsProService,
    @Optional() @Inject(WEBHOOK_EVENTS_ENTERPRISE_SERVICE) private readonly webhookEventsEnterpriseService?: IWebhookEventsEnterpriseService,
  ) {
    super(connectionRegistry);
    this.pollIntervalMs = this.configService.get<number>('PROMETHEUS_POLL_INTERVAL_MS', 5000);
    this.registry = new Registry();
    this.initializeMetrics();
  }

  protected getIntervalMs(): number {
    return this.pollIntervalMs;
  }

  protected async pollConnection(ctx: ConnectionContext): Promise<void> {
    try {
      // Update INFO-based metrics for this connection
      await this.updateMetricsForConnection(ctx.connectionId);

      // Update storage-based metrics for this connection
      await this.updateStorageBasedMetricsForConnection(ctx.connectionId);

      // Trigger health check on successful metrics update - may fire instance.up webhook if recovered
      await this.healthService.getHealth(ctx.connectionId).catch(() => {});
    } catch (error) {
      // Trigger health check on failure - may fire instance.down webhook
      await this.healthService.getHealth(ctx.connectionId).catch(() => {});
      throw error; // Re-throw so base class logs the error
    }
  }

  protected onConnectionRemoved(connectionId: string): void {
    this.cleanupConnectionMetrics(connectionId);
    this.logger.debug(`Cleaned up metrics state for removed connection: ${connectionId}`);
  }

  /**
   * Get a human-readable connection label (host:port format)
   */
  private getConnectionLabel(connectionId: string): string {
    try {
      const config = this.connectionRegistry.getConfig(connectionId);
      if (config) {
        return `${config.host}:${config.port}`;
      }
    } catch {
      // Fallback to connectionId
    }
    return connectionId;
  }

  /**
   * Get or create per-connection metric state
   */
  private getConnectionState(connectionId: string): ConnectionMetricState {
    if (!this.perConnectionState.has(connectionId)) {
      this.perConnectionState.set(connectionId, {
        previousClusterState: null,
        previousSlotsFail: 0,
        currentKeyspaceDbLabels: new Set(),
        currentClusterSlotLabels: new Set(),
        // Storage-based metric labels
        currentAclReasonLabels: new Set(),
        currentAclUserLabels: new Set(),
        currentClientNameLabels: new Set(),
        currentClientUserLabels: new Set(),
        currentSlowlogPatternLabels: new Set(),
        currentCommandlogRequestPatternLabels: new Set(),
        currentCommandlogReplyPatternLabels: new Set(),
        // Anomaly detection labels
        currentAnomalyMetricLabels: new Set(),
        currentCorrelatedPatternLabels: new Set(),
      });
    }
    return this.perConnectionState.get(connectionId)!;
  }

  async onModuleInit(): Promise<void> {
    collectDefaultMetrics({ register: this.registry, prefix: 'betterdb_' });
    this.logger.log(`Starting Prometheus metrics polling (interval: ${this.pollIntervalMs}ms)`);
    this.start();
  }

  /**
   * Create a Gauge with connection label always included
   */
  private createGauge(name: string, help: string, additionalLabels?: string[]): Gauge {
    return new Gauge({
      name: `betterdb_${name}`,
      help,
      labelNames: ['connection', ...(additionalLabels || [])],
      registers: [this.registry],
    });
  }

  private initializeMetrics(): void {
    // ACL Audit (storage-based, per-connection)
    this.aclDeniedTotal = this.createGauge('acl_denied', 'Total ACL denied events captured');
    this.aclDeniedByReason = this.createGauge('acl_denied_by_reason', 'ACL denied events by reason', ['reason']);
    this.aclDeniedByUser = this.createGauge('acl_denied_by_user', 'ACL denied events by username', ['username']);

    // Client Analytics (storage-based, per-connection)
    this.clientConnectionsCurrent = this.createGauge('client_connections_current', 'Current number of client connections');
    this.clientConnectionsByName = this.createGauge('client_connections_by_name', 'Current connections by client name', ['client_name']);
    this.clientConnectionsByUser = this.createGauge('client_connections_by_user', 'Current connections by ACL user', ['user']);
    this.clientConnectionsPeak = this.createGauge('client_connections_peak', 'Peak connections in retention period');

    // Slowlog Patterns (storage-based, per-connection)
    this.slowlogPatternCount = this.createGauge('slowlog_pattern_count', 'Number of slow queries per pattern', ['pattern']);
    this.slowlogPatternDuration = this.createGauge('slowlog_pattern_avg_duration_us', 'Average duration in microseconds per pattern', ['pattern']);
    this.slowlogPatternPercentage = this.createGauge('slowlog_pattern_percentage', 'Percentage of slow queries per pattern', ['pattern']);

    // COMMANDLOG (Valkey 8.1+) - storage-based, per-connection
    this.commandlogLargeRequestCount = this.createGauge('commandlog_large_request', 'Total large request entries');
    this.commandlogLargeReplyCount = this.createGauge('commandlog_large_reply', 'Total large reply entries');
    this.commandlogLargeRequestByPattern = this.createGauge('commandlog_large_request_by_pattern', 'Large request count by command pattern', ['pattern']);
    this.commandlogLargeReplyByPattern = this.createGauge('commandlog_large_reply_by_pattern', 'Large reply count by command pattern', ['pattern']);

    // Standard INFO - Server (per connection)
    this.uptimeInSeconds = this.createGauge('uptime_in_seconds', 'Server uptime in seconds');
    this.instanceInfo = this.createGauge('instance_info', 'Instance information (always 1)', ['version', 'role', 'os']);

    // Standard INFO - Clients (per connection)
    this.connectedClients = this.createGauge('connected_clients', 'Number of client connections');
    this.blockedClients = this.createGauge('blocked_clients', 'Clients blocked on BLPOP, BRPOP, etc');
    this.trackingClients = this.createGauge('tracking_clients', 'Clients being tracked for client-side caching');

    // Standard INFO - Memory (per connection)
    this.memoryUsedBytes = this.createGauge('memory_used_bytes', 'Total allocated memory in bytes');
    this.memoryUsedRssBytes = this.createGauge('memory_used_rss_bytes', 'RSS memory usage in bytes');
    this.memoryUsedPeakBytes = this.createGauge('memory_used_peak_bytes', 'Peak memory usage in bytes');
    this.memoryMaxBytes = this.createGauge('memory_max_bytes', 'Maximum memory limit in bytes (0 if unlimited)');
    this.memoryFragmentationRatio = this.createGauge('memory_fragmentation_ratio', 'Memory fragmentation ratio');
    this.memoryFragmentationBytes = this.createGauge('memory_fragmentation_bytes', 'Memory fragmentation in bytes');

    // Standard INFO - Stats (per connection)
    this.connectionsReceivedTotal = this.createGauge('connections_received_total', 'Total connections received');
    this.commandsProcessedTotal = this.createGauge('commands_processed_total', 'Total commands processed');
    this.instantaneousOpsPerSec = this.createGauge('instantaneous_ops_per_sec', 'Current operations per second');
    this.instantaneousInputKbps = this.createGauge('instantaneous_input_kbps', 'Current input kilobytes per second');
    this.instantaneousOutputKbps = this.createGauge('instantaneous_output_kbps', 'Current output kilobytes per second');
    this.keyspaceHitsTotal = this.createGauge('keyspace_hits_total', 'Total keyspace hits');
    this.keyspaceMissesTotal = this.createGauge('keyspace_misses_total', 'Total keyspace misses');
    this.evictedKeysTotal = this.createGauge('evicted_keys_total', 'Total evicted keys');
    this.expiredKeysTotal = this.createGauge('expired_keys_total', 'Total expired keys');
    this.pubsubChannels = this.createGauge('pubsub_channels', 'Number of pub/sub channels');
    this.pubsubPatterns = this.createGauge('pubsub_patterns', 'Number of pub/sub patterns');

    // Standard INFO - Replication (per connection)
    this.connectedSlaves = this.createGauge('connected_slaves', 'Number of connected replicas');
    this.replicationOffset = this.createGauge('replication_offset', 'Replication offset');
    this.masterLinkUp = this.createGauge('master_link_up', '1 if link to master is up (replica only)');
    this.masterLastIoSecondsAgo = this.createGauge('master_last_io_seconds_ago', 'Seconds since last I/O with master (replica only)');

    // Keyspace Metrics (per connection, per database)
    this.dbKeys = this.createGauge('db_keys', 'Total keys in database', ['db']);
    this.dbKeysExpiring = this.createGauge('db_keys_expiring', 'Keys with expiration in database', ['db']);
    this.dbAvgTtlSeconds = this.createGauge('db_avg_ttl_seconds', 'Average TTL in seconds', ['db']);

    // Cluster Metrics (per connection)
    this.clusterEnabled = this.createGauge('cluster_enabled', '1 if cluster mode is enabled');
    this.clusterKnownNodes = this.createGauge('cluster_known_nodes', 'Number of known cluster nodes');
    this.clusterSize = this.createGauge('cluster_size', 'Number of master nodes in cluster');
    this.clusterSlotsAssigned = this.createGauge('cluster_slots_assigned', 'Number of assigned slots');
    this.clusterSlotsOk = this.createGauge('cluster_slots_ok', 'Number of slots in OK state');
    this.clusterSlotsFail = this.createGauge('cluster_slots_fail', 'Number of slots in FAIL state');
    this.clusterSlotsPfail = this.createGauge('cluster_slots_pfail', 'Number of slots in PFAIL state');

    // Cluster Slot Metrics (Valkey 8.0+) - per connection, per slot
    this.clusterSlotKeys = this.createGauge('cluster_slot_keys', 'Keys in cluster slot', ['slot']);
    this.clusterSlotExpires = this.createGauge('cluster_slot_expires', 'Expiring keys in cluster slot', ['slot']);
    this.clusterSlotReadsTotal = this.createGauge('cluster_slot_reads_total', 'Total reads for cluster slot', ['slot']);
    this.clusterSlotWritesTotal = this.createGauge('cluster_slot_writes_total', 'Total writes for cluster slot', ['slot']);

    // Slowlog Raw Metrics (per connection)
    this.slowlogLength = this.createGauge('slowlog_length', 'Current slowlog length');
    this.slowlogLastId = this.createGauge('slowlog_last_id', 'ID of last slowlog entry');

    // Poll Counter Metric (per connection)
    this.pollsTotal = new Counter({
      name: 'betterdb_polls_total',
      help: 'Total number of poll cycles completed',
      labelNames: ['connection'],
      registers: [this.registry],
    });

    // Poll Duration Metric (per connection)
    this.pollDuration = new Histogram({
      name: 'betterdb_poll_duration_seconds',
      help: 'Duration of poll cycles in seconds',
      labelNames: ['connection', 'service'],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });

    // Anomaly detection (per connection)
    this.anomalyEventsTotal = new Counter({
      name: 'betterdb_anomaly_events_total',
      help: 'Total anomaly events detected',
      labelNames: ['connection', 'severity', 'metric_type', 'anomaly_type'],
      registers: [this.registry],
    });
    this.correlatedGroupsTotal = new Counter({
      name: 'betterdb_correlated_groups_total',
      help: 'Total correlated anomaly groups',
      labelNames: ['connection', 'pattern', 'severity'],
      registers: [this.registry],
    });
    this.anomalyEventsCurrent = this.createGauge('anomaly_events_current', 'Unresolved anomalies', ['severity']);
    this.anomalyBySeverity = this.createGauge('anomaly_by_severity', 'Anomalies in last hour by severity', ['severity']);
    this.anomalyByMetric = this.createGauge('anomaly_by_metric', 'Anomalies in last hour by metric', ['metric_type']);
    this.correlatedGroupsBySeverity = this.createGauge('correlated_groups_by_severity', 'Groups in last hour by severity', ['severity']);
    this.correlatedGroupsByPattern = this.createGauge('correlated_groups_by_pattern', 'Groups in last hour by pattern', ['pattern']);
    this.anomalyDetectionBufferReady = this.createGauge('anomaly_buffer_ready', 'Buffer ready state (1=ready, 0=warming)', ['metric_type']);
    this.anomalyDetectionBufferMean = this.createGauge('anomaly_buffer_mean', 'Rolling mean for anomaly detection', ['metric_type']);
    this.anomalyDetectionBufferStdDev = this.createGauge('anomaly_buffer_stddev', 'Rolling stddev for anomaly detection', ['metric_type']);
  }

  /**
   * Update metrics for ALL registered connections (used by /metrics endpoint)
   */
  async updateMetrics(): Promise<void> {
    const connections = this.connectionRegistry.list();
    const connectedConnections = connections.filter(c => c.isConnected);

    // Update both INFO-based and storage-based metrics for all connections
    for (const conn of connectedConnections) {
      try {
        await this.updateMetricsForConnection(conn.id);
        await this.updateStorageBasedMetricsForConnection(conn.id);
      } catch (error) {
        this.logger.warn(
          `Failed to update metrics for connection ${conn.name}: ${error instanceof Error ? error.message : 'Unknown'}`
        );
      }
    }
  }

  /**
   * Update storage-based metrics for a specific connection
   */
  private async updateStorageBasedMetricsForConnection(connectionId: string): Promise<void> {
    const connLabel = this.getConnectionLabel(connectionId);
    const state = this.getConnectionState(connectionId);

    await this.updateAclMetrics(connectionId, connLabel, state);
    await this.updateClientMetrics(connectionId, connLabel, state);
    await this.updateSlowlogMetrics(connectionId, connLabel, state);
    await this.updateCommandlogMetrics(connectionId, connLabel, state);
  }

  /**
   * Update all INFO-based metrics for a specific connection
   */
  private async updateMetricsForConnection(connectionId: string): Promise<void> {
    const client = this.connectionRegistry.get(connectionId);
    if (!client) {
      this.logger.warn(`No client for connection ${connectionId}, skipping metrics`);
      return;
    }

    const connLabel = this.getConnectionLabel(connectionId);
    const state = this.getConnectionState(connectionId);
    const config = this.connectionRegistry.getConfig(connectionId);

    try {
      const info = await client.getInfoParsed();

      this.updateServerMetrics(info, connLabel);
      this.updateClientInfoMetrics(info, connLabel, connectionId, config);
      this.updateMemoryMetrics(info, connLabel, connectionId, config);
      this.updateStatsMetrics(info, connLabel);
      this.updateReplicationMetrics(info, connLabel, connectionId, config);
      this.updateKeyspaceMetricsFromInfo(info, connLabel, state);
      await this.updateClusterMetricsFromInfo(client, info, connLabel, connectionId, state, config);
      await this.updateSlowlogRawMetrics(connLabel, connectionId, config);
    } catch (error) {
      this.logger.error(`Failed to update INFO-based metrics for ${connLabel}`, error);
    }
  }

  private updateServerMetrics(info: Record<string, any>, connLabel: string): void {
    if (!info.server) return;

    const version = info.server.valkey_version || info.server.redis_version || 'unknown';
    const role = info.replication?.role || 'unknown';
    const os = info.server.os || 'unknown';

    this.uptimeInSeconds.labels(connLabel).set(parseInt(info.server.uptime_in_seconds) || 0);
    this.instanceInfo.labels(connLabel, version, role, os).set(1);
  }

  private updateClientInfoMetrics(
    info: Record<string, any>,
    connLabel: string,
    connectionId: string,
    config: { host: string; port: number } | null,
  ): void {
    if (!info.clients) return;

    const connectedClients = parseInt(info.clients.connected_clients) || 0;
    const maxClients = parseInt(info.clients.maxclients) || 10000;

    this.connectedClients.labels(connLabel).set(connectedClients);
    this.blockedClients.labels(connLabel).set(parseInt(info.clients.blocked_clients) || 0);
    if (info.clients.tracking_clients) {
      this.trackingClients.labels(connLabel).set(parseInt(info.clients.tracking_clients) || 0);
    }

    // Webhook dispatch for connection.critical
    if (this.webhookDispatcher && maxClients > 0) {
      const usedPercent = (connectedClients / maxClients) * 100;
      this.webhookDispatcher.dispatchThresholdAlertPerWebhook(
        WebhookEventType.CONNECTION_CRITICAL,
        'connection_critical',
        usedPercent,
        'connectionCriticalPercent',
        true,
        {
          currentConnections: connectedClients,
          maxConnections: maxClients,
          usedPercent: parseFloat(usedPercent.toFixed(2)),
          message: `Connection usage critical: ${usedPercent.toFixed(1)}% (${connectedClients} / ${maxClients})`,
        },
        connectionId
      ).catch(err => {
        this.logger.error('Failed to dispatch connection.critical webhook', err);
      });
    }
  }

  private updateMemoryMetrics(
    info: Record<string, any>,
    connLabel: string,
    connectionId: string,
    config: { host: string; port: number } | null,
  ): void {
    if (!info.memory) return;

    const memoryUsed = parseInt(info.memory.used_memory) || 0;
    const maxMemory = parseInt(info.memory.maxmemory) || 0;
    const maxmemoryPolicy = info.memory.maxmemory_policy || 'noeviction';

    this.memoryUsedBytes.labels(connLabel).set(memoryUsed);
    this.memoryUsedRssBytes.labels(connLabel).set(parseInt(info.memory.used_memory_rss) || 0);
    this.memoryUsedPeakBytes.labels(connLabel).set(parseInt(info.memory.used_memory_peak) || 0);
    this.memoryMaxBytes.labels(connLabel).set(maxMemory);
    this.memoryFragmentationRatio.labels(connLabel).set(parseFloat(info.memory.mem_fragmentation_ratio) || 0);
    this.memoryFragmentationBytes.labels(connLabel).set(parseInt(info.memory.mem_fragmentation_bytes) || 0);

    if (this.webhookDispatcher && maxMemory > 0) {
      const usedPercent = (memoryUsed / maxMemory) * 100;

      this.webhookDispatcher.dispatchThresholdAlertPerWebhook(
        WebhookEventType.MEMORY_CRITICAL,
        'memory_critical',
        usedPercent,
        'memoryCriticalPercent',
        true,
        {
          usedBytes: memoryUsed,
          maxBytes: maxMemory,
          usedPercent: parseFloat(usedPercent.toFixed(2)),
          usedMemoryHuman: this.formatBytes(memoryUsed),
          maxMemoryHuman: this.formatBytes(maxMemory),
          message: `Memory usage critical: ${usedPercent.toFixed(1)}% (${this.formatBytes(memoryUsed)} / ${this.formatBytes(maxMemory)})`,
        },
        connectionId
      ).catch(err => {
        this.logger.error('Failed to dispatch memory.critical webhook', err);
      });

      // Compliance alert for enterprise tier
      if (usedPercent > 80 && maxmemoryPolicy === 'noeviction' && this.webhookEventsEnterpriseService) {
        this.webhookEventsEnterpriseService.dispatchComplianceAlert({
          complianceType: 'data_retention',
          severity: 'high',
          memoryUsedPercent: usedPercent,
          maxmemoryPolicy,
          message: `Compliance alert: Memory at ${usedPercent.toFixed(1)}% with 'noeviction' policy may cause data loss and violate retention policies`,
          timestamp: Date.now(),
          instance: { host: config?.host || 'localhost', port: config?.port || 6379 },
          connectionId,
        }).catch(err => {
          this.logger.error('Failed to dispatch compliance.alert webhook', err);
        });
      }
    }
  }

  private updateStatsMetrics(info: Record<string, any>, connLabel: string): void {
    if (!info.stats) return;

    this.connectionsReceivedTotal.labels(connLabel).set(parseInt(info.stats.total_connections_received) || 0);
    this.commandsProcessedTotal.labels(connLabel).set(parseInt(info.stats.total_commands_processed) || 0);
    this.instantaneousOpsPerSec.labels(connLabel).set(parseInt(info.stats.instantaneous_ops_per_sec) || 0);
    this.instantaneousInputKbps.labels(connLabel).set(parseFloat(info.stats.instantaneous_input_kbps) || 0);
    this.instantaneousOutputKbps.labels(connLabel).set(parseFloat(info.stats.instantaneous_output_kbps) || 0);
    this.keyspaceHitsTotal.labels(connLabel).set(parseInt(info.stats.keyspace_hits) || 0);
    this.keyspaceMissesTotal.labels(connLabel).set(parseInt(info.stats.keyspace_misses) || 0);
    this.evictedKeysTotal.labels(connLabel).set(parseInt(info.stats.evicted_keys) || 0);
    this.expiredKeysTotal.labels(connLabel).set(parseInt(info.stats.expired_keys) || 0);
    this.pubsubChannels.labels(connLabel).set(parseInt(info.stats.pubsub_channels) || 0);
    this.pubsubPatterns.labels(connLabel).set(parseInt(info.stats.pubsub_patterns) || 0);
  }

  private updateReplicationMetrics(
    info: Record<string, any>,
    connLabel: string,
    connectionId: string,
    config: { host: string; port: number } | null,
  ): void {
    if (!info.replication) return;

    const role = info.replication.role;

    if (role === 'master') {
      this.connectedSlaves.labels(connLabel).set(parseInt(info.replication.connected_slaves || '0') || 0);
      if (info.replication.master_repl_offset) {
        this.replicationOffset.labels(connLabel).set(parseInt(info.replication.master_repl_offset) || 0);
      }
    } else if (role === 'slave') {
      const masterLinkStatus = info.replication.master_link_status;
      this.masterLinkUp.labels(connLabel).set(masterLinkStatus === 'up' ? 1 : 0);

      const lastIoSecondsAgo = parseInt(info.replication.master_last_io_seconds_ago) || 0;
      if (info.replication.master_last_io_seconds_ago) {
        this.masterLastIoSecondsAgo.labels(connLabel).set(lastIoSecondsAgo);
      }

      if (info.replication.slave_repl_offset) {
        this.replicationOffset.labels(connLabel).set(parseInt(info.replication.slave_repl_offset) || 0);
      }

      // Webhook dispatch for replication.lag
      if (this.webhookEventsProService && masterLinkStatus === 'up') {
        this.webhookEventsProService.dispatchReplicationLag({
          lagSeconds: lastIoSecondsAgo,
          threshold: 10,
          masterLinkStatus,
          timestamp: Date.now(),
          instance: { host: config?.host || 'localhost', port: config?.port || 6379 },
          connectionId,
        }).catch(err => {
          this.logger.error('Failed to dispatch replication.lag webhook', err);
        });
      }
    }
  }

  private updateKeyspaceMetricsFromInfo(
    info: Record<string, any>,
    connLabel: string,
    state: ConnectionMetricState,
  ): void {
    if (!info.keyspace) return;

    const newDbLabels = new Set<string>();

    for (const [dbKey, dbInfo] of Object.entries(info.keyspace as Record<string, unknown>)) {
      const dbNumber = dbKey;
      newDbLabels.add(dbNumber);

      if (typeof dbInfo === 'string') {
        const parts = dbInfo.split(',');
        let keys = 0, expires = 0, avgTtl = 0;

        for (const part of parts) {
          const [key, value] = part.split('=');
          if (key === 'keys') keys = parseInt(value) || 0;
          else if (key === 'expires') expires = parseInt(value) || 0;
          else if (key === 'avg_ttl') avgTtl = parseInt(value) || 0;
        }

        this.dbKeys.labels(connLabel, dbNumber).set(keys);
        this.dbKeysExpiring.labels(connLabel, dbNumber).set(expires);
        this.dbAvgTtlSeconds.labels(connLabel, dbNumber).set(avgTtl / 1000);
      } else {
        const parsedInfo = dbInfo as { keys: number; expires: number; avg_ttl: number };
        this.dbKeys.labels(connLabel, dbNumber).set(parsedInfo.keys || 0);
        this.dbKeysExpiring.labels(connLabel, dbNumber).set(parsedInfo.expires || 0);
        this.dbAvgTtlSeconds.labels(connLabel, dbNumber).set((parsedInfo.avg_ttl || 0) / 1000);
      }
    }

    // Remove stale db labels for this connection
    for (const staleDb of state.currentKeyspaceDbLabels) {
      if (!newDbLabels.has(staleDb)) {
        this.dbKeys.labels(connLabel, staleDb).set(0);
        this.dbKeysExpiring.labels(connLabel, staleDb).set(0);
        this.dbAvgTtlSeconds.labels(connLabel, staleDb).set(0);
      }
    }

    state.currentKeyspaceDbLabels = newDbLabels;
  }

  private async updateClusterMetricsFromInfo(
    client: DatabasePort,
    info: Record<string, any>,
    connLabel: string,
    connectionId: string,
    state: ConnectionMetricState,
    config: { host: string; port: number } | null,
  ): Promise<void> {
    const clusterEnabled = info.cluster?.cluster_enabled === '1';
    this.clusterEnabled.labels(connLabel).set(clusterEnabled ? 1 : 0);

    if (!clusterEnabled) return;

    try {
      const clusterInfo = await client.getClusterInfo();

      const clusterState = clusterInfo.cluster_state;
      const slotsFail = parseInt(clusterInfo.cluster_slots_fail) || 0;

      if (clusterInfo.cluster_known_nodes) {
        this.clusterKnownNodes.labels(connLabel).set(parseInt(clusterInfo.cluster_known_nodes) || 0);
      }
      if (clusterInfo.cluster_size) {
        this.clusterSize.labels(connLabel).set(parseInt(clusterInfo.cluster_size) || 0);
      }
      if (clusterInfo.cluster_slots_assigned) {
        this.clusterSlotsAssigned.labels(connLabel).set(parseInt(clusterInfo.cluster_slots_assigned) || 0);
      }
      if (clusterInfo.cluster_slots_ok) {
        this.clusterSlotsOk.labels(connLabel).set(parseInt(clusterInfo.cluster_slots_ok) || 0);
      }
      if (clusterInfo.cluster_slots_fail) {
        this.clusterSlotsFail.labels(connLabel).set(slotsFail);
      }
      if (clusterInfo.cluster_slots_pfail) {
        this.clusterSlotsPfail.labels(connLabel).set(parseInt(clusterInfo.cluster_slots_pfail) || 0);
      }

      // Webhook dispatch for cluster.failover
      if (this.webhookEventsProService) {
        const stateChanged = state.previousClusterState === 'ok' && clusterState === 'fail';
        const newSlotFailures = state.previousSlotsFail < slotsFail && slotsFail > 0;

        if (stateChanged || newSlotFailures) {
          try {
            await this.webhookEventsProService.dispatchClusterFailover({
              clusterState,
              previousState: state.previousClusterState ?? undefined,
              slotsAssigned: parseInt(clusterInfo.cluster_slots_assigned) || 0,
              slotsFailed: slotsFail,
              knownNodes: parseInt(clusterInfo.cluster_known_nodes) || 0,
              timestamp: Date.now(),
              instance: { host: config?.host || 'localhost', port: config?.port || 6379 },
              connectionId,
            });
          } catch (err) {
            this.logger.error('Failed to dispatch cluster.failover webhook', err);
          }
        }

        state.previousClusterState = clusterState;
        state.previousSlotsFail = slotsFail;
      }

      const capabilities = client.getCapabilities();
      if (capabilities.hasClusterSlotStats) {
        const newSlotLabels = new Set<string>();
        const slotStats = await client.getClusterSlotStats('key-count', 100);

        for (const [slot, stats] of Object.entries(slotStats)) {
          newSlotLabels.add(slot);
          this.clusterSlotKeys.labels(connLabel, slot).set(stats.key_count || 0);
          this.clusterSlotExpires.labels(connLabel, slot).set(stats.expires_count || 0);
          this.clusterSlotReadsTotal.labels(connLabel, slot).set(stats.total_reads || 0);
          this.clusterSlotWritesTotal.labels(connLabel, slot).set(stats.total_writes || 0);
        }

        for (const staleSlot of state.currentClusterSlotLabels) {
          if (!newSlotLabels.has(staleSlot)) {
            this.clusterSlotKeys.labels(connLabel, staleSlot).set(0);
            this.clusterSlotExpires.labels(connLabel, staleSlot).set(0);
            this.clusterSlotReadsTotal.labels(connLabel, staleSlot).set(0);
            this.clusterSlotWritesTotal.labels(connLabel, staleSlot).set(0);
          }
        }

        state.currentClusterSlotLabels = newSlotLabels;
      }
    } catch (error) {
      this.logger.error(`Failed to update cluster metrics for ${connLabel}`, error);
    }
  }

  private async updateAclMetrics(
    connectionId: string,
    connLabel: string,
    state: ConnectionMetricState,
  ): Promise<void> {
    try {
      const stats = await this.storage.getAuditStats(undefined, undefined, connectionId);

      this.aclDeniedTotal.labels(connLabel).set(stats.totalEntries);

      const newReasonLabels = new Set<string>();
      const newUserLabels = new Set<string>();

      for (const [reason, count] of Object.entries(stats.entriesByReason)) {
        newReasonLabels.add(reason);
        this.aclDeniedByReason.labels(connLabel, reason).set(count);
      }
      for (const [user, count] of Object.entries(stats.entriesByUser)) {
        newUserLabels.add(user);
        this.aclDeniedByUser.labels(connLabel, user).set(count);
      }

      // Clean up stale labels for this connection
      for (const staleReason of state.currentAclReasonLabels) {
        if (!newReasonLabels.has(staleReason)) {
          this.aclDeniedByReason.labels(connLabel, staleReason).set(0);
        }
      }
      for (const staleUser of state.currentAclUserLabels) {
        if (!newUserLabels.has(staleUser)) {
          this.aclDeniedByUser.labels(connLabel, staleUser).set(0);
        }
      }

      state.currentAclReasonLabels = newReasonLabels;
      state.currentAclUserLabels = newUserLabels;
    } catch (error) {
      this.logger.error(`Failed to update ACL audit metrics for ${connLabel}`, error);
    }
  }

  private async updateClientMetrics(
    connectionId: string,
    connLabel: string,
    state: ConnectionMetricState,
  ): Promise<void> {
    try {
      const stats = await this.storage.getClientAnalyticsStats(undefined, undefined, connectionId);

      this.clientConnectionsCurrent.labels(connLabel).set(stats.currentConnections);
      this.clientConnectionsPeak.labels(connLabel).set(stats.peakConnections);

      const newNameLabels = new Set<string>();
      const newUserLabels = new Set<string>();

      for (const [name, data] of Object.entries(stats.connectionsByName)) {
        const label = name || 'unnamed';
        newNameLabels.add(label);
        this.clientConnectionsByName.labels(connLabel, label).set(data.current);
      }
      for (const [user, data] of Object.entries(stats.connectionsByUser)) {
        newUserLabels.add(user);
        this.clientConnectionsByUser.labels(connLabel, user).set(data.current);
      }

      // Clean up stale labels for this connection
      for (const staleName of state.currentClientNameLabels) {
        if (!newNameLabels.has(staleName)) {
          this.clientConnectionsByName.labels(connLabel, staleName).set(0);
        }
      }
      for (const staleUser of state.currentClientUserLabels) {
        if (!newUserLabels.has(staleUser)) {
          this.clientConnectionsByUser.labels(connLabel, staleUser).set(0);
        }
      }

      state.currentClientNameLabels = newNameLabels;
      state.currentClientUserLabels = newUserLabels;
    } catch (error) {
      this.logger.error(`Failed to update client analytics metrics for ${connLabel}`, error);
    }
  }

  private async updateSlowlogMetrics(
    connectionId: string,
    connLabel: string,
    state: ConnectionMetricState,
  ): Promise<void> {
    try {
      const analysis = this.slowLogAnalytics.getCachedAnalysis(connectionId);

      if (!analysis) {
        return;
      }

      const newPatternLabels = new Set<string>();

      for (const p of analysis.patterns) {
        newPatternLabels.add(p.pattern);
        this.slowlogPatternCount.labels(connLabel, p.pattern).set(p.count);
        this.slowlogPatternDuration.labels(connLabel, p.pattern).set(p.avgDuration);
        this.slowlogPatternPercentage.labels(connLabel, p.pattern).set(p.percentage);
      }

      // Clean up stale labels for this connection
      for (const stalePattern of state.currentSlowlogPatternLabels) {
        if (!newPatternLabels.has(stalePattern)) {
          this.slowlogPatternCount.labels(connLabel, stalePattern).set(0);
          this.slowlogPatternDuration.labels(connLabel, stalePattern).set(0);
          this.slowlogPatternPercentage.labels(connLabel, stalePattern).set(0);
        }
      }

      state.currentSlowlogPatternLabels = newPatternLabels;
    } catch (error) {
      this.logger.error(`Failed to update slowlog metrics for ${connLabel}`, error);
    }
  }

  private async updateCommandlogMetrics(
    connectionId: string,
    connLabel: string,
    state: ConnectionMetricState,
  ): Promise<void> {
    try {
      if (!this.commandLogAnalytics.hasCommandLogSupport(connectionId)) {
        return;
      }

      const newRequestPatternLabels = new Set<string>();
      const newReplyPatternLabels = new Set<string>();

      const requestAnalysis = this.commandLogAnalytics.getCachedAnalysis('large-request', connectionId);
      let requestTotal = 0;
      if (requestAnalysis) {
        for (const p of requestAnalysis.patterns) {
          newRequestPatternLabels.add(p.pattern);
          this.commandlogLargeRequestByPattern.labels(connLabel, p.pattern).set(p.count);
          requestTotal += p.count;
        }
      }
      this.commandlogLargeRequestCount.labels(connLabel).set(requestTotal);

      const replyAnalysis = this.commandLogAnalytics.getCachedAnalysis('large-reply', connectionId);
      let replyTotal = 0;
      if (replyAnalysis) {
        for (const p of replyAnalysis.patterns) {
          newReplyPatternLabels.add(p.pattern);
          this.commandlogLargeReplyByPattern.labels(connLabel, p.pattern).set(p.count);
          replyTotal += p.count;
        }
      }
      this.commandlogLargeReplyCount.labels(connLabel).set(replyTotal);

      // Clean up stale labels for this connection
      for (const stalePattern of state.currentCommandlogRequestPatternLabels) {
        if (!newRequestPatternLabels.has(stalePattern)) {
          this.commandlogLargeRequestByPattern.labels(connLabel, stalePattern).set(0);
        }
      }
      for (const stalePattern of state.currentCommandlogReplyPatternLabels) {
        if (!newReplyPatternLabels.has(stalePattern)) {
          this.commandlogLargeReplyByPattern.labels(connLabel, stalePattern).set(0);
        }
      }

      state.currentCommandlogRequestPatternLabels = newRequestPatternLabels;
      state.currentCommandlogReplyPatternLabels = newReplyPatternLabels;
    } catch (error) {
      this.logger.error(`Failed to update commandlog metrics for ${connLabel}`, error);
    }
  }

  private async updateSlowlogRawMetrics(
    connLabel: string,
    connectionId: string,
    config: { host: string; port: number } | null,
  ): Promise<void> {
    try {
      const length = await this.slowLogAnalytics.getSlowLogLength(connectionId);
      this.slowlogLength.labels(connLabel).set(length);

      const lastId = this.slowLogAnalytics.getLastSeenId(connectionId);
      if (lastId !== null) {
        this.slowlogLastId.labels(connLabel).set(lastId);
      }

      // Webhook dispatch for slowlog.threshold
      if (this.webhookEventsProService) {
        this.webhookEventsProService.dispatchSlowlogThreshold({
          slowlogCount: length,
          threshold: 100,
          timestamp: Date.now(),
          instance: { host: config?.host || 'localhost', port: config?.port || 6379 },
          connectionId,
        }).catch(err => {
          this.logger.error('Failed to dispatch slowlog.threshold webhook', err);
        });
      }
    } catch (error) {
      this.logger.error(`Failed to update slowlog raw metrics for ${connLabel}`, error);
    }
  }

  async getMetrics(): Promise<string> {
    await this.updateMetrics();
    const metrics = await this.registry.metrics();
    return metrics
      .split('\n')
      .filter(line => !line.match(/\s+[Nn]a[Nn]\s*$/))
      .join('\n');
  }

  getContentType(): string {
    return this.registry.contentType;
  }

  incrementPollCounter(connectionId?: string): void {
    const connLabel = connectionId ? this.getConnectionLabel(connectionId) : 'system';
    this.pollsTotal.labels(connLabel).inc();
  }

  startPollTimer(service: string, connectionId?: string): () => void {
    const connLabel = connectionId ? this.getConnectionLabel(connectionId) : 'system';
    return this.pollDuration.startTimer({ connection: connLabel, service });
  }

  incrementAnomalyEvent(severity: string, metricType: string, anomalyType: string, connectionId?: string): void {
    const connLabel = connectionId ? this.getConnectionLabel(connectionId) : 'unknown';
    this.anomalyEventsTotal.inc({ connection: connLabel, severity, metric_type: metricType, anomaly_type: anomalyType });
  }

  incrementCorrelatedGroup(pattern: string, severity: string, connectionId?: string): void {
    const connLabel = connectionId ? this.getConnectionLabel(connectionId) : 'unknown';
    this.correlatedGroupsTotal.inc({ connection: connLabel, pattern, severity });
  }

  updateAnomalySummary(
    summary: {
      bySeverity: Record<string, number>;
      byMetric: Record<string, number>;
      byPattern: Record<string, number>;
      unresolvedBySeverity: Record<string, number>;
    },
    connectionId?: string,
  ): void {
    const effectiveConnectionId = connectionId || this.connectionRegistry.getDefaultId() || 'unknown';
    const connLabel = this.getConnectionLabel(effectiveConnectionId);
    const state = this.getConnectionState(effectiveConnectionId);

    for (const sev of ['info', 'warning', 'critical']) {
      this.anomalyBySeverity.labels(connLabel, sev).set(summary.bySeverity[sev] ?? 0);
      this.anomalyEventsCurrent.labels(connLabel, sev).set(summary.unresolvedBySeverity[sev] ?? 0);
    }

    const newMetricLabels = new Set<string>();
    const newPatternLabels = new Set<string>();

    for (const [metric, count] of Object.entries(summary.byMetric)) {
      newMetricLabels.add(metric);
      this.anomalyByMetric.labels(connLabel, metric).set(count);
    }
    for (const [pattern, count] of Object.entries(summary.byPattern)) {
      newPatternLabels.add(pattern);
      this.correlatedGroupsByPattern.labels(connLabel, pattern).set(count);
    }

    // Clean up stale labels for this connection
    for (const staleMetric of state.currentAnomalyMetricLabels) {
      if (!newMetricLabels.has(staleMetric)) {
        this.anomalyByMetric.labels(connLabel, staleMetric).set(0);
      }
    }
    for (const stalePattern of state.currentCorrelatedPatternLabels) {
      if (!newPatternLabels.has(stalePattern)) {
        this.correlatedGroupsByPattern.labels(connLabel, stalePattern).set(0);
      }
    }

    state.currentAnomalyMetricLabels = newMetricLabels;
    state.currentCorrelatedPatternLabels = newPatternLabels;
  }

  updateAnomalyBufferStats(
    buffers: Array<{ metricType: string; mean: number; stdDev: number; ready: boolean }>,
    connectionId?: string,
  ): void {
    const effectiveConnectionId = connectionId || this.connectionRegistry.getDefaultId() || 'unknown';
    const connLabel = this.getConnectionLabel(effectiveConnectionId);
    for (const buf of buffers) {
      this.anomalyDetectionBufferReady.labels(connLabel, buf.metricType).set(buf.ready ? 1 : 0);
      this.anomalyDetectionBufferMean.labels(connLabel, buf.metricType).set(buf.mean);
      this.anomalyDetectionBufferStdDev.labels(connLabel, buf.metricType).set(buf.stdDev);
    }
  }

  /**
   * Clean up metrics for a removed connection
   */
  cleanupConnectionMetrics(connectionId: string): void {
    this.perConnectionState.delete(connectionId);
    // Note: prom-client doesn't easily support removing specific label values
    // The metrics will be overwritten on next scrape or remain at last value
  }

  private formatBytes(bytes: number): string {
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
    if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(2)} MB`;
    if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(2)} KB`;
    return `${bytes} B`;
  }
}
