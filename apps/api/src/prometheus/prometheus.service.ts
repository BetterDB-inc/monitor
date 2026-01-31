import { Injectable, OnModuleInit, OnModuleDestroy, Inject, Logger, Optional, forwardRef } from '@nestjs/common';
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
import { DatabasePort } from '../common/interfaces/database-port.interface';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';
import { SlowLogAnalyticsService } from '../slowlog-analytics/slowlog-analytics.service';
import { CommandLogAnalyticsService } from '../commandlog-analytics/commandlog-analytics.service';
import { HealthService } from '../health/health.service';

// Note: WebhookEventsProService and WebhookEventsEnterpriseService are injected via DI
// when proprietary module is available. Interfaces provide type safety for optional injection.

@Injectable()
export class PrometheusService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrometheusService.name);
  private registry: Registry;
  private pollInterval: NodeJS.Timeout | null = null;
  private readonly pollIntervalMs = 5000; // Poll every 5 seconds

  // Track cluster state for failover detection
  private previousClusterState: string | null = null;
  private previousSlotsFail: number = 0;

  // Track current labels to avoid race conditions with reset()
  // Setting new values before removing stale ones prevents Prometheus from scraping zeros
  private currentAclReasonLabels = new Set<string>();
  private currentAclUserLabels = new Set<string>();
  private currentClientNameLabels = new Set<string>();
  private currentClientUserLabels = new Set<string>();
  private currentSlowlogPatternLabels = new Set<string>();
  private currentCommandlogRequestPatternLabels = new Set<string>();
  private currentCommandlogReplyPatternLabels = new Set<string>();
  private currentKeyspaceDbLabels = new Set<string>();
  private currentClusterSlotLabels = new Set<string>();
  private currentAnomalyMetricLabels = new Set<string>();
  private currentCorrelatedPatternLabels = new Set<string>();

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

  private readonly dbHost: string;
  private readonly dbPort: number;

  constructor(
    @Inject('STORAGE_CLIENT') private storage: StoragePort,
    @Inject('DATABASE_CLIENT') private dbClient: DatabasePort,
    private readonly configService: ConfigService,
    private readonly slowLogAnalytics: SlowLogAnalyticsService,
    private readonly commandLogAnalytics: CommandLogAnalyticsService,
    @Inject(forwardRef(() => HealthService)) private readonly healthService: HealthService,
    @Optional() private readonly webhookDispatcher?: WebhookDispatcherService,
    @Optional() @Inject(WEBHOOK_EVENTS_PRO_SERVICE) private readonly webhookEventsProService?: IWebhookEventsProService,
    @Optional() @Inject(WEBHOOK_EVENTS_ENTERPRISE_SERVICE) private readonly webhookEventsEnterpriseService?: IWebhookEventsEnterpriseService,
  ) {
    this.registry = new Registry();
    this.dbHost = this.configService.get<string>('database.host', 'localhost');
    this.dbPort = this.configService.get<number>('database.port', 6379);
    this.initializeMetrics();
  }

  async onModuleInit(): Promise<void> {
    collectDefaultMetrics({ register: this.registry, prefix: 'betterdb_' });
    this.logger.log(`Starting Prometheus metrics polling (interval: ${this.pollIntervalMs}ms)`);

    // Do initial update
    await this.updateMetrics().catch(err =>
      this.logger.error('Failed initial metrics update', err)
    );

    // Start polling
    this.startPolling();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  private startPolling(): void {
    const scheduleNextPoll = () => {
      this.pollInterval = setTimeout(async () => {
        try {
          await this.updateMetrics();
          // Check health on successful update (will trigger instance.up if recovered)
          await this.healthService.getHealth().catch(() => {});
        } catch (error) {
          this.logger.error(`Failed to update metrics: ${error instanceof Error ? error.message : 'Unknown error'}`);
          // Check health on failure (will trigger instance.down webhook)
          await this.healthService.getHealth().catch(() => {});
        }
        scheduleNextPoll();
      }, this.pollIntervalMs);
    };
    scheduleNextPoll();
  }

  private createGauge(name: string, help: string, labelNames?: string[]): Gauge {
    return new Gauge({
      name: `betterdb_${name}`,
      help,
      ...(labelNames && { labelNames }),
      registers: [this.registry],
    });
  }

  private initializeMetrics(): void {
    // ACL Audit
    this.aclDeniedTotal = this.createGauge('acl_denied', 'Total ACL denied events captured');
    this.aclDeniedByReason = this.createGauge('acl_denied_by_reason', 'ACL denied events by reason', ['reason']);
    this.aclDeniedByUser = this.createGauge('acl_denied_by_user', 'ACL denied events by username', ['username']);

    // Client Analytics
    this.clientConnectionsCurrent = this.createGauge('client_connections_current', 'Current number of client connections');
    this.clientConnectionsByName = this.createGauge('client_connections_by_name', 'Current connections by client name', ['client_name']);
    this.clientConnectionsByUser = this.createGauge('client_connections_by_user', 'Current connections by ACL user', ['user']);
    this.clientConnectionsPeak = this.createGauge('client_connections_peak', 'Peak connections in retention period');

    // Slowlog Patterns
    this.slowlogPatternCount = this.createGauge('slowlog_pattern_count', 'Number of slow queries per pattern', ['pattern']);
    this.slowlogPatternDuration = this.createGauge('slowlog_pattern_avg_duration_us', 'Average duration in microseconds per pattern', ['pattern']);
    this.slowlogPatternPercentage = this.createGauge('slowlog_pattern_percentage', 'Percentage of slow queries per pattern', ['pattern']);

    // COMMANDLOG (Valkey 8.1+)
    this.commandlogLargeRequestCount = this.createGauge('commandlog_large_request', 'Total large request entries');
    this.commandlogLargeReplyCount = this.createGauge('commandlog_large_reply', 'Total large reply entries');
    this.commandlogLargeRequestByPattern = this.createGauge('commandlog_large_request_by_pattern', 'Large request count by command pattern', ['pattern']);
    this.commandlogLargeReplyByPattern = this.createGauge('commandlog_large_reply_by_pattern', 'Large reply count by command pattern', ['pattern']);

    // Standard INFO - Server
    this.uptimeInSeconds = this.createGauge('uptime_in_seconds', 'Server uptime in seconds');
    this.instanceInfo = this.createGauge('instance_info', 'Instance information (always 1)', ['version', 'role', 'os']);

    // Standard INFO - Clients
    this.connectedClients = this.createGauge('connected_clients', 'Number of client connections');
    this.blockedClients = this.createGauge('blocked_clients', 'Clients blocked on BLPOP, BRPOP, etc');
    this.trackingClients = this.createGauge('tracking_clients', 'Clients being tracked for client-side caching');

    // Standard INFO - Memory
    this.memoryUsedBytes = this.createGauge('memory_used_bytes', 'Total allocated memory in bytes');
    this.memoryUsedRssBytes = this.createGauge('memory_used_rss_bytes', 'RSS memory usage in bytes');
    this.memoryUsedPeakBytes = this.createGauge('memory_used_peak_bytes', 'Peak memory usage in bytes');
    this.memoryMaxBytes = this.createGauge('memory_max_bytes', 'Maximum memory limit in bytes (0 if unlimited)');
    this.memoryFragmentationRatio = this.createGauge('memory_fragmentation_ratio', 'Memory fragmentation ratio');
    this.memoryFragmentationBytes = this.createGauge('memory_fragmentation_bytes', 'Memory fragmentation in bytes');

    // Standard INFO - Stats
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

    // Standard INFO - Replication
    this.connectedSlaves = this.createGauge('connected_slaves', 'Number of connected replicas');
    this.replicationOffset = this.createGauge('replication_offset', 'Replication offset');
    this.masterLinkUp = this.createGauge('master_link_up', '1 if link to master is up (replica only)');
    this.masterLastIoSecondsAgo = this.createGauge('master_last_io_seconds_ago', 'Seconds since last I/O with master (replica only)');

    // Keyspace Metrics (per database)
    this.dbKeys = this.createGauge('db_keys', 'Total keys in database', ['db']);
    this.dbKeysExpiring = this.createGauge('db_keys_expiring', 'Keys with expiration in database', ['db']);
    this.dbAvgTtlSeconds = this.createGauge('db_avg_ttl_seconds', 'Average TTL in seconds', ['db']);

    // Cluster Metrics
    this.clusterEnabled = this.createGauge('cluster_enabled', '1 if cluster mode is enabled');
    this.clusterKnownNodes = this.createGauge('cluster_known_nodes', 'Number of known cluster nodes');
    this.clusterSize = this.createGauge('cluster_size', 'Number of master nodes in cluster');
    this.clusterSlotsAssigned = this.createGauge('cluster_slots_assigned', 'Number of assigned slots');
    this.clusterSlotsOk = this.createGauge('cluster_slots_ok', 'Number of slots in OK state');
    this.clusterSlotsFail = this.createGauge('cluster_slots_fail', 'Number of slots in FAIL state');
    this.clusterSlotsPfail = this.createGauge('cluster_slots_pfail', 'Number of slots in PFAIL state');

    // Cluster Slot Metrics (Valkey 8.0+)
    this.clusterSlotKeys = this.createGauge('cluster_slot_keys', 'Keys in cluster slot', ['slot']);
    this.clusterSlotExpires = this.createGauge('cluster_slot_expires', 'Expiring keys in cluster slot', ['slot']);
    this.clusterSlotReadsTotal = this.createGauge('cluster_slot_reads_total', 'Total reads for cluster slot', ['slot']);
    this.clusterSlotWritesTotal = this.createGauge('cluster_slot_writes_total', 'Total writes for cluster slot', ['slot']);

    // Slowlog Raw Metrics
    this.slowlogLength = this.createGauge('slowlog_length', 'Current slowlog length');
    this.slowlogLastId = this.createGauge('slowlog_last_id', 'ID of last slowlog entry');

    // Poll Counter Metric
    this.pollsTotal = new Counter({
      name: 'betterdb_polls_total',
      help: 'Total number of poll cycles completed',
      registers: [this.registry],
    });

    // Poll Duration Metric
    this.pollDuration = new Histogram({
      name: 'betterdb_poll_duration_seconds',
      help: 'Duration of poll cycles in seconds',
      labelNames: ['service'],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });

    // Anomaly detection
    this.anomalyEventsTotal = new Counter({
      name: 'betterdb_anomaly_events_total',
      help: 'Total anomaly events detected',
      labelNames: ['severity', 'metric_type', 'anomaly_type'],
      registers: [this.registry],
    });
    this.correlatedGroupsTotal = new Counter({
      name: 'betterdb_correlated_groups_total',
      help: 'Total correlated anomaly groups',
      labelNames: ['pattern', 'severity'],
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

  async updateMetrics(): Promise<void> {
    // Fetch INFO once and update all related metrics
    await this.updateAllInfoBasedMetrics();
    // Update slowlog raw metrics
    await this.updateSlowlogRawMetrics();

    // Update BetterDB-specific metrics
    await this.updateAclMetrics();
    await this.updateClientMetrics();
    await this.updateSlowlogMetrics();
    await this.updateCommandlogMetrics();
  }

  private async updateAllInfoBasedMetrics(): Promise<void> {
    try {
      const info = await this.dbClient.getInfoParsed();
      
      this.updateServerMetrics(info);
      this.updateClientInfoMetrics(info);
      this.updateMemoryMetrics(info);
      this.updateStatsMetrics(info);
      this.updateReplicationMetrics(info);
      this.updateKeyspaceMetricsFromInfo(info);
      await this.updateClusterMetricsFromInfo(info);
    } catch (error) {
      this.logger.error('Failed to update INFO-based metrics', error);
    }
  }

  private updateServerMetrics(info: Record<string, any>): void {
    if (!info.server) return;
    
    const version = info.server.valkey_version || info.server.redis_version || 'unknown';
    const role = info.replication?.role || 'unknown';
    const os = info.server.os || 'unknown';

    this.uptimeInSeconds.set(parseInt(info.server.uptime_in_seconds) || 0);
    this.instanceInfo.labels(version, role, os).set(1);
  }

  private updateClientInfoMetrics(info: Record<string, any>): void {
    if (!info.clients) return;

    const connectedClients = parseInt(info.clients.connected_clients) || 0;
    const maxClients = parseInt(info.clients.maxclients) || 10000; // Default maxclients

    this.connectedClients.set(connectedClients);
    this.blockedClients.set(parseInt(info.clients.blocked_clients) || 0);
    if (info.clients.tracking_clients) {
      this.trackingClients.set(parseInt(info.clients.tracking_clients) || 0);
    }

    // Webhook dispatch for connection.critical (per-webhook thresholds)
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
        }
      ).catch(err => {
        this.logger.error('Failed to dispatch connection.critical webhook', err);
      });
    }
  }

  private updateMemoryMetrics(info: Record<string, any>): void {
    if (!info.memory) return;

    const memoryUsed = parseInt(info.memory.used_memory) || 0;
    const maxMemory = parseInt(info.memory.maxmemory) || 0;
    const maxmemoryPolicy = info.memory.maxmemory_policy || 'noeviction';

    this.memoryUsedBytes.set(memoryUsed);
    this.memoryUsedRssBytes.set(parseInt(info.memory.used_memory_rss) || 0);
    this.memoryUsedPeakBytes.set(parseInt(info.memory.used_memory_peak) || 0);
    this.memoryMaxBytes.set(maxMemory);
    this.memoryFragmentationRatio.set(parseFloat(info.memory.mem_fragmentation_ratio) || 0);
    this.memoryFragmentationBytes.set(parseInt(info.memory.mem_fragmentation_bytes) || 0);

    if (this.webhookDispatcher && maxMemory > 0) {
      const usedPercent = (memoryUsed / maxMemory) * 100;

      // Webhook dispatch for memory.critical (per-webhook thresholds)
      this.webhookDispatcher.dispatchThresholdAlertPerWebhook(
        WebhookEventType.MEMORY_CRITICAL,
        'memory_critical',
        usedPercent,
        'memoryCriticalPercent',
        true, // fire when ABOVE
        {
          usedBytes: memoryUsed,
          maxBytes: maxMemory,
          usedPercent: parseFloat(usedPercent.toFixed(2)),
          usedMemoryHuman: this.formatBytes(memoryUsed),
          maxMemoryHuman: this.formatBytes(maxMemory),
          message: `Memory usage critical: ${usedPercent.toFixed(1)}% (${this.formatBytes(memoryUsed)} / ${this.formatBytes(maxMemory)})`,
        }
      ).catch(err => {
        this.logger.error('Failed to dispatch memory.critical webhook', err);
      });

      // Webhook dispatch for compliance.alert (Enterprise tier - handled by proprietary service)
      // Trigger when memory is high AND eviction policy is 'noeviction' (data loss risk)
      if (usedPercent > 80 && maxmemoryPolicy === 'noeviction' && this.webhookEventsEnterpriseService) {
        this.webhookEventsEnterpriseService.dispatchComplianceAlert({
          complianceType: 'data_retention',
          severity: 'high',
          memoryUsedPercent: usedPercent,
          maxmemoryPolicy,
          message: `Compliance alert: Memory at ${usedPercent.toFixed(1)}% with 'noeviction' policy may cause data loss and violate retention policies`,
          timestamp: Date.now(),
          instance: { host: this.dbHost, port: this.dbPort },
        }).catch(err => {
          this.logger.error('Failed to dispatch compliance.alert webhook', err);
        });
      }
    }
  }

  private updateStatsMetrics(info: Record<string, any>): void {
    if (!info.stats) return;
    
    this.connectionsReceivedTotal.set(parseInt(info.stats.total_connections_received) || 0);
    this.commandsProcessedTotal.set(parseInt(info.stats.total_commands_processed) || 0);
    this.instantaneousOpsPerSec.set(parseInt(info.stats.instantaneous_ops_per_sec) || 0);
    this.instantaneousInputKbps.set(parseFloat(info.stats.instantaneous_input_kbps) || 0);
    this.instantaneousOutputKbps.set(parseFloat(info.stats.instantaneous_output_kbps) || 0);
    this.keyspaceHitsTotal.set(parseInt(info.stats.keyspace_hits) || 0);
    this.keyspaceMissesTotal.set(parseInt(info.stats.keyspace_misses) || 0);
    this.evictedKeysTotal.set(parseInt(info.stats.evicted_keys) || 0);
    this.expiredKeysTotal.set(parseInt(info.stats.expired_keys) || 0);
    this.pubsubChannels.set(parseInt(info.stats.pubsub_channels) || 0);
    this.pubsubPatterns.set(parseInt(info.stats.pubsub_patterns) || 0);
  }

  private updateReplicationMetrics(info: Record<string, any>): void {
    if (!info.replication) return;

    const role = info.replication.role;

    if (role === 'master') {
      this.connectedSlaves.set(parseInt(info.replication.connected_slaves || '0') || 0);
      if (info.replication.master_repl_offset) {
        this.replicationOffset.set(parseInt(info.replication.master_repl_offset) || 0);
      }
    } else if (role === 'slave') {
      const masterLinkStatus = info.replication.master_link_status;
      this.masterLinkUp.set(masterLinkStatus === 'up' ? 1 : 0);

      const lastIoSecondsAgo = parseInt(info.replication.master_last_io_seconds_ago) || 0;
      if (info.replication.master_last_io_seconds_ago) {
        this.masterLastIoSecondsAgo.set(lastIoSecondsAgo);
      }

      if (info.replication.slave_repl_offset) {
        this.replicationOffset.set(parseInt(info.replication.slave_repl_offset) || 0);
      }

      // Webhook dispatch for replication.lag (Pro tier - handled by proprietary service)
      if (this.webhookEventsProService && masterLinkStatus === 'up') {
        // Trigger if replication lag exceeds 10 seconds
        this.webhookEventsProService.dispatchReplicationLag({
          lagSeconds: lastIoSecondsAgo,
          threshold: 10,
          masterLinkStatus,
          timestamp: Date.now(),
          instance: { host: this.dbHost, port: this.dbPort },
        }).catch(err => {
          this.logger.error('Failed to dispatch replication.lag webhook', err);
        });
      }
    }
  }

  private updateKeyspaceMetricsFromInfo(info: Record<string, any>): void {
    if (!info.keyspace) return;

    const newDbLabels = new Set<string>();

    // Set new values first
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

        this.dbKeys.labels(dbNumber).set(keys);
        this.dbKeysExpiring.labels(dbNumber).set(expires);
        this.dbAvgTtlSeconds.labels(dbNumber).set(avgTtl / 1000);
      } else {
        const parsedInfo = dbInfo as { keys: number; expires: number; avg_ttl: number };
        this.dbKeys.labels(dbNumber).set(parsedInfo.keys || 0);
        this.dbKeysExpiring.labels(dbNumber).set(parsedInfo.expires || 0);
        this.dbAvgTtlSeconds.labels(dbNumber).set((parsedInfo.avg_ttl || 0) / 1000);
      }
    }

    // Remove stale labels (set to 0)
    for (const staleDb of this.currentKeyspaceDbLabels) {
      if (!newDbLabels.has(staleDb)) {
        this.dbKeys.labels(staleDb).set(0);
        this.dbKeysExpiring.labels(staleDb).set(0);
        this.dbAvgTtlSeconds.labels(staleDb).set(0);
      }
    }

    this.currentKeyspaceDbLabels = newDbLabels;
  }

  private async updateClusterMetricsFromInfo(info: Record<string, any>): Promise<void> {
    const clusterEnabled = info.cluster?.cluster_enabled === '1';
    this.clusterEnabled.set(clusterEnabled ? 1 : 0);

    if (!clusterEnabled) return;

    try {
      const clusterInfo = await this.dbClient.getClusterInfo();

      const clusterState = clusterInfo.cluster_state;
      const slotsFail = parseInt(clusterInfo.cluster_slots_fail) || 0;

      if (clusterInfo.cluster_known_nodes) {
        this.clusterKnownNodes.set(parseInt(clusterInfo.cluster_known_nodes) || 0);
      }
      if (clusterInfo.cluster_size) {
        this.clusterSize.set(parseInt(clusterInfo.cluster_size) || 0);
      }
      if (clusterInfo.cluster_slots_assigned) {
        this.clusterSlotsAssigned.set(parseInt(clusterInfo.cluster_slots_assigned) || 0);
      }
      if (clusterInfo.cluster_slots_ok) {
        this.clusterSlotsOk.set(parseInt(clusterInfo.cluster_slots_ok) || 0);
      }
      if (clusterInfo.cluster_slots_fail) {
        this.clusterSlotsFail.set(slotsFail);
      }
      if (clusterInfo.cluster_slots_pfail) {
        this.clusterSlotsPfail.set(parseInt(clusterInfo.cluster_slots_pfail) || 0);
      }

      // Webhook dispatch for cluster.failover (Pro tier - handled by proprietary service)
      if (this.webhookEventsProService) {
        // Detect cluster state change from 'ok' to 'fail'
        const stateChanged = this.previousClusterState === 'ok' && clusterState === 'fail';

        // Detect new slot failures
        const newSlotFailures = this.previousSlotsFail < slotsFail && slotsFail > 0;

        if (stateChanged || newSlotFailures) {
          try {
            await this.webhookEventsProService.dispatchClusterFailover({
              clusterState,
              previousState: this.previousClusterState ?? undefined,
              slotsAssigned: parseInt(clusterInfo.cluster_slots_assigned) || 0,
              slotsFailed: slotsFail,
              knownNodes: parseInt(clusterInfo.cluster_known_nodes) || 0,
              timestamp: Date.now(),
              instance: { host: this.dbHost, port: this.dbPort },
            });
          } catch (err) {
            this.logger.error('Failed to dispatch cluster.failover webhook', err);
          }
        }

        // Update tracked state
        this.previousClusterState = clusterState;
        this.previousSlotsFail = slotsFail;
      }

      const capabilities = this.dbClient.getCapabilities();
      if (capabilities.hasClusterSlotStats) {
        const newSlotLabels = new Set<string>();
        const slotStats = await this.dbClient.getClusterSlotStats('key-count', 100);

        // Set new values first
        for (const [slot, stats] of Object.entries(slotStats)) {
          newSlotLabels.add(slot);
          this.clusterSlotKeys.labels(slot).set(stats.key_count || 0);
          this.clusterSlotExpires.labels(slot).set(stats.expires_count || 0);
          this.clusterSlotReadsTotal.labels(slot).set(stats.total_reads || 0);
          this.clusterSlotWritesTotal.labels(slot).set(stats.total_writes || 0);
        }

        // Remove stale slot labels (set to 0)
        for (const staleSlot of this.currentClusterSlotLabels) {
          if (!newSlotLabels.has(staleSlot)) {
            this.clusterSlotKeys.labels(staleSlot).set(0);
            this.clusterSlotExpires.labels(staleSlot).set(0);
            this.clusterSlotReadsTotal.labels(staleSlot).set(0);
            this.clusterSlotWritesTotal.labels(staleSlot).set(0);
          }
        }

        this.currentClusterSlotLabels = newSlotLabels;
      }
    } catch (error) {
      this.logger.error('Failed to update cluster metrics', error);
    }
  }

  private async updateAclMetrics(): Promise<void> {
    try {
      const stats = await this.storage.getAuditStats();

      // Update total
      this.aclDeniedTotal.set(stats.totalEntries);

      const newReasonLabels = new Set<string>();
      const newUserLabels = new Set<string>();

      // Set new values first
      for (const [reason, count] of Object.entries(stats.entriesByReason)) {
        newReasonLabels.add(reason);
        this.aclDeniedByReason.labels(reason).set(count);
      }
      for (const [user, count] of Object.entries(stats.entriesByUser)) {
        newUserLabels.add(user);
        this.aclDeniedByUser.labels(user).set(count);
      }

      // Remove stale labels (set to 0)
      for (const staleReason of this.currentAclReasonLabels) {
        if (!newReasonLabels.has(staleReason)) {
          this.aclDeniedByReason.labels(staleReason).set(0);
        }
      }
      for (const staleUser of this.currentAclUserLabels) {
        if (!newUserLabels.has(staleUser)) {
          this.aclDeniedByUser.labels(staleUser).set(0);
        }
      }

      this.currentAclReasonLabels = newReasonLabels;
      this.currentAclUserLabels = newUserLabels;
    } catch (error) {
      this.logger.error('Failed to update ACL audit metrics', error);
    }
  }

  private async updateClientMetrics(): Promise<void> {
    try {
      const stats = await this.storage.getClientAnalyticsStats();

      this.clientConnectionsCurrent.set(stats.currentConnections);
      this.clientConnectionsPeak.set(stats.peakConnections);

      const newNameLabels = new Set<string>();
      const newUserLabels = new Set<string>();

      // Set new values first
      for (const [name, data] of Object.entries(stats.connectionsByName)) {
        const label = name || 'unnamed';
        newNameLabels.add(label);
        this.clientConnectionsByName.labels(label).set(data.current);
      }
      for (const [user, data] of Object.entries(stats.connectionsByUser)) {
        newUserLabels.add(user);
        this.clientConnectionsByUser.labels(user).set(data.current);
      }

      // Remove stale labels (set to 0)
      for (const staleName of this.currentClientNameLabels) {
        if (!newNameLabels.has(staleName)) {
          this.clientConnectionsByName.labels(staleName).set(0);
        }
      }
      for (const staleUser of this.currentClientUserLabels) {
        if (!newUserLabels.has(staleUser)) {
          this.clientConnectionsByUser.labels(staleUser).set(0);
        }
      }

      this.currentClientNameLabels = newNameLabels;
      this.currentClientUserLabels = newUserLabels;
    } catch (error) {
      this.logger.error('Failed to update client analytics metrics', error);
    }
  }

  private async updateSlowlogMetrics(): Promise<void> {
    try {
      // Use cached data from SlowLogAnalyticsService (avoids duplicate Valkey calls)
      const analysis = this.slowLogAnalytics.getCachedAnalysis();

      if (!analysis) {
        return; // No data yet from analytics service
      }

      const newPatternLabels = new Set<string>();

      // Set new values first
      for (const p of analysis.patterns) {
        newPatternLabels.add(p.pattern);
        this.slowlogPatternCount.labels(p.pattern).set(p.count);
        this.slowlogPatternDuration.labels(p.pattern).set(p.avgDuration);
        this.slowlogPatternPercentage.labels(p.pattern).set(p.percentage);
      }

      // Remove stale patterns (set to 0)
      for (const stalePattern of this.currentSlowlogPatternLabels) {
        if (!newPatternLabels.has(stalePattern)) {
          this.slowlogPatternCount.labels(stalePattern).set(0);
          this.slowlogPatternDuration.labels(stalePattern).set(0);
          this.slowlogPatternPercentage.labels(stalePattern).set(0);
        }
      }

      this.currentSlowlogPatternLabels = newPatternLabels;
    } catch (error) {
      this.logger.error('Failed to update slowlog metrics', error);
    }
  }

  private async updateCommandlogMetrics(): Promise<void> {
    try {
      // Use cached data from CommandLogAnalyticsService (avoids duplicate Valkey calls)
      if (!this.commandLogAnalytics.hasCommandLogSupport()) {
        return;
      }

      const newRequestPatternLabels = new Set<string>();
      const newReplyPatternLabels = new Set<string>();

      // Update large request patterns
      const requestAnalysis = this.commandLogAnalytics.getCachedAnalysis('large-request');
      let requestTotal = 0;
      if (requestAnalysis) {
        for (const p of requestAnalysis.patterns) {
          newRequestPatternLabels.add(p.pattern);
          this.commandlogLargeRequestByPattern.labels(p.pattern).set(p.count);
          requestTotal += p.count;
        }
      }
      this.commandlogLargeRequestCount.set(requestTotal);

      // Update large reply patterns
      const replyAnalysis = this.commandLogAnalytics.getCachedAnalysis('large-reply');
      let replyTotal = 0;
      if (replyAnalysis) {
        for (const p of replyAnalysis.patterns) {
          newReplyPatternLabels.add(p.pattern);
          this.commandlogLargeReplyByPattern.labels(p.pattern).set(p.count);
          replyTotal += p.count;
        }
      }
      this.commandlogLargeReplyCount.set(replyTotal);

      // Remove stale request patterns (set to 0)
      for (const stalePattern of this.currentCommandlogRequestPatternLabels) {
        if (!newRequestPatternLabels.has(stalePattern)) {
          this.commandlogLargeRequestByPattern.labels(stalePattern).set(0);
        }
      }
      // Remove stale reply patterns (set to 0)
      for (const stalePattern of this.currentCommandlogReplyPatternLabels) {
        if (!newReplyPatternLabels.has(stalePattern)) {
          this.commandlogLargeReplyByPattern.labels(stalePattern).set(0);
        }
      }

      this.currentCommandlogRequestPatternLabels = newRequestPatternLabels;
      this.currentCommandlogReplyPatternLabels = newReplyPatternLabels;
    } catch (error) {
      this.logger.error('Failed to update commandlog metrics', error);
    }
  }

  private async updateSlowlogRawMetrics(): Promise<void> {
    try {
      // Use analytics service for length (lightweight SLOWLOG LEN call)
      const length = await this.slowLogAnalytics.getSlowLogLength();
      this.slowlogLength.set(length);

      // Use cached lastSeenId from analytics service (no extra Valkey call)
      const lastId = this.slowLogAnalytics.getLastSeenId();
      if (lastId !== null) {
        this.slowlogLastId.set(lastId);
      }

      // Webhook dispatch for slowlog.threshold (Pro tier - handled by proprietary service)
      if (this.webhookEventsProService) {
        this.webhookEventsProService.dispatchSlowlogThreshold({
          slowlogCount: length,
          threshold: 100, // 100 entries threshold (configurable via env later)
          timestamp: Date.now(),
          instance: { host: this.dbHost, port: this.dbPort },
        }).catch(err => {
          this.logger.error('Failed to dispatch slowlog.threshold webhook', err);
        });
      }
    } catch (error) {
      this.logger.error('Failed to update slowlog raw metrics', error);
    }
  }

  async getMetrics(): Promise<string> {
    await this.updateMetrics();
    const metrics = await this.registry.metrics();
    // Filter out lines with NaN values - these are invalid in Prometheus exposition format
    // and can occur when event loop metrics haven't collected enough samples yet
    return metrics
      .split('\n')
      .filter(line => !line.match(/\s+[Nn]a[Nn]\s*$/))
      .join('\n');
  }

  getContentType(): string {
    return this.registry.contentType;
  }

  incrementPollCounter(): void {
    this.pollsTotal.inc();
  }

  startPollTimer(service: string): () => void {
    return this.pollDuration.startTimer({ service });
  }

  incrementAnomalyEvent(severity: string, metricType: string, anomalyType: string): void {
    this.anomalyEventsTotal.inc({ severity, metric_type: metricType, anomaly_type: anomalyType });
  }

  incrementCorrelatedGroup(pattern: string, severity: string): void {
    this.correlatedGroupsTotal.inc({ pattern, severity });
  }

  updateAnomalySummary(summary: {
    bySeverity: Record<string, number>;
    byMetric: Record<string, number>;
    byPattern: Record<string, number>;
    unresolvedBySeverity: Record<string, number>;
  }): void {
    // Severity labels are fixed - set directly without reset
    for (const sev of ['info', 'warning', 'critical']) {
      this.anomalyBySeverity.labels(sev).set(summary.bySeverity[sev] ?? 0);
      this.anomalyEventsCurrent.labels(sev).set(summary.unresolvedBySeverity[sev] ?? 0);
    }

    const newMetricLabels = new Set<string>();
    const newPatternLabels = new Set<string>();

    // Set new values first
    for (const [metric, count] of Object.entries(summary.byMetric)) {
      newMetricLabels.add(metric);
      this.anomalyByMetric.labels(metric).set(count);
    }
    for (const [pattern, count] of Object.entries(summary.byPattern)) {
      newPatternLabels.add(pattern);
      this.correlatedGroupsByPattern.labels(pattern).set(count);
    }

    // Remove stale labels (set to 0)
    for (const staleMetric of this.currentAnomalyMetricLabels) {
      if (!newMetricLabels.has(staleMetric)) {
        this.anomalyByMetric.labels(staleMetric).set(0);
      }
    }
    for (const stalePattern of this.currentCorrelatedPatternLabels) {
      if (!newPatternLabels.has(stalePattern)) {
        this.correlatedGroupsByPattern.labels(stalePattern).set(0);
      }
    }

    this.currentAnomalyMetricLabels = newMetricLabels;
    this.currentCorrelatedPatternLabels = newPatternLabels;
  }

  updateAnomalyBufferStats(buffers: Array<{ metricType: string; mean: number; stdDev: number; ready: boolean }>): void {
    // Buffer metric types are fixed per-session, no reset needed
    for (const buf of buffers) {
      this.anomalyDetectionBufferReady.labels(buf.metricType).set(buf.ready ? 1 : 0);
      this.anomalyDetectionBufferMean.labels(buf.metricType).set(buf.mean);
      this.anomalyDetectionBufferStdDev.labels(buf.metricType).set(buf.stdDev);
    }
  }

  /**
   * Format bytes to human-readable format
   */
  private formatBytes(bytes: number): string {
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
    if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(2)} MB`;
    if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(2)} KB`;
    return `${bytes} B`;
  }
}
