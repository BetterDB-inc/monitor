import { Injectable, OnModuleInit, Inject, Logger, Optional, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Registry,
  Gauge,
  Counter,
  Histogram,
  LabelValues,
  collectDefaultMetrics,
} from 'prom-client';
import {
  WebhookEventType,
  IWebhookEventsProService,
  IWebhookEventsEnterpriseService,
  WEBHOOK_EVENTS_PRO_SERVICE,
  WEBHOOK_EVENTS_ENTERPRISE_SERVICE,
} from '@betterdb/shared';
import { StoragePort } from '../common/interfaces/storage-port.interface';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { RuntimeCapabilityTracker } from '../connections/runtime-capability-tracker.service';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';
import { SlowLogAnalyticsService } from '../slowlog-analytics/slowlog-analytics.service';
import { CommandLogAnalyticsService } from '../commandlog-analytics/commandlog-analytics.service';
import { HealthService } from '../health/health.service';
import { DatabasePort } from '../common/interfaces/database-port.interface';
import { InfoResponse } from '../common/types/metrics.types';
import {
  MultiConnectionPoller,
  ConnectionContext,
} from '../common/services/multi-connection-poller';
import { MetricForecastingService } from '../metric-forecasting/metric-forecasting.service';
import { ALL_METRIC_KINDS } from '@betterdb/shared';
import { isCveEnabled } from '../cve/cve.constants';
import { OtelEventDispatcherService } from '../otel-telemetry/otel-event-dispatcher.service';
import {
  diffClusterTopology,
  snapshotTopology,
  TopologyDiff,
  TopologySnapshot,
} from '../cluster/topology-diff';
import { ClusterMetricsService } from '../cluster/cluster-metrics.service';
import {
  demotedWritesMessage,
  evaluateDemotedWrites,
  pruneDemotionWatch,
  recordDemotions,
  DemotedNodeObservation,
  DemotionWatch,
} from '../cluster/demoted-writes';
import {
  FreshnessTracker,
  POLL_STALE_METRIC,
  resolveStalenessMs,
  selectSeriesToRemove,
  SeriesSnapshot,
} from './staleness';
import {
  ExportProfile,
  isExportedInProfile,
  parseExportProfile,
  resolveSlotStatsTopN,
} from './export-profile';
import { DropReason } from '../external-metrics/otlp-metrics-types';

/**
 * Ceiling on the demoted-node read, clamped down to the poll interval when that
 * is shorter. Two INFO round trips to one node take milliseconds when the node
 * is answering at all.
 */
const DEMOTED_NODE_READ_TIMEOUT_MS = 2_000;

const SWEEP_EXCLUSIONS: ReadonlySet<string> = new Set([POLL_STALE_METRIC]);
const NO_EXCLUSIONS: ReadonlySet<string> = new Set();

// Per-connection state for tracking previous values and stale labels
interface ConnectionMetricState {
  previousClusterState: string | null;
  previousSlotsFail: number;
  previousCrcMismatch: number | null;
  previousTopology: TopologySnapshot | null;
  demotionWatch: DemotionWatch;
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
  // Vector index labels (per-connection)
  currentVectorIndexLabels: Set<string>;
  // Replication output-buffer pressure labels (per-connection)
  currentReplBufferReplicaLabels: Set<string>;
  // Commandstats labels (per-connection)
  currentCommandStatsLabels: Set<string>;
  // Inference latency labels (per-connection)
  currentInferenceBucketLabels: Set<string>;
  currentInferenceSlaBreachLabels: Set<string>;
  // Last exported CVE connection label (host:port can change on re-address)
  lastCveConnLabel: string | null;
  lastCveFingerprint: string | null;
  lastCveCheckAt: number;
  lastCveCheckedLabel: string | null;
  instanceInfoLabels: [string, string, string] | null;
}

@Injectable()
export class PrometheusService extends MultiConnectionPoller implements OnModuleInit {
  protected readonly logger = new Logger(PrometheusService.name);
  private readonly registry: Registry;
  private readonly exportProfile: ExportProfile;
  private readonly slotStatsTopN: number;
  private readonly exportRegistry: Registry;
  private readonly pollIntervalMs: number;
  private readonly freshness: FreshnessTracker;
  private pollStale: Gauge;

  // Per-connection state tracking
  private perConnectionState = new Map<string, ConnectionMetricState>();

  private static readonly CVE_METRICS_REFRESH_MS = 60_000;

  // Per-connection in-flight INFO-metric updates, so the background poller and a
  // /metrics scrape coalesce instead of racing on shared per-connection state.
  private updateMetricsInFlight = new Map<string, Promise<number>>();
  private healthChecksInFlight = new Map<string, Promise<void>>();
  private infoReadsInFlight = new Map<string, Promise<InfoResponse>>();

  // Per-connection pass epoch. Removing a connection or abandoning a pass at
  // its bound retires the epoch, so a reply that lands afterwards is dropped
  // instead of writing metrics behind whatever replaced it.
  private connectionEpochs = new Map<string, number>();

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
  private replOutputBufferRatio: Gauge;
  private replicationOffset: Gauge;
  private masterLinkUp: Gauge;
  private masterLastIoSecondsAgo: Gauge;

  // Keyspace Metrics (per db)
  private dbKeys: Gauge;
  private dbKeysExpiring: Gauge;
  private dbAvgTtlSeconds: Gauge;
  private keyspaceKeys: Gauge;
  private keyspaceKeysExpiring: Gauge;
  private rdbChangesSinceLastSave: Gauge;
  private rdbLastSaveTimestampSeconds: Gauge;
  private rdbLastBgsaveOk: Gauge;
  private aofEnabled: Gauge;
  private aofLastBgrewriteOk: Gauge;

  // Cluster Metrics
  private clusterEnabled: Gauge;
  private clusterKnownNodes: Gauge;
  private clusterSize: Gauge;
  private clusterSlotsAssigned: Gauge;
  private clusterSlotsOk: Gauge;
  private clusterSlotsFail: Gauge;
  private clusterSlotsPfail: Gauge;
  private clusterStatsMessagesCrcMismatch: Gauge;

  // Cluster Slot Metrics (Valkey 8.0+ specific)
  private clusterSlotKeys: Gauge;
  private clusterSlotExpires: Gauge;
  private clusterSlotReadsTotal: Gauge;
  private clusterSlotWritesTotal: Gauge;

  // CPU Metrics
  private cpuSysSecondsTotal: Gauge;
  private cpuUserSecondsTotal: Gauge;

  // Slowlog Raw Metrics
  private slowlogLength: Gauge;
  private slowlogLastId: Gauge;

  // Vector Index Metrics
  private vectorIndexDocs: Gauge;
  private vectorIndexMemoryBytes: Gauge;
  private vectorIndexFailures: Gauge;
  private vectorIndexPercentIndexed: Gauge;

  // Commandstats Metrics
  private commandstatsCallsTotal: Gauge;
  private commandstatsLatencyUs: Gauge;

  // Inference Latency Metrics
  private inferenceBucketP50Us: Gauge;
  private inferenceBucketP95Us: Gauge;
  private inferenceBucketP99Us: Gauge;
  private inferenceUnhealthy: Gauge;
  private inferenceSlaBreach: Gauge;

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

  // Metric Forecasting
  private metricForecastTimeToLimitSeconds: Gauge;

  // CVE Detection (storage-based, per-connection)
  private cveFindings: Gauge;
  private cveKev: Gauge;
  private cveDatasetStale: Gauge;

  // OTLP Ingest Metrics
  private otlpPointsAccepted: Counter;
  private otlpPointsDropped: Counter;

  constructor(
    @Inject('STORAGE_CLIENT') private storage: StoragePort,
    connectionRegistry: ConnectionRegistry,
    private readonly configService: ConfigService,
    private readonly runtimeCapabilityTracker: RuntimeCapabilityTracker,
    private readonly slowLogAnalytics: SlowLogAnalyticsService,
    private readonly commandLogAnalytics: CommandLogAnalyticsService,
    @Inject(forwardRef(() => HealthService)) private readonly healthService: HealthService,
    @Optional() private readonly webhookDispatcher?: WebhookDispatcherService,
    @Optional()
    @Inject(WEBHOOK_EVENTS_PRO_SERVICE)
    private readonly webhookEventsProService?: IWebhookEventsProService,
    @Optional()
    @Inject(WEBHOOK_EVENTS_ENTERPRISE_SERVICE)
    private readonly webhookEventsEnterpriseService?: IWebhookEventsEnterpriseService,
    @Optional()
    private readonly metricForecastingService?: MetricForecastingService,
    @Optional()
    private readonly otelEvents?: OtelEventDispatcherService,
    @Optional()
    private readonly clusterMetricsService?: ClusterMetricsService,
  ) {
    super(connectionRegistry);
    this.pollIntervalMs = Number(
      this.configService.get<number>('PROMETHEUS_POLL_INTERVAL_MS', 5000),
    );
    const configuredStaleness = this.configService.get<number>('PROMETHEUS_STALENESS_MS');
    const requestedStaleness =
      configuredStaleness === undefined ? undefined : Number(configuredStaleness);
    const stalenessMs = resolveStalenessMs(this.pollIntervalMs, requestedStaleness);
    if (requestedStaleness !== undefined && requestedStaleness !== stalenessMs) {
      this.logger.warn(
        `PROMETHEUS_STALENESS_MS=${requestedStaleness} is below the floor for a ` +
          `${this.pollIntervalMs}ms poll interval; using ${stalenessMs}ms instead`,
      );
    }
    this.freshness = new FreshnessTracker(stalenessMs);
    this.exportProfile = parseExportProfile(this.configService.get('METRICS_EXPORT_PROFILE'));
    this.slotStatsTopN = resolveSlotStatsTopN(
      this.configService.get('METRICS_SLOT_STATS_TOP_N'),
      this.exportProfile,
    );
    this.registry = new Registry();
    this.initializeMetrics();
    this.exportRegistry = this.buildExportRegistry();
  }

  protected getIntervalMs(): number {
    return this.pollIntervalMs;
  }

  protected supportsExternalConnections(): boolean {
    return true;
  }

  protected skipUnchangedSamples(): boolean {
    return false;
  }

  protected async pollConnection(ctx: ConnectionContext): Promise<void> {
    // One tick gets one interval in total. The base class waits for every
    // connection before the next tick, so stacking a second full bound here
    // would push healthy connections past their own staleness bound.
    const deadline = Date.now() + this.pollIntervalMs;
    try {
      const epoch = await this.updateMetricsForConnection(ctx.connectionId);

      // Update storage-based metrics for this connection
      await this.updateStorageBasedMetricsForConnection(ctx.connectionId, epoch);

      // Trigger health check on successful metrics update - may fire instance.up webhook if recovered
      await this.pingHealth(ctx.connectionId, deadline);
    } catch (error) {
      // Trigger health check on failure - may fire instance.down webhook
      await this.pingHealth(ctx.connectionId, deadline);
      throw error; // Re-throw so base class logs the error
    }
  }

  /**
   * Ping health within whatever is left of the tick's budget. With no budget
   * left the ping still runs — it is what fires instance.down for a wedged
   * node — but it is detached so it cannot extend the tick.
   */
  private pingHealth(connectionId: string, deadline: number): Promise<void> {
    const budgetMs = deadline - Date.now();
    const ping = this.readWithTimeout(
      this.startOrJoinHealthCheck(connectionId),
      budgetMs > 0 ? budgetMs : this.pollIntervalMs,
      `health check for ${connectionId}`,
    ).then(
      () => undefined,
      () => undefined,
    );
    return budgetMs > 0 ? ping : Promise.resolve();
  }

  /**
   * Coalesce health checks per connection. A timed-out ping abandons the wait
   * but not the underlying getHealth(), so without this a later tick could
   * start a second check and let the older one apply its up/down transition
   * after the newer result.
   */
  private startOrJoinHealthCheck(connectionId: string): Promise<void> {
    const existing = this.healthChecksInFlight.get(connectionId);
    if (existing !== undefined) {
      return existing;
    }
    const run: Promise<void> = this.healthService
      .getHealth(connectionId)
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        if (this.healthChecksInFlight.get(connectionId) === run) {
          this.healthChecksInFlight.delete(connectionId);
        }
      });
    this.healthChecksInFlight.set(connectionId, run);
    return run;
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
   * Get or create a per-connection metric state
   */
  private getConnectionState(connectionId: string): ConnectionMetricState {
    if (!this.perConnectionState.has(connectionId)) {
      this.perConnectionState.set(connectionId, {
        previousClusterState: null,
        previousSlotsFail: 0,
        previousCrcMismatch: null,
        previousTopology: null,
        demotionWatch: new Map(),
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
        // Vector index labels
        currentVectorIndexLabels: new Set(),
        // Replication output-buffer pressure labels
        currentReplBufferReplicaLabels: new Set(),
        // Commandstats labels
        currentCommandStatsLabels: new Set(),
        // Inference latency labels
        currentInferenceBucketLabels: new Set(),
        currentInferenceSlaBreachLabels: new Set(),
        lastCveConnLabel: null,
        lastCveFingerprint: null,
        lastCveCheckAt: 0,
        lastCveCheckedLabel: null,
        instanceInfoLabels: null,
      });
    }
    return this.perConnectionState.get(connectionId)!;
  }

  async onModuleInit(): Promise<void> {
    collectDefaultMetrics({ register: this.exportRegistry, prefix: 'betterdb_' });
    this.logger.log(
      `Starting Prometheus metrics polling (interval: ${this.pollIntervalMs}ms, profile: ${this.exportProfile})`,
    );
    this.start();
  }

  /**
   * Create a Gauge with a connection label always included
   */
  private createGauge(name: string, help: string, additionalLabels?: string[]): Gauge {
    return new Gauge({
      name: `betterdb_${name}`,
      help,
      labelNames: ['connection', ...(additionalLabels || [])],
      registers: [this.registry],
    });
  }

  private buildExportRegistry(): Registry {
    if (this.exportProfile === 'full') {
      return this.registry;
    }
    const exported = new Registry();
    for (const metric of this.registry.getMetricsAsArray()) {
      if (isExportedInProfile(metric.name, this.exportProfile)) {
        exported.registerMetric(metric as unknown as Parameters<Registry['registerMetric']>[0]);
      }
    }
    return exported;
  }

  private initializeMetrics(): void {
    // ACL Audit (storage-based, per-connection)
    this.aclDeniedTotal = this.createGauge('acl_denied', 'Total ACL denied events captured');
    this.aclDeniedByReason = this.createGauge(
      'acl_denied_by_reason',
      'ACL denied events by reason',
      ['reason'],
    );
    this.aclDeniedByUser = this.createGauge('acl_denied_by_user', 'ACL denied events by username', [
      'username',
    ]);

    // Client Analytics (storage-based, per-connection)
    this.clientConnectionsCurrent = this.createGauge(
      'client_connections_current',
      'Current number of client connections',
    );
    this.clientConnectionsByName = this.createGauge(
      'client_connections_by_name',
      'Current connections by client name',
      ['client_name'],
    );
    this.clientConnectionsByUser = this.createGauge(
      'client_connections_by_user',
      'Current connections by ACL user',
      ['user'],
    );
    this.clientConnectionsPeak = this.createGauge(
      'client_connections_peak',
      'Peak connections in retention period',
    );

    // Slowlog Patterns (storage-based, per-connection)
    this.slowlogPatternCount = this.createGauge(
      'slowlog_pattern_count',
      'Number of slow queries per pattern',
      ['pattern'],
    );
    this.slowlogPatternDuration = this.createGauge(
      'slowlog_pattern_avg_duration_us',
      'Average duration in microseconds per pattern',
      ['pattern'],
    );
    this.slowlogPatternPercentage = this.createGauge(
      'slowlog_pattern_percentage',
      'Percentage of slow queries per pattern',
      ['pattern'],
    );

    // COMMANDLOG (Valkey 8.1+) - storage-based, per-connection
    this.commandlogLargeRequestCount = this.createGauge(
      'commandlog_large_request',
      'Total large request entries',
    );
    this.commandlogLargeReplyCount = this.createGauge(
      'commandlog_large_reply',
      'Total large reply entries',
    );
    this.commandlogLargeRequestByPattern = this.createGauge(
      'commandlog_large_request_by_pattern',
      'Large request count by command pattern',
      ['pattern'],
    );
    this.commandlogLargeReplyByPattern = this.createGauge(
      'commandlog_large_reply_by_pattern',
      'Large reply count by command pattern',
      ['pattern'],
    );

    // Standard INFO - Server (per connection)
    this.uptimeInSeconds = this.createGauge('uptime_in_seconds', 'Server uptime in seconds');
    this.instanceInfo = this.createGauge('instance_info', 'Instance information (always 1)', [
      'version',
      'role',
      'os',
    ]);

    // Standard INFO - Clients (per connection)
    this.connectedClients = this.createGauge('connected_clients', 'Number of client connections');
    this.blockedClients = this.createGauge(
      'blocked_clients',
      'Clients blocked on BLPOP, BRPOP, etc',
    );
    this.trackingClients = this.createGauge(
      'tracking_clients',
      'Clients being tracked for client-side caching',
    );

    // Standard INFO - Memory (per connection)
    this.memoryUsedBytes = this.createGauge('memory_used_bytes', 'Total allocated memory in bytes');
    this.memoryUsedRssBytes = this.createGauge(
      'memory_used_rss_bytes',
      'RSS memory usage in bytes',
    );
    this.memoryUsedPeakBytes = this.createGauge(
      'memory_used_peak_bytes',
      'Peak memory usage in bytes',
    );
    this.memoryMaxBytes = this.createGauge(
      'memory_max_bytes',
      'Maximum memory limit in bytes (0 if unlimited)',
    );
    this.memoryFragmentationRatio = this.createGauge(
      'memory_fragmentation_ratio',
      'Memory fragmentation ratio',
    );
    this.memoryFragmentationBytes = this.createGauge(
      'memory_fragmentation_bytes',
      'Memory fragmentation in bytes',
    );

    // Standard INFO - Stats (per connection)
    this.connectionsReceivedTotal = this.createGauge(
      'connections_received_total',
      'Total connections received',
    );
    this.commandsProcessedTotal = this.createGauge(
      'commands_processed_total',
      'Total commands processed',
    );
    this.instantaneousOpsPerSec = this.createGauge(
      'instantaneous_ops_per_sec',
      'Current operations per second',
    );
    this.instantaneousInputKbps = this.createGauge(
      'instantaneous_input_kbps',
      'Current input kilobytes per second',
    );
    this.instantaneousOutputKbps = this.createGauge(
      'instantaneous_output_kbps',
      'Current output kilobytes per second',
    );
    this.keyspaceHitsTotal = this.createGauge('keyspace_hits_total', 'Total keyspace hits');
    this.keyspaceMissesTotal = this.createGauge('keyspace_misses_total', 'Total keyspace misses');
    this.evictedKeysTotal = this.createGauge('evicted_keys_total', 'Total evicted keys');
    this.expiredKeysTotal = this.createGauge('expired_keys_total', 'Total expired keys');
    this.pubsubChannels = this.createGauge('pubsub_channels', 'Number of pub/sub channels');
    this.pubsubPatterns = this.createGauge('pubsub_patterns', 'Number of pub/sub patterns');

    // Standard INFO - Replication (per connection)
    this.connectedSlaves = this.createGauge('connected_slaves', 'Number of connected replicas');
    this.replOutputBufferRatio = this.createGauge(
      'repl_output_buffer_ratio',
      'Replica output buffer size as a fraction of the client-output-buffer-limit slave hard limit',
      ['replica'],
    );
    this.replicationOffset = this.createGauge('replication_offset', 'Replication offset');
    this.masterLinkUp = this.createGauge(
      'master_link_up',
      '1 if link to master is up (replica only)',
    );
    this.masterLastIoSecondsAgo = this.createGauge(
      'master_last_io_seconds_ago',
      'Seconds since last I/O with master (replica only)',
    );

    // Keyspace Metrics (per connection, per database)
    this.dbKeys = this.createGauge('db_keys', 'Total keys in database', ['db']);
    this.dbKeysExpiring = this.createGauge('db_keys_expiring', 'Keys with expiration in database', [
      'db',
    ]);
    this.dbAvgTtlSeconds = this.createGauge('db_avg_ttl_seconds', 'Average TTL in seconds', ['db']);
    this.keyspaceKeys = this.createGauge('keyspace_keys', 'Total keys across all databases');
    this.keyspaceKeysExpiring = this.createGauge(
      'keyspace_keys_expiring',
      'Keys with an expiration across all databases',
    );
    this.rdbChangesSinceLastSave = this.createGauge(
      'rdb_changes_since_last_save',
      'Writes since the last RDB save',
    );
    this.rdbLastSaveTimestampSeconds = this.createGauge(
      'rdb_last_save_timestamp_seconds',
      'Unix time of the last successful RDB save',
    );
    this.rdbLastBgsaveOk = this.createGauge(
      'rdb_last_bgsave_ok',
      '1 if the last RDB background save succeeded',
    );
    this.aofEnabled = this.createGauge('aof_enabled', '1 if AOF persistence is enabled');
    this.aofLastBgrewriteOk = this.createGauge(
      'aof_last_bgrewrite_ok',
      '1 if the last AOF rewrite succeeded',
    );

    // Cluster Metrics (per connection)
    this.clusterEnabled = this.createGauge('cluster_enabled', '1 if cluster mode is enabled');
    this.clusterKnownNodes = this.createGauge(
      'cluster_known_nodes',
      'Number of known cluster nodes',
    );
    this.clusterSize = this.createGauge('cluster_size', 'Number of master nodes in cluster');
    this.clusterSlotsAssigned = this.createGauge(
      'cluster_slots_assigned',
      'Number of assigned slots',
    );
    this.clusterSlotsOk = this.createGauge('cluster_slots_ok', 'Number of slots in OK state');
    this.clusterSlotsFail = this.createGauge('cluster_slots_fail', 'Number of slots in FAIL state');
    this.clusterSlotsPfail = this.createGauge(
      'cluster_slots_pfail',
      'Number of slots in PFAIL state',
    );
    this.clusterStatsMessagesCrcMismatch = this.createGauge(
      'cluster_stats_messages_crc_mismatch',
      'Cluster bus messages rejected by the CRC integrity check (valkey#4201); any increase means on-wire corruption',
    );

    // Cluster Slot Metrics (Valkey 8.0+) - per connection, per slot
    this.clusterSlotKeys = this.createGauge('cluster_slot_keys', 'Keys in cluster slot', ['slot']);
    this.clusterSlotExpires = this.createGauge(
      'cluster_slot_expires',
      'Expiring keys in cluster slot',
      ['slot'],
    );
    this.clusterSlotReadsTotal = this.createGauge(
      'cluster_slot_reads_total',
      'Total reads for cluster slot',
      ['slot'],
    );
    this.clusterSlotWritesTotal = this.createGauge(
      'cluster_slot_writes_total',
      'Total writes for cluster slot',
      ['slot'],
    );

    // CPU Metrics (per connection)
    this.cpuSysSecondsTotal = this.createGauge(
      'cpu_sys_seconds_total',
      'System CPU consumed by the server',
    );
    this.cpuUserSecondsTotal = this.createGauge(
      'cpu_user_seconds_total',
      'User CPU consumed by the server',
    );

    // Slowlog Raw Metrics (per connection)
    this.slowlogLength = this.createGauge('slowlog_length', 'Current slowlog length');
    this.slowlogLastId = this.createGauge('slowlog_last_id', 'ID of last slowlog entry');

    // Vector Index Metrics (per connection, per index)
    this.vectorIndexDocs = this.createGauge(
      'vector_index_docs',
      'Current document count for a vector index',
      ['index'],
    );
    this.vectorIndexMemoryBytes = this.createGauge(
      'vector_index_memory_bytes',
      'Current memory usage for a vector index in bytes',
      ['index'],
    );
    this.vectorIndexFailures = this.createGauge(
      'vector_index_indexing_failures',
      'Cumulative hash_indexing_failures for a vector index',
      ['index'],
    );
    this.vectorIndexPercentIndexed = this.createGauge(
      'vector_index_percent_indexed',
      'Percent of documents indexed (0-100)',
      ['index'],
    );

    // Commandstats Metrics (per connection, per command)
    this.commandstatsCallsTotal = this.createGauge(
      'commandstats_calls_total',
      'Cumulative number of times a command has been executed (INFO commandstats.calls)',
      ['command'],
    );
    this.commandstatsLatencyUs = this.createGauge(
      'commandstats_latency_us',
      'Average command latency in microseconds (INFO commandstats.usec_per_call)',
      ['command'],
    );

    // Inference Latency Metrics (per connection, per bucket / per index)
    this.inferenceBucketP50Us = this.createGauge(
      'inference_bucket_p50_us',
      'p50 latency in microseconds for an inference bucket (FT.SEARCH:<index> | read | write)',
      ['bucket'],
    );
    this.inferenceBucketP95Us = this.createGauge(
      'inference_bucket_p95_us',
      'p95 latency in microseconds for an inference bucket',
      ['bucket'],
    );
    this.inferenceBucketP99Us = this.createGauge(
      'inference_bucket_p99_us',
      'p99 latency in microseconds for an inference bucket',
      ['bucket'],
    );
    this.inferenceUnhealthy = this.createGauge(
      'inference_unhealthy',
      'Whether an inference bucket is unhealthy (p50 > 10ms for FT.SEARCH buckets): 1 unhealthy, 0 healthy',
      ['bucket'],
    );
    this.inferenceSlaBreach = this.createGauge(
      'inference_sla_breach',
      'Whether the per-index p99 SLA is currently breached: 1 breached, 0 ok',
      ['index'],
    );

    // Poll Counter Metric (per connection)
    this.pollsTotal = new Counter({
      name: 'betterdb_polls_total',
      help: 'Total number of poll cycles completed',
      labelNames: ['connection'],
      registers: [this.registry],
    });
    this.pollStale = this.createGauge(
      'poll_stale',
      'Whether the connection has had no successful poll within the staleness bound: 1 stale, 0 fresh',
    );

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
    this.anomalyEventsCurrent = this.createGauge('anomaly_events_current', 'Unresolved anomalies', [
      'severity',
    ]);
    this.anomalyBySeverity = this.createGauge(
      'anomaly_by_severity',
      'Anomalies in last hour by severity',
      ['severity'],
    );
    this.anomalyByMetric = this.createGauge(
      'anomaly_by_metric',
      'Anomalies in last hour by metric',
      ['metric_type'],
    );
    this.correlatedGroupsBySeverity = this.createGauge(
      'correlated_groups_by_severity',
      'Groups in last hour by severity',
      ['severity'],
    );
    this.correlatedGroupsByPattern = this.createGauge(
      'correlated_groups_by_pattern',
      'Groups in last hour by pattern',
      ['pattern'],
    );
    this.anomalyDetectionBufferReady = this.createGauge(
      'anomaly_buffer_ready',
      'Buffer ready state (1=ready, 0=warming)',
      ['metric_type'],
    );
    this.anomalyDetectionBufferMean = this.createGauge(
      'anomaly_buffer_mean',
      'Rolling mean for anomaly detection',
      ['metric_type'],
    );
    this.anomalyDetectionBufferStdDev = this.createGauge(
      'anomaly_buffer_stddev',
      'Rolling stddev for anomaly detection',
      ['metric_type'],
    );

    // Metric Forecasting
    this.metricForecastTimeToLimitSeconds = this.createGauge(
      'metric_forecast_time_to_limit_seconds',
      'Projected seconds until metric reaches configured ceiling.',
      ['metric_kind'],
    );

    // CVE Detection (storage-based, per-connection)
    this.cveFindings = this.createGauge(
      'cve_findings',
      'Current CVE findings by severity from the latest scan',
      ['severity'],
    );
    this.cveKev = this.createGauge(
      'cve_kev',
      'Current KEV-exploited CVE findings from the latest scan',
    );
    this.cveDatasetStale = this.createGauge(
      'cve_dataset_stale',
      'Whether the CVE scan is partial or sources are missing: 1 stale, 0 ok',
    );

    // OTLP Ingest Metrics
    this.otlpPointsAccepted = new Counter({
      name: 'betterdb_otlp_metric_points_accepted_total',
      help: 'OTLP metric data points accepted into external connections',
      registers: [this.registry],
    });
    this.otlpPointsDropped = new Counter({
      name: 'betterdb_otlp_metric_points_dropped_total',
      help: 'OTLP metric data points dropped, by reason',
      labelNames: ['reason'],
      registers: [this.registry],
    });
  }

  recordOtlpIngest(accepted: number, droppedByReason: Partial<Record<DropReason, number>>): void {
    if (accepted > 0) this.otlpPointsAccepted.inc(accepted);
    for (const [reason, count] of Object.entries(droppedByReason)) {
      if (count && count > 0) this.otlpPointsDropped.inc({ reason }, count);
    }
  }

  /**
   * Update metrics for ALL registered connections (used by /metrics endpoint).
   */
  async updateMetrics(): Promise<void> {
    const connections = this.connectionRegistry.list();
    const connectedConnections = connections.filter((c) => c.isConnected);

    // Update both INFO-based and storage-based metrics for all connections.
    // Connections refresh concurrently so a wedged node costs the pass one
    // bounded read instead of one per connection.
    await Promise.allSettled(
      connectedConnections.map(async (conn) => {
        try {
          const epoch = await this.updateMetricsForConnection(conn.id);
          await this.updateStorageBasedMetricsForConnection(conn.id, epoch);
        } catch (error) {
          this.logger.warn(
            `Failed to update metrics for connection ${conn.name}: ${error instanceof Error ? error.message : 'Unknown'}`,
          );
        }
      }),
    );
  }

  /**
   * Update storage-based metrics for a specific connection
   */
  private async updateStorageBasedMetricsForConnection(
    connectionId: string,
    epoch: number = this.currentEpoch(connectionId),
  ): Promise<void> {
    if (this.isSuperseded(connectionId, epoch)) {
      return;
    }
    if (this.freshness.isStale(connectionId, Date.now())) {
      return;
    }

    const connLabel = this.getConnectionLabel(connectionId);
    const state = this.getConnectionState(connectionId);

    await this.updateAclMetrics(connectionId, connLabel, state, epoch);
    if (this.isSuperseded(connectionId, epoch)) return;
    await this.updateClientMetrics(connectionId, connLabel, state, epoch);
    if (this.isSuperseded(connectionId, epoch)) return;
    await this.updateSlowlogMetrics(connectionId, connLabel, state);
    if (this.isSuperseded(connectionId, epoch)) return;
    await this.updateCommandlogMetrics(connectionId, connLabel, state);
    if (this.isSuperseded(connectionId, epoch)) return;
    await this.updateMetricForecastMetrics(connectionId, connLabel, epoch);
    if (this.isSuperseded(connectionId, epoch)) return;
    await this.updateCveMetrics(connectionId, connLabel);
  }

  private async updateCveMetrics(connectionId: string, connLabel: string): Promise<void> {
    const state = this.getConnectionState(connectionId);
    const now = Date.now();
    if (isCveEnabled() === false) {
      if (state.lastCveConnLabel) {
        this.removeCveSeries(state.lastCveConnLabel);
        state.lastCveConnLabel = null;
      } else {
        this.removeCveSeries(connLabel);
      }
      state.lastCveFingerprint = null;
      state.lastCveCheckAt = 0;
      state.lastCveCheckedLabel = null;
      return;
    }
    // Re-addressing a connection orphans the old host:port series: drop it
    // before exporting under the new label.
    if (state.lastCveConnLabel && state.lastCveConnLabel !== connLabel) {
      this.removeCveSeries(state.lastCveConnLabel);
      state.lastCveConnLabel = null;
      state.lastCveFingerprint = null;
      state.lastCveCheckAt = 0;
    }
    if (
      state.lastCveCheckedLabel === connLabel &&
      now - state.lastCveCheckAt < PrometheusService.CVE_METRICS_REFRESH_MS
    ) {
      return;
    }
    state.lastCveCheckAt = now;
    state.lastCveCheckedLabel = connLabel;
    try {
      const scan = await this.storage.getCveScanResult(connectionId);

      if (this.perConnectionState.get(connectionId) !== state) {
        return;
      }
      if (this.getConnectionLabel(connectionId) !== connLabel) {
        return;
      }
      if (!scan) {
        // No scan yet: drop any previously exported series so a deleted or
        // never-scanned connection does not page forever on stale values.
        if (state.lastCveConnLabel) {
          this.removeCveSeries(state.lastCveConnLabel);
          state.lastCveConnLabel = null;
        } else {
          this.removeCveSeries(connLabel);
        }
        state.lastCveFingerprint = null;
        return;
      }
      if (
        state.lastCveFingerprint === scan.fingerprint &&
        state.lastCveConnLabel === connLabel
      ) {
        return;
      }
      const totals = { critical: 0, high: 0, medium: 0, low: 0 };
      let kev = 0;
      for (const node of scan.nodes) {
        totals.critical += node.severityCounts.critical;
        totals.high += node.severityCounts.high;
        totals.medium += node.severityCounts.medium;
        totals.low += node.severityCounts.low;
        for (const finding of node.findings) {
          if (finding.advisory.knownExploited === true) {
            kev += 1;
          }
        }
      }
      for (const severity of ['critical', 'high', 'medium', 'low'] as const) {
        this.cveFindings.labels(connLabel, severity).set(totals[severity]);
      }
      this.cveKev.labels(connLabel).set(kev);
      const missingSources = scan.missingSources?.length ?? 0;
      this.cveDatasetStale
        .labels(connLabel)
        .set(scan.partial || missingSources > 0 ? 1 : 0);
      state.lastCveConnLabel = connLabel;
      state.lastCveFingerprint = scan.fingerprint;
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.debug(`CVE metrics scrape skipped for ${connectionId}: ${reason}`);
    }
  }

  /**
   * Drop all CVE gauge children for a connection label so removed or
   * re-addressed connections stop exporting (and alerting on) stale values.
   */
  private removeCveSeries(connLabel: string): void {
    try {
      for (const severity of ['critical', 'high', 'medium', 'low'] as const) {
        this.cveFindings.remove(connLabel, severity);
      }
      this.cveKev.remove(connLabel);
      this.cveDatasetStale.remove(connLabel);
    } catch {
      // Best effort: a missing child must never fail a scrape.
    }
  }

  private async updateMetricForecastMetrics(
    connectionId: string,
    connLabel: string,
    epoch: number = this.currentEpoch(connectionId),
  ): Promise<void> {
    if (!this.metricForecastingService) return;

    // Only export metrics for metric kinds that already have settings configured.
    // Avoids auto-provisioning settings rows as a side effect of Prometheus scraping.
    for (const metricKind of ALL_METRIC_KINDS) {
      try {
        const settings = await this.storage.getMetricForecastSettings(connectionId, metricKind);
        if (this.isSuperseded(connectionId, epoch)) {
          return;
        }
        if (!settings || !settings.enabled) {
          this.metricForecastTimeToLimitSeconds.remove(connLabel, metricKind);
          continue;
        }

        const forecast = await this.metricForecastingService.getForecast(connectionId, metricKind);
        if (this.isSuperseded(connectionId, epoch)) {
          return;
        }
        if (forecast.ceiling === null || !forecast.enabled) {
          this.metricForecastTimeToLimitSeconds.remove(connLabel, metricKind);
          continue;
        }

        if (!forecast.insufficientData) {
          if (forecast.timeToLimitMs !== null) {
            this.metricForecastTimeToLimitSeconds
              .labels(connLabel, metricKind)
              .set(forecast.timeToLimitMs / 1000);
          } else {
            // Stable/falling — remove label to avoid stale or sentinel values in Prometheus
            this.metricForecastTimeToLimitSeconds.remove(connLabel, metricKind);
          }
        }
      } catch (err) {
        this.logger.debug(
          `Metric forecast scrape skipped for ${connectionId}:${metricKind}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * Update all INFO-based metrics for a specific connection
   */
  /**
   * Coalesces concurrent INFO-based metric updates for the SAME connection onto
   * one in-flight pass. Two independent entry points reach here — the background
   * poller (pollConnection) and the /metrics scrape (updateMetrics) — so without
   * this a poll and a scrape could run getClusterInfo() concurrently for one
   * connection; an older response completing last would move
   * state.previousCrcMismatch backward and re-emit the same cluster.bus.corruption
   * delta on the next poll. Serializing per connection (the granularity of the
   * shared state) closes that race for both paths.
   */
  private updateMetricsForConnection(connectionId: string): Promise<number> {
    const existing = this.updateMetricsInFlight.get(connectionId);
    if (existing !== undefined) {
      return existing;
    }
    // The read is bounded here rather than at the call sites so that a hung
    // INFO releases its in-flight entry when the bound expires; otherwise the
    // entry would outlive every later pass and no connection would ever be
    // re-read. Starting a pass retires the previous epoch, so a reply that
    // arrives after the bound cannot write metrics behind a newer pass.
    this.retireEpoch(connectionId);
    const epoch = this.currentEpoch(connectionId);
    const run: Promise<number> = this.readWithTimeout(
      this.runUpdateMetricsForConnection(connectionId, epoch),
      this.pollIntervalMs,
      `INFO update for ${connectionId}`,
    )
      .then(() => epoch)
      .finally(() => {
        // Compare-and-delete: only clear the entry if it is still ours. If the
        // connection was removed (cleanupConnectionMetrics) or re-added with a
        // fresh in-flight update while this one ran, we must not evict that newer
        // entry when this stale promise settles.
        if (this.updateMetricsInFlight.get(connectionId) === run) {
          this.updateMetricsInFlight.delete(connectionId);
        }
      });
    this.updateMetricsInFlight.set(connectionId, run);
    return run;
  }

  private readInfo(connectionId: string, client: DatabasePort): Promise<InfoResponse> {
    const outstanding = this.infoReadsInFlight.get(connectionId);
    if (outstanding !== undefined) {
      return outstanding;
    }
    const read = client.getInfoParsed();
    const release = (): void => {
      if (this.infoReadsInFlight.get(connectionId) === read) {
        this.infoReadsInFlight.delete(connectionId);
      }
    };
    read.then(release, release);
    this.infoReadsInFlight.set(connectionId, read);
    return read;
  }

  private currentEpoch(connectionId: string): number {
    return this.connectionEpochs.get(connectionId) ?? 0;
  }

  private retireEpoch(connectionId: string): void {
    this.connectionEpochs.set(connectionId, this.currentEpoch(connectionId) + 1);
  }

  private isSuperseded(connectionId: string, epoch: number): boolean {
    return this.currentEpoch(connectionId) !== epoch;
  }

  private async runUpdateMetricsForConnection(
    connectionId: string,
    epoch: number = this.currentEpoch(connectionId),
  ): Promise<void> {
    const client = this.connectionRegistry.get(connectionId);
    if (!client) {
      this.logger.warn(`No client for connection ${connectionId}, skipping metrics`);
      return;
    }

    const connLabel = this.getConnectionLabel(connectionId);
    const state = this.getConnectionState(connectionId);
    const config = this.connectionRegistry.getConfig(connectionId);
    const external = config?.connectionType === 'external';
    const absentAsZero = !external;
    this.freshness.observe(connectionId, connLabel, Date.now());

    try {
      const info = await this.readInfo(connectionId, client);
      // A reply is evidence the connection is alive even when this pass no
      // longer owns the metrics, and markFresh only updates a connection the
      // tracker still knows under this same label — so a removed one stays
      // removed and an ID reused for another host keeps its own label.
      this.freshness.markFresh(connectionId, connLabel, Date.now());
      // The connection may have been removed, or this pass superseded by a
      // newer one, while the read was outstanding. Writing now would recreate
      // series cleanup has already dropped and move shared per-connection
      // state behind a newer pass.
      if (this.isSuperseded(connectionId, epoch)) {
        return;
      }

      this.updateServerMetrics(info, connLabel, state, absentAsZero);
      this.updateClientInfoMetrics(info, connLabel, connectionId, config, absentAsZero);
      this.updateMemoryMetrics(info, connLabel, connectionId, config, absentAsZero);
      this.updateStatsMetrics(info, connLabel, absentAsZero);
      this.updateCpuMetrics(info, connLabel, absentAsZero);
      this.updatePersistenceMetrics(info, connLabel, absentAsZero);
      this.updateReplicationMetrics(info, connLabel, connectionId, config, absentAsZero);
      this.updateKeyspaceMetricsFromInfo(info, connLabel, state, absentAsZero);
      if (external) {
        return;
      }
      await this.updateClusterMetricsFromInfo(
        client,
        info,
        connLabel,
        connectionId,
        state,
        config,
        epoch,
      );
      if (this.isSuperseded(connectionId, epoch)) {
        return;
      }
      await this.updateSlowlogRawMetrics(connLabel, connectionId, config, epoch);
    } catch (error) {
      this.logger.error(`Failed to update INFO-based metrics for ${connLabel}`, error);
    }
  }

  private updateServerMetrics(
    info: InfoResponse,
    connLabel: string,
    state: ConnectionMetricState,
    absentAsZero: boolean,
  ): void {
    if (!info.server) {
      if (!absentAsZero) {
        this.uptimeInSeconds.remove(connLabel);
        if (state.instanceInfoLabels) {
          this.instanceInfo.remove(connLabel, ...state.instanceInfoLabels);
          state.instanceInfoLabels = null;
        }
      }
      return;
    }

    const version = info.server.valkey_version || info.server.redis_version || 'unknown';
    const role = info.replication?.role || 'unknown';
    const os = info.server.os || 'unknown';
    const previous = state.instanceInfoLabels;
    if (previous && (previous[0] !== version || previous[1] !== role || previous[2] !== os)) {
      this.instanceInfo.remove(connLabel, ...previous);
    }
    state.instanceInfoLabels = [version, role, os];

    this.setInfoGauge(this.uptimeInSeconds, connLabel, info.server.uptime_in_seconds, absentAsZero);
    this.instanceInfo.labels(connLabel, version, role, os).set(1);
  }

  private readInfoNumber(
    raw: string | undefined,
    absentAsZero: boolean,
    parse: (raw: string) => number = parseInt,
  ): number | null {
    const value = raw === undefined ? NaN : parse(raw);
    if (Number.isNaN(value)) {
      return absentAsZero ? 0 : null;
    }
    return value;
  }

  private setOrRemove(gauge: Gauge, connLabel: string, value: number | null): void {
    if (value === null) {
      gauge.remove(connLabel);
      return;
    }
    gauge.labels(connLabel).set(value);
  }

  private setInfoGauge(
    gauge: Gauge,
    connLabel: string,
    raw: string | undefined,
    absentAsZero: boolean,
    parse: (raw: string) => number = parseInt,
  ): void {
    this.setOrRemove(gauge, connLabel, this.readInfoNumber(raw, absentAsZero, parse));
  }

  private setInfoFlag(
    gauge: Gauge,
    connLabel: string,
    raw: string | undefined,
    expected: string,
    absentAsZero: boolean,
  ): void {
    if (raw === undefined && !absentAsZero) {
      gauge.remove(connLabel);
      return;
    }
    gauge.labels(connLabel).set(raw === expected ? 1 : 0);
  }

  private setPresentInfoGauge(
    gauge: Gauge,
    connLabel: string,
    raw: string | undefined,
    absentAsZero: boolean,
  ): void {
    if (raw) {
      gauge.labels(connLabel).set(parseInt(raw) || 0);
    } else if (!absentAsZero) {
      gauge.remove(connLabel);
    }
  }

  private infoSection<T>(section: T | undefined, absentAsZero: boolean): Partial<T> | undefined {
    return section ?? (absentAsZero ? undefined : {});
  }

  private updateClientInfoMetrics(
    info: InfoResponse,
    connLabel: string,
    connectionId: string,
    _config: { host: string; port: number } | null,
    absentAsZero: boolean,
  ): void {
    const clients = this.infoSection(info.clients, absentAsZero);
    if (!clients) return;

    const connectedClients = this.readInfoNumber(clients.connected_clients, absentAsZero);
    const maxClients = absentAsZero
      ? parseInt(clients.maxclients ?? '') || 10000
      : this.readInfoNumber(clients.maxclients, false);

    this.setOrRemove(this.connectedClients, connLabel, connectedClients);
    this.setInfoGauge(this.blockedClients, connLabel, clients.blocked_clients, absentAsZero);
    this.setPresentInfoGauge(
      this.trackingClients,
      connLabel,
      clients.tracking_clients,
      absentAsZero,
    );

    // Webhook dispatch for connection.critical
    if (
      this.webhookDispatcher &&
      connectedClients !== null &&
      maxClients !== null &&
      maxClients > 0
    ) {
      const usedPercent = (connectedClients / maxClients) * 100;
      this.webhookDispatcher
        .dispatchThresholdAlertPerWebhook(
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
          connectionId,
        )
        .catch((err) => {
          this.logger.error('Failed to dispatch connection.critical webhook', err);
        });
    }
  }

  private updateMemoryMetrics(
    info: InfoResponse,
    connLabel: string,
    connectionId: string,
    config: { host: string; port: number } | null,
    absentAsZero: boolean,
  ): void {
    const memory = this.infoSection(info.memory, absentAsZero);
    if (!memory) return;

    const memoryUsed = this.readInfoNumber(memory.used_memory, absentAsZero);
    const maxMemory = this.readInfoNumber(memory.maxmemory, absentAsZero);
    const maxmemoryPolicy = memory.maxmemory_policy || 'noeviction';

    this.setOrRemove(this.memoryUsedBytes, connLabel, memoryUsed);
    this.setInfoGauge(this.memoryUsedRssBytes, connLabel, memory.used_memory_rss, absentAsZero);
    this.setInfoGauge(this.memoryUsedPeakBytes, connLabel, memory.used_memory_peak, absentAsZero);
    this.setOrRemove(this.memoryMaxBytes, connLabel, maxMemory);
    this.setInfoGauge(
      this.memoryFragmentationRatio,
      connLabel,
      memory.mem_fragmentation_ratio,
      absentAsZero,
      parseFloat,
    );
    this.setInfoGauge(
      this.memoryFragmentationBytes,
      connLabel,
      memory.mem_fragmentation_bytes,
      absentAsZero,
    );

    if (this.webhookDispatcher && memoryUsed !== null && maxMemory !== null && maxMemory > 0) {
      const usedPercent = (memoryUsed / maxMemory) * 100;

      this.webhookDispatcher
        .dispatchThresholdAlertPerWebhook(
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
          connectionId,
        )
        .catch((err) => {
          this.logger.error('Failed to dispatch memory.critical webhook', err);
        });

      // Compliance alert for enterprise tier. OTLP mirrors the webhook's edge
      // semantics: dispatchComplianceAlert resolves true only when the alert
      // edge fired (hysteresis) and the license tier allows it.
      if (
        usedPercent > 80 &&
        maxmemoryPolicy === 'noeviction' &&
        this.webhookEventsEnterpriseService
      ) {
        this.webhookEventsEnterpriseService
          .dispatchComplianceAlert({
            complianceType: 'data_retention',
            severity: 'high',
            memoryUsedPercent: usedPercent,
            maxmemoryPolicy,
            message: `Compliance alert: Memory at ${usedPercent.toFixed(1)}% with 'noeviction' policy may cause data loss and violate retention policies`,
            timestamp: Date.now(),
            instance: { host: config?.host || 'localhost', port: config?.port || 6379 },
            connectionId,
          })
          .then((fired) => {
            if (fired) {
              this.otelEvents?.dispatch(
                WebhookEventType.COMPLIANCE_ALERT,
                { memoryUsedPercent: usedPercent, maxmemoryPolicy, severity: 'high' },
                connectionId,
              );
            }
          })
          .catch((err) => {
            this.logger.error('Failed to dispatch compliance.alert webhook', err);
          });
      }
    }
  }

  private updateStatsMetrics(info: InfoResponse, connLabel: string, absentAsZero: boolean): void {
    const stats = this.infoSection(info.stats, absentAsZero);
    if (!stats) return;

    const set = (gauge: Gauge, raw: string | undefined, parse?: (raw: string) => number) =>
      this.setInfoGauge(gauge, connLabel, raw, absentAsZero, parse);
    set(this.connectionsReceivedTotal, stats.total_connections_received);
    set(this.commandsProcessedTotal, stats.total_commands_processed);
    set(this.instantaneousOpsPerSec, stats.instantaneous_ops_per_sec);
    set(this.instantaneousInputKbps, stats.instantaneous_input_kbps, parseFloat);
    set(this.instantaneousOutputKbps, stats.instantaneous_output_kbps, parseFloat);
    set(this.keyspaceHitsTotal, stats.keyspace_hits);
    set(this.keyspaceMissesTotal, stats.keyspace_misses);
    set(this.evictedKeysTotal, stats.evicted_keys);
    set(this.expiredKeysTotal, stats.expired_keys);
    set(this.pubsubChannels, stats.pubsub_channels);
    set(this.pubsubPatterns, stats.pubsub_patterns);
  }

  private updateCpuMetrics(info: InfoResponse, connLabel: string, absentAsZero: boolean): void {
    const cpu = this.infoSection(info.cpu, absentAsZero);
    if (!cpu) return;

    this.setInfoGauge(
      this.cpuSysSecondsTotal,
      connLabel,
      cpu.used_cpu_sys,
      absentAsZero,
      parseFloat,
    );
    this.setInfoGauge(
      this.cpuUserSecondsTotal,
      connLabel,
      cpu.used_cpu_user,
      absentAsZero,
      parseFloat,
    );
  }

  private updatePersistenceMetrics(
    info: InfoResponse,
    connLabel: string,
    absentAsZero: boolean,
  ): void {
    const persistence = this.infoSection(info.persistence, absentAsZero);
    if (!persistence) return;

    this.setInfoGauge(
      this.rdbChangesSinceLastSave,
      connLabel,
      persistence.rdb_changes_since_last_save,
      absentAsZero,
    );
    this.setInfoGauge(
      this.rdbLastSaveTimestampSeconds,
      connLabel,
      persistence.rdb_last_save_time,
      absentAsZero,
    );
    this.setInfoFlag(
      this.rdbLastBgsaveOk,
      connLabel,
      persistence.rdb_last_bgsave_status,
      'ok',
      absentAsZero,
    );
    this.setInfoFlag(this.aofEnabled, connLabel, persistence.aof_enabled, '1', absentAsZero);
    this.setInfoFlag(
      this.aofLastBgrewriteOk,
      connLabel,
      persistence.aof_last_bgrewrite_status,
      'ok',
      absentAsZero,
    );
  }

  private updateReplicationMetrics(
    info: InfoResponse,
    connLabel: string,
    connectionId: string,
    config: { host: string; port: number } | null,
    absentAsZero: boolean,
  ): void {
    const replication = info.replication;
    const role = replication?.role;
    const isReplica = role === 'slave' || role === 'replica';

    if (replication === undefined || (role !== 'master' && !isReplica)) {
      this.clearRoleSpecificReplicationSeries(connLabel);
      if (!absentAsZero) {
        this.replicationOffset.remove(connLabel);
      }
      return;
    }

    if (role === 'master') {
      this.masterLinkUp.remove(connLabel);
      this.masterLastIoSecondsAgo.remove(connLabel);
      this.setInfoGauge(
        this.connectedSlaves,
        connLabel,
        replication.connected_slaves,
        absentAsZero,
      );
      this.setPresentInfoGauge(
        this.replicationOffset,
        connLabel,
        replication.master_repl_offset,
        absentAsZero,
      );
    } else {
      this.connectedSlaves.remove(connLabel);
      const masterLinkStatus = replication.master_link_status;
      this.setInfoFlag(this.masterLinkUp, connLabel, masterLinkStatus, 'up', absentAsZero);

      const lastIoSecondsAgo = this.readInfoNumber(
        replication.master_last_io_seconds_ago,
        absentAsZero,
      );
      this.setPresentInfoGauge(
        this.masterLastIoSecondsAgo,
        connLabel,
        replication.master_last_io_seconds_ago,
        absentAsZero,
      );

      this.setPresentInfoGauge(
        this.replicationOffset,
        connLabel,
        replication.slave_repl_offset,
        absentAsZero,
      );

      // Webhook dispatch for replication.lag
      if (this.webhookEventsProService && masterLinkStatus === 'up' && lastIoSecondsAgo !== null) {
        this.webhookEventsProService
          .dispatchReplicationLag({
            lagSeconds: lastIoSecondsAgo,
            threshold: 10,
            masterLinkStatus,
            timestamp: Date.now(),
            instance: { host: config?.host || 'localhost', port: config?.port || 6379 },
            connectionId,
          })
          .catch((err) => {
            this.logger.error('Failed to dispatch replication.lag webhook', err);
          });
      }
    }
  }

  private clearRoleSpecificReplicationSeries(connLabel: string): void {
    this.connectedSlaves.remove(connLabel);
    this.masterLinkUp.remove(connLabel);
    this.masterLastIoSecondsAgo.remove(connLabel);
  }

  private updateKeyspaceMetricsFromInfo(
    info: InfoResponse,
    connLabel: string,
    state: ConnectionMetricState,
    absentAsZero: boolean,
  ): void {
    const keyspace = this.infoSection(info.keyspace, absentAsZero);
    if (!keyspace) return;

    const newDbLabels = new Set<string>();
    let totalKeys = 0;
    let totalExpiring = 0;

    for (const [dbKey, dbInfo] of Object.entries(keyspace as Record<string, unknown>)) {
      // parseInfoToTyped emits typed objects for db* entries; anything still
      // a string is a non-db or unparseable line.
      if (!dbInfo || typeof dbInfo !== 'object') continue;
      newDbLabels.add(dbKey);

      const parsedInfo = dbInfo as { keys: number; expires: number; avg_ttl: number };
      this.dbKeys.labels(connLabel, dbKey).set(parsedInfo.keys || 0);
      this.dbKeysExpiring.labels(connLabel, dbKey).set(parsedInfo.expires || 0);
      this.dbAvgTtlSeconds.labels(connLabel, dbKey).set((parsedInfo.avg_ttl || 0) / 1000);
      totalKeys += parsedInfo.keys || 0;
      totalExpiring += parsedInfo.expires || 0;
    }

    const hasTotals = absentAsZero || newDbLabels.size > 0;
    this.setOrRemove(this.keyspaceKeys, connLabel, hasTotals ? totalKeys : null);
    this.setOrRemove(this.keyspaceKeysExpiring, connLabel, hasTotals ? totalExpiring : null);

    // Remove stale db labels for this connection
    for (const staleDb of state.currentKeyspaceDbLabels) {
      if (!newDbLabels.has(staleDb)) {
        if (absentAsZero) {
          this.dbKeys.labels(connLabel, staleDb).set(0);
          this.dbKeysExpiring.labels(connLabel, staleDb).set(0);
          this.dbAvgTtlSeconds.labels(connLabel, staleDb).set(0);
        } else {
          this.dbKeys.remove(connLabel, staleDb);
          this.dbKeysExpiring.remove(connLabel, staleDb);
          this.dbAvgTtlSeconds.remove(connLabel, staleDb);
        }
      }
    }

    state.currentKeyspaceDbLabels = newDbLabels;
  }

  private async updateClusterMetricsFromInfo(
    client: DatabasePort,
    info: InfoResponse,
    connLabel: string,
    connectionId: string,
    state: ConnectionMetricState,
    config: { host: string; port: number } | null,
    epoch: number = this.currentEpoch(connectionId),
  ): Promise<void> {
    const clusterEnabled = info.cluster?.cluster_enabled === '1';
    this.clusterEnabled.labels(connLabel).set(clusterEnabled ? 1 : 0);

    if (!clusterEnabled) {
      this.clearSlotSeries(connLabel, state);
      return;
    }

    if (!this.runtimeCapabilityTracker.isAvailable(connectionId, 'canClusterInfo')) {
      this.clearSlotSeries(connLabel, state);
      return;
    }

    try {
      const clusterInfo = await client.getClusterInfo();
      if (this.isSuperseded(connectionId, epoch)) {
        return;
      }

      const clusterState = clusterInfo.cluster_state;
      const slotsFail = parseInt(clusterInfo.cluster_slots_fail) || 0;

      if (clusterInfo.cluster_known_nodes) {
        this.clusterKnownNodes
          .labels(connLabel)
          .set(parseInt(clusterInfo.cluster_known_nodes) || 0);
      }
      if (clusterInfo.cluster_size) {
        this.clusterSize.labels(connLabel).set(parseInt(clusterInfo.cluster_size) || 0);
      }
      if (clusterInfo.cluster_slots_assigned) {
        this.clusterSlotsAssigned
          .labels(connLabel)
          .set(parseInt(clusterInfo.cluster_slots_assigned) || 0);
      }
      if (clusterInfo.cluster_slots_ok) {
        this.clusterSlotsOk.labels(connLabel).set(parseInt(clusterInfo.cluster_slots_ok) || 0);
      }
      if (clusterInfo.cluster_slots_fail) {
        this.clusterSlotsFail.labels(connLabel).set(slotsFail);
      }
      if (clusterInfo.cluster_slots_pfail) {
        this.clusterSlotsPfail
          .labels(connLabel)
          .set(parseInt(clusterInfo.cluster_slots_pfail) || 0);
      }

      // Cluster-bus CRC integrity (valkey#4201). The field is only present on
      // builds shipping the check with `cluster-crc-enabled` on; a "0" value is
      // still truthy, so an absent field (undefined) is the only skipped case.
      const crcRaw = clusterInfo.cluster_stats_messages_crc_mismatch;
      if (!crcRaw) {
        // Field gone (check disabled or counter no longer reported). Drop the
        // baseline so a later re-appearance re-seeds from its first value rather
        // than diffing against a stale pre-gap baseline and firing a false delta,
        // and remove the gauge child so Prometheus stops exporting the last value
        // as if it were current.
        state.previousCrcMismatch = null;
        this.clusterStatsMessagesCrcMismatch.remove(connLabel);
      }
      if (crcRaw) {
        const crcMismatch = parseInt(crcRaw) || 0;
        this.clusterStatsMessagesCrcMismatch.labels(connLabel).set(crcMismatch);

        // Any increase means the bus rejected a corrupted gossip/message (bit
        // flip, bad NIC/switch). A single bogus configEpoch can permanently
        // scramble slot ownership (valkey#4201/#4092), so we surface any nonzero
        // delta rather than a threshold. The first observation seeds the baseline
        // so a pre-existing counter value does not fire on startup.
        // Advance the baseline before any await so an overlapping poll cannot read
        // the old value and re-dispatch the same delta.
        const previousCrcMismatch = state.previousCrcMismatch;
        state.previousCrcMismatch = crcMismatch;

        if (previousCrcMismatch !== null && crcMismatch > previousCrcMismatch) {
          const crcMismatchDelta = crcMismatch - previousCrcMismatch;
          const knownNodes = parseInt(clusterInfo.cluster_known_nodes) || 0;

          // OTLP mirror is decoupled from the Pro webhook gate (parity with
          // cluster.failover), so an OTLP-only deployment still sees corruption.
          try {
            this.otelEvents?.dispatch(
              WebhookEventType.CLUSTER_BUS_CORRUPTION,
              { crcMismatchTotal: crcMismatch, crcMismatchDelta, knownNodes },
              connectionId,
            );
          } catch (err) {
            this.logger.error('Failed to dispatch cluster.bus.corruption OTLP event', err);
          }

          if (this.webhookEventsProService) {
            try {
              await this.webhookEventsProService.dispatchClusterBusCorruption({
                crcMismatchTotal: crcMismatch,
                crcMismatchDelta,
                knownNodes,
                timestamp: Date.now(),
                instance: { host: config?.host || 'localhost', port: config?.port || 6379 },
                connectionId,
              });
            } catch (err) {
              this.logger.error('Failed to dispatch cluster.bus.corruption webhook', err);
            }
          }
        }
      }

      // cluster.failover: detect the edge, mirror to OTLP, and advance the
      // tracked state independent of webhook wiring, so an OTLP-only deployment
      // (no Pro webhook service) still sees failover — parity with the
      // instance.down / instance.up availability edges. Only the webhook dispatch
      // itself is gated on the Pro service being present.
      const previousClusterState = state.previousClusterState;
      const stateChanged = previousClusterState === 'ok' && clusterState === 'fail';
      const newSlotFailures = state.previousSlotsFail < slotsFail && slotsFail > 0;

      // Both edges above read CLUSTER INFO, so they only see a cluster-wide
      // outage. A clean master-replica failover leaves cluster_state:ok with no
      // failed slots and produces nothing — and that is the common case under
      // load and during rolling upgrades (valkey#4340). Diff the topology too.
      let topology: TopologySnapshot | null = null;
      let topologyDiff: TopologyDiff | null = null;
      let topologyReasons: string[] = [];
      let changedNodes: Array<{ nodeId: string; reason: string; from: string; to: string }> = [];
      try {
        topology = snapshotTopology(await client.getClusterNodes());
        topologyDiff = diffClusterTopology(state.previousTopology, topology);
        topologyReasons = topologyDiff.reasons;
        changedNodes = topologyDiff.changedNodes;
      } catch (err) {
        // CLUSTER NODES can be denied or fail independently of CLUSTER INFO.
        // Losing the topology signal must not take metric scraping down with
        // it, and must not reset the baseline — keeping the last good snapshot
        // means the next successful read still sees the change.
        this.logger.debug(
          `CLUSTER NODES failed for ${connectionId}: ${err instanceof Error ? err.message : err}`,
        );
      }

      if (this.isSuperseded(connectionId, epoch)) {
        return;
      }

      // One dispatch per poll no matter how many signals fired: a real outage
      // trips the CLUSTER INFO edges and churns the topology at the same time,
      // and two events for one failover would double-page.
      const reasons: string[] = [];
      if (stateChanged) {
        reasons.push('cluster_state');
      }
      if (newSlotFailures) {
        reasons.push('slot_failures');
      }
      reasons.push(...topologyReasons);

      // Advance the baseline before the dispatches, the way the CRC edge does:
      // a pass abandoned at its bound mid-dispatch has already emitted the
      // event, and leaving the edge uncommitted would page again next poll.
      state.previousClusterState = clusterState;
      state.previousSlotsFail = slotsFail;
      if (topology !== null) {
        state.previousTopology = topology;
      }
      const demotionCheckedAt = Date.now();
      if (topologyDiff !== null) {
        recordDemotions(state.demotionWatch, topologyDiff, demotionCheckedAt);
      }
      pruneDemotionWatch(state.demotionWatch, topology, demotionCheckedAt);

      if (reasons.length > 0) {
        // OTLP mirror is decoupled from the Pro webhook gate (the dispatcher
        // no-ops unless OTEL_* is set).
        try {
          // Serialized, not passed raw: buildEventAttributes keeps scalars only,
          // so an array lands as nothing at all and the event arrives saying
          // `ok` with no reason — the exact gap `reasons` exists to close.
          this.otelEvents?.dispatch(
            WebhookEventType.CLUSTER_FAILOVER,
            {
              clusterState,
              slotsFailed: slotsFail,
              knownNodes: parseInt(clusterInfo.cluster_known_nodes) || 0,
              reasons: reasons.join(','),
              ...(changedNodes.length > 0 ? { changedNodes: JSON.stringify(changedNodes) } : {}),
            },
            connectionId,
          );
        } catch (err) {
          this.logger.error('Failed to dispatch cluster.failover OTLP event', err);
        }

        if (this.webhookEventsProService) {
          try {
            await this.webhookEventsProService.dispatchClusterFailover({
              clusterState,
              previousState: previousClusterState ?? undefined,
              reasons,
              changedNodes,
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
      }

      // cluster.demoted.writes: the failover above is over, but the node it
      // demoted may not know yet. While it still answers `role:master` it keeps
      // accepting writes for slots it no longer owns, and those writes are
      // discarded the moment the client's slot cache refreshes — silently.
      await this.detectDemotedMasterWrites(connectionId, state, config, epoch);

      await this.updateSlotStatsMetrics(client, connectionId, connLabel, state, epoch);
    } catch (error) {
      const disabled = this.runtimeCapabilityTracker.recordFailure(
        connectionId,
        'canClusterInfo',
        error instanceof Error ? error : String(error),
      );
      if (disabled && !this.isSuperseded(connectionId, epoch)) {
        this.clearSlotSeries(connLabel, state);
      }
      this.logger.error(`Failed to update cluster metrics for ${connLabel}`, error);
    }
  }

  private async updateSlotStatsMetrics(
    client: DatabasePort,
    connectionId: string,
    connLabel: string,
    state: ConnectionMetricState,
    epoch: number,
  ): Promise<void> {
    if (this.isSuperseded(connectionId, epoch)) {
      return;
    }
    if (this.slotStatsTopN === 0) {
      return;
    }
    if (
      !client.getCapabilities().hasClusterSlotStats ||
      !this.runtimeCapabilityTracker.isAvailable(connectionId, 'canClusterSlotStats')
    ) {
      this.clearSlotSeries(connLabel, state);
      return;
    }

    try {
      const slotStats = await client.getClusterSlotStats('key-count', this.slotStatsTopN);
      if (this.isSuperseded(connectionId, epoch)) {
        return;
      }

      const newSlotLabels = new Set<string>();
      for (const [slot, stats] of Object.entries(slotStats)) {
        newSlotLabels.add(slot);
        this.clusterSlotKeys.labels(connLabel, slot).set(stats.key_count || 0);
        this.clusterSlotExpires.labels(connLabel, slot).set(stats.expires_count || 0);
        this.clusterSlotReadsTotal.labels(connLabel, slot).set(stats.total_reads || 0);
        this.clusterSlotWritesTotal.labels(connLabel, slot).set(stats.total_writes || 0);
      }

      for (const staleSlot of state.currentClusterSlotLabels) {
        if (!newSlotLabels.has(staleSlot)) {
          this.removeSlotSeries(connLabel, staleSlot);
        }
      }

      state.currentClusterSlotLabels = newSlotLabels;
    } catch (slotStatsError) {
      const disabled = this.runtimeCapabilityTracker.recordFailure(
        connectionId,
        'canClusterSlotStats',
        slotStatsError instanceof Error ? slotStatsError : String(slotStatsError),
      );
      if (disabled && !this.isSuperseded(connectionId, epoch)) {
        this.clearSlotSeries(connLabel, state);
      }
      this.logger.error(`Failed to update cluster slot stats for ${connLabel}`, slotStatsError);
    }
  }

  private clearSlotSeries(connLabel: string, state: ConnectionMetricState): void {
    for (const slot of state.currentClusterSlotLabels) {
      this.removeSlotSeries(connLabel, slot);
    }
    state.currentClusterSlotLabels = new Set();
  }

  private removeSlotSeries(connLabel: string, slot: string): void {
    this.clusterSlotKeys.remove(connLabel, slot);
    this.clusterSlotExpires.remove(connLabel, slot);
    this.clusterSlotReadsTotal.remove(connLabel, slot);
    this.clusterSlotWritesTotal.remove(connLabel, slot);
  }

  private async updateAclMetrics(
    connectionId: string,
    connLabel: string,
    state: ConnectionMetricState,
    epoch: number = this.currentEpoch(connectionId),
  ): Promise<void> {
    try {
      const stats = await this.storage.getAuditStats(undefined, undefined, connectionId);
      if (this.isSuperseded(connectionId, epoch)) {
        return;
      }

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
    epoch: number = this.currentEpoch(connectionId),
  ): Promise<void> {
    try {
      const stats = await this.storage.getClientAnalyticsStats(undefined, undefined, connectionId);
      if (this.isSuperseded(connectionId, epoch)) {
        return;
      }

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

      const requestAnalysis = this.commandLogAnalytics.getCachedAnalysis(
        'large-request',
        connectionId,
      );
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
    epoch: number = this.currentEpoch(connectionId),
  ): Promise<void> {
    if (!this.runtimeCapabilityTracker.isAvailable(connectionId, 'canSlowLog')) {
      return;
    }

    try {
      const length = await this.slowLogAnalytics.getSlowLogLength(connectionId);
      if (this.isSuperseded(connectionId, epoch)) {
        return;
      }
      this.slowlogLength.labels(connLabel).set(length);

      const lastId = this.slowLogAnalytics.getLastSeenId(connectionId);
      if (lastId !== null) {
        this.slowlogLastId.labels(connLabel).set(lastId);
      }

      // Webhook dispatch for slowlog.threshold
      if (this.webhookEventsProService) {
        this.webhookEventsProService
          .dispatchSlowlogThreshold({
            slowlogCount: length,
            threshold: 100,
            timestamp: Date.now(),
            instance: { host: config?.host || 'localhost', port: config?.port || 6379 },
            connectionId,
          })
          .catch((err) => {
            this.logger.error('Failed to dispatch slowlog.threshold webhook', err);
          });
      }
    } catch (error) {
      this.runtimeCapabilityTracker.recordFailure(
        connectionId,
        'canSlowLog',
        error instanceof Error ? error : String(error),
      );
      this.logger.error(`Failed to update slowlog raw metrics for ${connLabel}`, error);
    }
  }

  /**
   * Report nodes stuck in the window between "the cluster demoted it" and "the
   * node knows it was demoted". Only runs while the watch holds something, so
   * a cluster that has not failed over pays nothing — the per-node INFO and
   * commandstats reads are the expensive part.
   */
  private async detectDemotedMasterWrites(
    connectionId: string,
    state: ConnectionMetricState,
    config: { host: string; port: number } | null,
    epoch: number = this.currentEpoch(connectionId),
  ): Promise<void> {
    if (state.demotionWatch.size === 0) {
      return;
    }
    if (!this.clusterMetricsService) {
      return;
    }

    let observations: DemotedNodeObservation[];
    try {
      // Scoped to the watched IDs: a demoted node is one node, and reading the
      // whole cluster to observe it would cost two INFO round trips per node
      // on every poll and every /metrics scrape for the length of the window.
      const nodeStats = await this.readWithTimeout(
        this.clusterMetricsService.getClusterNodeStats(connectionId, {
          includeCommandStats: true,
          nodeIds: [...state.demotionWatch.keys()],
        }),
        Math.min(this.pollIntervalMs, DEMOTED_NODE_READ_TIMEOUT_MS),
        'demoted-node read',
      );
      observations = nodeStats.map((node) => {
        return {
          nodeId: node.nodeId,
          nodeAddress: node.nodeAddress,
          selfReportedRole: node.selfReportedRole,
          opsPerSec: node.opsPerSec,
          writeCommandCalls: node.writeCommandCalls,
        };
      });
    } catch (err) {
      // Per-node reads fail independently of the cluster-wide ones. Losing them
      // must not take the poll down, and must not advance the watch — the next
      // successful read still sees the disagreement.
      this.logger.debug(
        `Demoted-node stats failed for ${connectionId}: ${err instanceof Error ? err.message : err}`,
      );
      return;
    }

    if (this.isSuperseded(connectionId, epoch)) {
      return;
    }

    const alerts = evaluateDemotedWrites(
      state.demotionWatch,
      observations,
      Date.now(),
      this.pollIntervalMs,
    );
    for (const alert of alerts) {
      const message = demotedWritesMessage(alert);
      if (alert.severity === 'critical') {
        this.logger.error(message);
      } else {
        this.logger.warn(message);
      }

      try {
        this.otelEvents?.dispatch(
          WebhookEventType.CLUSTER_DEMOTED_WRITES,
          {
            nodeId: alert.nodeId,
            nodeAddress: alert.nodeAddress,
            disagreementMs: alert.disagreementMs,
            demotedForMs: alert.demotedForMs,
            opsPerSec: alert.opsPerSec,
            severity: alert.severity,
            ...(alert.writeCallsDelta === undefined
              ? {}
              : { writeCallsDelta: alert.writeCallsDelta }),
          },
          connectionId,
        );
      } catch (err) {
        this.logger.error('Failed to dispatch cluster.demoted.writes OTLP event', err);
      }

      if (this.webhookEventsProService) {
        try {
          await this.webhookEventsProService.dispatchClusterDemotedWrites({
            nodeId: alert.nodeId,
            nodeAddress: alert.nodeAddress,
            disagreementMs: alert.disagreementMs,
            demotedForMs: alert.demotedForMs,
            opsPerSec: alert.opsPerSec,
            writeCallsDelta: alert.writeCallsDelta,
            severity: alert.severity,
            message,
            timestamp: Date.now(),
            instance: { host: config?.host || 'localhost', port: config?.port || 6379 },
            connectionId,
          });
        } catch (err) {
          this.logger.error('Failed to dispatch cluster.demoted.writes webhook', err);
        }
      }
    }
  }

  /**
   * Bound a read so a hung connection cannot stall the metrics pass. A timeout
   * is treated like any other failed read: the caller's own error handling
   * takes over, and the next poll tries again.
   */
  private async readWithTimeout<T>(work: Promise<T>, limitMs: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const expiry = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${label} exceeded ${limitMs}ms`));
      }, limitMs);
    });

    try {
      return await Promise.race([work, expiry]);
    } finally {
      clearTimeout(timer);
    }
  }

  async getMetrics(): Promise<string> {
    await this.updateMetrics();
    await this.sweepStaleSeries();
    const metrics = await this.exportRegistry.metrics();
    return metrics
      .split('\n')
      .filter((line) => !line.match(/\s+[Nn]a[Nn]\s*$/))
      .join('\n');
  }

  getContentType(): string {
    return this.exportRegistry.contentType;
  }

  async collectMetricsAsJson(): ReturnType<Registry['getMetricsAsJSON']> {
    await this.sweepStaleSeries();
    return this.exportRegistry.getMetricsAsJSON();
  }

  private async sweepStaleSeries(): Promise<void> {
    const { stale, fresh } = this.freshness.labelsByFreshness(Date.now());
    for (const label of fresh) {
      this.pollStale.labels(label).set(0);
    }
    for (const label of stale) {
      this.pollStale.labels(label).set(1);
    }
    await this.removeSeriesForLabels(stale, SWEEP_EXCLUSIONS);
  }

  private async removeSeriesForLabels(
    labels: ReadonlySet<string>,
    excludedNames: ReadonlySet<string>,
  ): Promise<void> {
    if (labels.size === 0) {
      return;
    }
    const gauges = (
      this.registry
        .getMetricsAsArray()
        .filter((metric) => metric instanceof Gauge) as unknown as Gauge[]
    ).filter((gauge) =>
      (gauge as unknown as { labelNames: string[] }).labelNames.includes('connection'),
    );
    const snapshots = (await Promise.all(
      gauges.map((gauge) => gauge.get()),
    )) as unknown as SeriesSnapshot[];
    // Reading the snapshots yields. A connection re-added under the same
    // host:port label in that window owns these series now, so drop it from
    // the removal set rather than deleting the new connection's children.
    const { fresh } = this.freshness.labelsByFreshness(Date.now());
    const removable = new Set([...labels].filter((label) => !fresh.has(label)));
    if (removable.size === 0) {
      return;
    }
    for (const ref of selectSeriesToRemove(snapshots, removable, excludedNames)) {
      const gauge = this.registry.getSingleMetric(ref.name) as Gauge | undefined;
      gauge?.remove(ref.labels as LabelValues<string>);
    }
  }

  incrementPollCounter(connectionId?: string): void {
    const connLabel = connectionId ? this.getConnectionLabel(connectionId) : 'system';
    this.pollsTotal.labels(connLabel).inc();
  }

  updateVectorIndexMetrics(
    connectionId: string,
    indexes: ReadonlyArray<{
      indexName: string;
      numDocs: number;
      memorySizeMb: number;
      indexingFailures: number;
      percentIndexed: number;
    }>,
  ): void {
    const connLabel = this.getConnectionLabel(connectionId);
    const state = this.getConnectionState(connectionId);
    const currentIndexLabels = new Set<string>();

    for (const idx of indexes) {
      currentIndexLabels.add(idx.indexName);
      this.vectorIndexDocs.labels(connLabel, idx.indexName).set(idx.numDocs);
      this.vectorIndexMemoryBytes
        .labels(connLabel, idx.indexName)
        .set(idx.memorySizeMb * 1024 * 1024);
      this.vectorIndexFailures.labels(connLabel, idx.indexName).set(idx.indexingFailures);
      this.vectorIndexPercentIndexed.labels(connLabel, idx.indexName).set(idx.percentIndexed);
    }

    for (const staleLabel of state.currentVectorIndexLabels) {
      if (!currentIndexLabels.has(staleLabel)) {
        this.vectorIndexDocs.remove(connLabel, staleLabel);
        this.vectorIndexMemoryBytes.remove(connLabel, staleLabel);
        this.vectorIndexFailures.remove(connLabel, staleLabel);
        this.vectorIndexPercentIndexed.remove(connLabel, staleLabel);
      }
    }
    state.currentVectorIndexLabels = currentIndexLabels;
  }

  updateReplBufferPressure(
    connectionId: string,
    entries: Array<{ replica: string; ratio: number }>,
  ): void {
    const connLabel = this.getConnectionLabel(connectionId);
    const state = this.getConnectionState(connectionId);
    const currentLabels = new Set<string>();

    for (const entry of entries) {
      currentLabels.add(entry.replica);
      this.replOutputBufferRatio.labels(connLabel, entry.replica).set(entry.ratio);
    }

    for (const staleLabel of state.currentReplBufferReplicaLabels) {
      if (!currentLabels.has(staleLabel)) {
        this.replOutputBufferRatio.remove(connLabel, staleLabel);
      }
    }
    state.currentReplBufferReplicaLabels = currentLabels;
  }

  updateCommandstatsMetrics(
    connectionId: string,
    samples: ReadonlyArray<{
      command: string;
      callsTotal: number;
      usecPerCall: number;
    }>,
  ): void {
    const connLabel = this.getConnectionLabel(connectionId);
    const state = this.getConnectionState(connectionId);
    const currentLabels = new Set<string>();

    for (const s of samples) {
      currentLabels.add(s.command);
      this.commandstatsCallsTotal.labels(connLabel, s.command).set(s.callsTotal);
      this.commandstatsLatencyUs.labels(connLabel, s.command).set(s.usecPerCall);
    }

    for (const staleLabel of state.currentCommandStatsLabels) {
      if (!currentLabels.has(staleLabel)) {
        this.commandstatsCallsTotal.remove(connLabel, staleLabel);
        this.commandstatsLatencyUs.remove(connLabel, staleLabel);
      }
    }
    state.currentCommandStatsLabels = currentLabels;
  }

  updateInferenceLatencyMetrics(
    connectionId: string,
    buckets: ReadonlyArray<{
      bucket: string;
      p50: number;
      p95: number;
      p99: number;
      unhealthy: boolean;
    }>,
  ): void {
    const connLabel = this.getConnectionLabel(connectionId);
    const state = this.getConnectionState(connectionId);
    const currentLabels = new Set<string>();

    for (const b of buckets) {
      currentLabels.add(b.bucket);
      this.inferenceBucketP50Us.labels(connLabel, b.bucket).set(b.p50);
      this.inferenceBucketP95Us.labels(connLabel, b.bucket).set(b.p95);
      this.inferenceBucketP99Us.labels(connLabel, b.bucket).set(b.p99);
      this.inferenceUnhealthy.labels(connLabel, b.bucket).set(b.unhealthy ? 1 : 0);
    }

    for (const staleLabel of state.currentInferenceBucketLabels) {
      if (!currentLabels.has(staleLabel)) {
        this.inferenceBucketP50Us.remove(connLabel, staleLabel);
        this.inferenceBucketP95Us.remove(connLabel, staleLabel);
        this.inferenceBucketP99Us.remove(connLabel, staleLabel);
        this.inferenceUnhealthy.remove(connLabel, staleLabel);
      }
    }
    state.currentInferenceBucketLabels = currentLabels;
  }

  updateInferenceSlaBreachMetrics(
    connectionId: string,
    breaches: ReadonlyArray<{ indexName: string; breached: boolean }>,
  ): void {
    const connLabel = this.getConnectionLabel(connectionId);
    const state = this.getConnectionState(connectionId);
    const currentLabels = new Set<string>();

    for (const b of breaches) {
      currentLabels.add(b.indexName);
      this.inferenceSlaBreach.labels(connLabel, b.indexName).set(b.breached ? 1 : 0);
    }

    for (const staleLabel of state.currentInferenceSlaBreachLabels) {
      if (!currentLabels.has(staleLabel)) {
        this.inferenceSlaBreach.remove(connLabel, staleLabel);
      }
    }
    state.currentInferenceSlaBreachLabels = currentLabels;
  }

  startPollTimer(service: string, connectionId?: string): () => void {
    const connLabel = connectionId ? this.getConnectionLabel(connectionId) : 'system';
    return this.pollDuration.startTimer({ connection: connLabel, service });
  }

  incrementAnomalyEvent(
    severity: string,
    metricType: string,
    anomalyType: string,
    connectionId?: string,
  ): void {
    const connLabel = connectionId ? this.getConnectionLabel(connectionId) : 'unknown';
    this.anomalyEventsTotal.inc({
      connection: connLabel,
      severity,
      metric_type: metricType,
      anomaly_type: anomalyType,
    });
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
      groupsBySeverity: Record<string, number>;
      unresolvedBySeverity: Record<string, number>;
    },
    connectionId?: string,
  ): void {
    const effectiveConnectionId =
      connectionId || this.connectionRegistry.getDefaultId() || 'unknown';
    const connLabel = this.getConnectionLabel(effectiveConnectionId);
    const state = this.getConnectionState(effectiveConnectionId);

    for (const sev of ['info', 'warning', 'critical']) {
      this.anomalyBySeverity.labels(connLabel, sev).set(summary.bySeverity[sev] ?? 0);
      this.anomalyEventsCurrent.labels(connLabel, sev).set(summary.unresolvedBySeverity[sev] ?? 0);
      this.correlatedGroupsBySeverity
        .labels(connLabel, sev)
        .set(summary.groupsBySeverity[sev] ?? 0);
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
    const effectiveConnectionId =
      connectionId || this.connectionRegistry.getDefaultId() || 'unknown';
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
    const state = this.perConnectionState.get(connectionId);
    if (state?.lastCveConnLabel) {
      this.removeCveSeries(state.lastCveConnLabel);
    } else {
      try {
        this.removeCveSeries(this.getConnectionLabel(connectionId));
      } catch {
        // Registry lookup can fail for an already-removed connection; the
        // tracked lastCveConnLabel path above covers the common case.
      }
    }
    this.perConnectionState.delete(connectionId);
    // Drop any in-flight metric update so a reused connection ID cannot join
    // stale work. The promise itself still settles; its compare-and-delete
    // finally then no-ops because the entry is already gone.
    this.updateMetricsInFlight.delete(connectionId);
    this.healthChecksInFlight.delete(connectionId);
    this.infoReadsInFlight.delete(connectionId);
    this.retireEpoch(connectionId);
    const label = this.freshness.forget(connectionId);
    if (label === undefined || this.freshness.hasLabel(label)) {
      return;
    }
    this.dropSeriesForRemovedLabel(label);
    // A pass that was already past an epoch check when cleanup ran can still
    // write one more time. Sweeping again after the pass bound catches that
    // without waiting for a scrape, and the label check keeps a connection
    // re-added under the same host:port in the meantime.
    const recheck = setTimeout(() => {
      if (!this.freshness.hasLabel(label)) {
        this.dropSeriesForRemovedLabel(label);
      }
    }, this.pollIntervalMs);
    recheck.unref?.();
  }

  private dropSeriesForRemovedLabel(label: string): void {
    this.removeSeriesForLabels(new Set([label]), NO_EXCLUSIONS).catch((error) => {
      this.logger.warn(
        `Failed to remove series for ${label}: ${error instanceof Error ? error.message : error}`,
      );
    });
  }

  private formatBytes(bytes: number): string {
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
    if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(2)} MB`;
    if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(2)} KB`;
    return `${bytes} B`;
  }
}
