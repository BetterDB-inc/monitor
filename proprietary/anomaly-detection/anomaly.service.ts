import { randomUUID } from 'crypto';
import { Injectable, Logger, OnModuleInit, Inject, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  StoragePort,
  StoredAnomalyEvent,
  StoredCorrelatedGroup,
} from '@app/common/interfaces/storage-port.interface';
import { PrometheusService } from '@app/prometheus/prometheus.service';
import { OtelEventDispatcherService } from '@app/otel-telemetry/otel-event-dispatcher.service';
import { SettingsService } from '@app/settings/settings.service';
import { SlowLogAnalyticsService } from '@app/slowlog-analytics/slowlog-analytics.service';
import { CommandLogAnalyticsService } from '@app/commandlog-analytics/commandlog-analytics.service';
import {
  MultiConnectionPoller,
  ConnectionContext,
} from '@app/common/services/multi-connection-poller';
import { DatabasePort } from '@app/common/interfaces/database-port.interface';
import {
  WEBHOOK_EVENTS_PRO_SERVICE,
  IWebhookEventsProService,
  WebhookEventType,
} from '@betterdb/shared';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import { MetricBuffer } from './metric-buffer';
import { SpikeDetector } from './spike-detector';
import { Correlator } from './correlator';
import { detectDuplicatePrimaries, conflictSignature } from './duplicate-primary-detector';
import {
  DEFAULT_CONFIG_DRIFT_KEYS,
  ConfigDrift,
  ConfigDriftNode,
  detectConfigDrift,
  configDriftSignature,
} from './config-drift-detector';
import { detectStuckReplicas, stuckReplicaSignature } from './stuck-replica-detector';
import { detectGhostMembers, ghostMemberSignature } from './ghost-membership-detector';
import { detectLaggingPromotion, ReplPeer } from './lagging-promotion-detector';
import { detectHostnameStaleness, hostnameStalenessSignature } from './hostname-staleness-detector';
import {
  detectReplicaSlotState,
  replicaSlotSignature,
  ReplicaSlotAnomaly,
} from './replica-slot-state-detector';
import { parseRaftState, isRaftSeeking } from './raft-health-detector';
import { MetricsParser } from '@app/database/parsers/metrics.parser';
import { ClusterDiscoveryService } from '@app/cluster/cluster-discovery.service';
import { ClusterNode, ClusterShard } from '@app/common/types/metrics.types';
import {
  FAILOVER_CHURN_MIN_CHANGES,
  FailoverChurnStateMap,
  acknowledgeChurnFinding,
  evaluateFailoverChurn,
} from './failover-churn-detector';
import {
  COB_WARN_RATIO,
  CobConnectionState,
  ReplicaObservation,
  SlaveOutputBufferLimit,
  acknowledgeCobFinding,
  createCobConnectionState,
  evaluateCobPressure,
  parseSlaveOutputBufferLimit,
} from './cob-pressure-detector';
import {
  MemoryOverheadState,
  acknowledgeMemoryOverheadFinding,
  createMemoryOverheadState,
  evaluateMemoryOverhead,
} from './memory-overhead-detector';
import {
  FORK_OOM_WARN_FRACTION,
  FORK_OOM_CRIT_FRACTION,
  ForkMemoryState,
  acknowledgeForkMemoryFinding,
  createForkMemoryState,
  evaluateForkMemoryRisk,
} from './fork-memory-risk-detector';
import {
  CONTROL_PLANE_CORROBORATING_METRICS,
  ControlPlaneState,
  SATURATION_CORROBORATION_WINDOW_MS,
  acknowledgeSaturationFinding,
  createControlPlaneSaturationEvent,
  createControlPlaneState,
  evaluateControlPlaneSaturation,
  isControlPlaneSaturationEvent,
} from './control-plane-saturation-detector';
import {
  LOAD_CRIT_FRACTION,
  LOAD_WARN_FRACTION,
  LoadSaturationState,
  acknowledgeLoadSaturationFinding,
  createLoadSaturationState,
  evaluateLoadSaturation,
} from './load-saturation-detector';
import {
  LargeReplyEntry,
  detectLargeReplyPressure,
  largeReplyPressureSignature,
} from './large-reply-pressure-detector';
import {
  MetricType,
  METRICS_HANDLED_OUTSIDE_EXTRACTOR,
  AnomalyEvent,
  CorrelatedAnomalyGroup,
  AnomalySeverity,
  AnomalyType,
  AnomalyPattern,
  BufferStats,
  AnomalySummary,
  SpikeDetectorConfig,
} from './types';

interface MetricExtractor {
  (info: Record<string, string>): number | null;
}

interface PersistenceChildTrack {
  startedAt: number;
  lastProcessed: number;
  lastAdvanceTs: number;
  lastElapsedSec: number;
  warnedLong: boolean;
  reportedStall: boolean;
}

interface ConnectionPersistenceState {
  rdb?: PersistenceChildTrack;
  aof?: PersistenceChildTrack;
  // Latch so a persisting error status fires once, re-armed by a later ok.
  rdbErrorReported?: boolean;
  aofErrorReported?: boolean;
}

@Injectable()
export class AnomalyService extends MultiConnectionPoller implements OnModuleInit {
  protected readonly logger = new Logger(AnomalyService.name);

  // Per-connection state: connectionId -> metricType -> buffer/detector
  private buffers = new Map<string, Map<MetricType, MetricBuffer>>();
  private detectors = new Map<string, Map<MetricType, SpikeDetector>>();
  private correlator: Correlator;

  private recentAnomalies: AnomalyEvent[] = [];
  private recentGroups: CorrelatedAnomalyGroup[] = [];
  private lastSlowlogId = new Map<string, number>();
  // Previous lifetime rejected_connections counter per connection, so we can feed
  // the per-poll DELTA (new refusals) to the detector rather than the ever-growing
  // counter — otherwise a single historical maxclients hit would alert forever.
  private lastRejectedConnections = new Map<string, number>();
  // Previous lifetime evicted_clients counter per connection — same DELTA reasoning
  // as rejected_connections; `clientEvictionLimit` caches the maxmemory-clients
  // config value (fetched once) so the alert can say whether eviction is even
  // enabled and contextualise justified-vs-over-aggressive (valkey#4151).
  private lastEvictedClients = new Map<string, number>();
  private clientEvictionLimit = new Map<string, string>();
  // Last-logged count of unreachable replicas in the slot-state fan-out, per
  // connection — so the degraded-detection warning is emitted only on a change,
  // not every ~1s poll.
  private replicaFanoutUnreachable = new Map<string, number>();
  private lastReplicationRole = new Map<string, number>();
  private lastClusterState = new Map<string, string>();
  private lastPersistenceState = new Map<string, ConnectionPersistenceState>();
  // Per-connection set of active duplicate-primary conflict signatures, so each
  // distinct conflict is alerted once rather than on every poll tick.
  private activeTopologyConflicts = new Map<string, Set<string>>();
  // Stuck-replica (valkey#2090) state. `firstSeen` records when a given orphaned
  // (replica, primary) pair was first observed so we can require it to persist —
  // a brief orphaned window is normal during a healthy failover. `active` dedupes
  // the alert once the persistence gate has fired.
  private stuckReplicaFirstSeen = new Map<string, Map<string, number>>();
  private activeStuckReplicas = new Map<string, Set<string>>();
  // Hostname-staleness (valkey#304) state, same discipline as stuck-replica:
  // `firstSeen` gates on persistence so a transient gossip-convergence window
  // (a node just joined/restarted, or is mid-rollout of
  // cluster-announce-hostname) doesn't alert, `active` dedupes once the gate
  // has fired.
  private hostnameStalenessFirstSeen = new Map<string, Map<string, number>>();
  private activeHostnameStaleness = new Map<string, Set<string>>();
  // Ghost-membership (valkey#1757) state, same discipline as stuck-replica:
  // `firstSeen` gates on persistence so a transient re-MEET/handshake window
  // doesn't alert, `active` dedupes the alert once the gate has fired.
  private ghostMemberFirstSeen = new Map<string, Map<string, number>>();
  private activeGhostMembers = new Map<string, Set<string>>();
  // Replica-slot-state (valkey#1664) state, same discipline as stuck-replica:
  // `firstSeen` gates on persistence so a transient reshard snapshot doesn't
  // alert, `active` dedupes once the gate has fired.
  private replicaSlotFirstSeen = new Map<string, Map<string, number>>();
  private activeReplicaSlotAnomalies = new Map<string, Set<string>>();
  // signature -> emitted event id, so a recovered condition can resolve exactly
  // its own event (clearing the activeOnly banner) instead of all of them.
  private replicaSlotEventIds = new Map<string, Map<string, string>>();
  // Per-connection per-shard failover-churn windows (valkey#3996, gossip mode).
  private failoverChurnState = new Map<string, FailoverChurnStateMap>();
  // Replication output-buffer pressure (valkey#3963): per-connection replica
  // hysteresis state, cached slave limit triplet with slow recheck, and the
  // last-seen sync_full counter for delta computation.
  private cobState = new Map<string, CobConnectionState>();
  // Fork-based-save COW/OOM memory-risk (valkey#3609): per-connection
  // escalation hysteresis for the live-COW and projected-next-fork advisories,
  // plus the last rdb_changes_since_last_save counter (+ its timestamp) so the
  // projected path is gated on a CURRENT write RATE rather than the raw
  // cumulative counter (which never resets on AOF-only deployments).
  private forkMemoryState = new Map<string, ForkMemoryState>();
  private forkMemLastChanges = new Map<string, { changes: number; ts: number }>();
  private cobLimitCache = new Map<string, SlaveOutputBufferLimit>();
  private cobLimitRecheck = new Map<string, number>();
  private cobLastSyncFull = new Map<string, number>();
  // Non-dataset memory overhead (valkey#1792): per-connection hysteresis state
  // and the last-seen evicted_keys counter for computing the per-poll delta.
  private memoryOverheadState = new Map<string, MemoryOverheadState>();
  private memOverheadLastEvictedKeys = new Map<string, number>();
  // Control-plane saturation (valkey#3927): per-connection episode state and
  // the last connected_slaves count for replica-drop corroboration.
  private controlPlaneState = new Map<string, ControlPlaneState>();
  private cpSatLastConnectedSlaves = new Map<string, number>();
  // Event-loop load saturation (valkey#2055): per-connection hysteresis state
  // tracking the acknowledged level and the consecutive-poll counter that keeps
  // a momentary batch/burst from alerting.
  private loadSaturationState = new Map<string, LoadSaturationState>();
  // Last-emitted client-saturation level per connection (connected_clients /
  // maxclients). Used for hysteresis: alert only when saturation escalates, not
  // on every poll, and re-arm once it drops back below the warning threshold.
  private clientSaturationLevel = new Map<string, 'none' | 'warning' | 'critical'>();
  // Large-reply commandlog pressure (valkey#2926): per-connection set of active
  // offending-command signatures (dedupe, like activeTopologyConflicts), plus
  // the cached commandlog-reply-larger-than threshold with a slow recheck
  // countdown (same discipline as cobLimitCache/cobLimitRecheck) so a runtime
  // CONFIG SET is eventually picked up without a CONFIG GET on every poll.
  private activeLargeReplyOffenders = new Map<string, Set<string>>();
  private largeReplyThresholdCache = new Map<string, number>();
  private largeReplyThresholdRecheck = new Map<string, number>();
  // Raft (Cluster V2) health state. `raftPrevTerm` + `raftTermChanges` track the
  // election-term history to detect churn (repeated elections). The quorum-loss
  // "leaderless watch" opens when the node starts seeking a leader it cannot
  // elect: `raftLeaderlessSince` is the watch-start timestamp, `raftWatchCommit`
  // the commit index captured then (to detect whether a leader later made
  // progress), `raftLastSeeking` the last time the node was actually seeking (a
  // one-off blip stops updating it → the watch recovers; a real outage keeps
  // re-seeking → it doesn't).
  // `raftMode` remembers whether the connection is Raft so a transient CLUSTER
  // INFO failure can't make the gossip topology detectors fire in a Raft cluster.
  // `raftLeaderlessActive` marks a confirmed live outage for the connection. While
  // it holds, the detector keeps exactly one active CRITICAL raft_health event in
  // the authoritative incident feed (re-emitting if the previous one was
  // dismissed/removed, never duplicating one merely evicted from the in-memory
  // ring) and resolves every active one on recovery — so the panel's live-outage
  // pin tracks the real state, not whether an operator dismissed the banner. It
  // also gates the recovery-time storage query so healthy polls stay cheap.
  private raftPrevTerm = new Map<string, number>();
  private raftTermChanges = new Map<string, number[]>();
  private raftLeaderlessSince = new Map<string, number>();
  private raftWatchCommit = new Map<string, number>();
  private raftLastSeeking = new Map<string, number>();
  private raftLeaderlessActive = new Map<string, boolean>();
  private raftMode = new Map<string, boolean>();
  private raftNodeTimeoutMs = new Map<string, number>();
  private raftNodeTimeoutRecheck = new Map<string, number>();
  private prevCpuByConnection = new Map<string, { sys: number; user: number; ts: number }>();
  private prevReplSnapshot = new Map<
    string,
    {
      role: 'master' | 'replica';
      replid: string; // master_replid
      offset: number; // master_repl_offset
      totalKeys: number; // sum of keys across db0..dbN from INFO keyspace
      uptimeSec: number; // uptime_in_seconds
      connectedSlaves: number; // connected_slaves
    }
  >();
  // Shared cross-connection snapshot for config-drift detection
  // (valkey-io/valkey#1193): each connection records its OWN curated config
  // subset + replication-group key every poll; detectConfigDrift scans this
  // map across ALL connections rather than fanning out live to sibling
  // nodes. Grouped by `master_replid` — shared by a primary and its attached
  // replicas (and, for a cluster shard, by that shard's primary + replicas).
  private configSnapshot = new Map<
    string,
    { groupKey: string; name: string; config: Record<string, string> }
  >();
  // Global (not per-connection) dedupe: a drift finding is a property of the
  // GROUP, not of whichever connection's poll happened to detect it.
  // Recomputed from the full snapshot on every call, so it self-heals if a
  // group member's snapshot lags a poll behind its peers.
  private activeConfigDriftSignatures = new Set<string>();
  private readonly maxRecentEvents = 1000;
  private readonly maxRecentGroups = 100;

  private readonly metricExtractors: Map<MetricType, MetricExtractor>;
  // Persistence-child (BGSAVE / AOF rewrite) stall thresholds, in seconds.
  private readonly persistenceStallSec: number;
  private readonly persistenceWarnSec: number;
  private readonly persistenceCritSec: number;
  private readonly correlationIntervalMs = 5000;
  private correlationInterval: NodeJS.Timeout | null = null;
  private prometheusSummaryInterval: NodeJS.Timeout | null = null;

  constructor(
    connectionRegistry: ConnectionRegistry,
    @Inject('STORAGE_CLIENT')
    private readonly storage: StoragePort,
    private readonly configService: ConfigService,
    private readonly prometheusService: PrometheusService,
    private readonly settingsService: SettingsService,
    private readonly slowLogAnalytics: SlowLogAnalyticsService,
    private readonly commandLogAnalytics: CommandLogAnalyticsService,
    @Optional()
    @Inject(WEBHOOK_EVENTS_PRO_SERVICE)
    private readonly webhookEventsProService?: IWebhookEventsProService,
    @Optional()
    private readonly otelEvents?: OtelEventDispatcherService,
    // Optional so unit tests and minimal deployments still construct the service;
    // when absent, replica slot-state detection degrades to the connected node's
    // own CLUSTER NODES view (no per-node fan-out).
    @Optional()
    private readonly clusterDiscovery?: ClusterDiscoveryService,
  ) {
    super(connectionRegistry);
    this.correlator = new Correlator(this.correlationIntervalMs);
    this.metricExtractors = this.initializeMetricExtractors();

    // Validated and defaulted by the Zod env schema (env.schema.ts), so a typo
    // fails startup instead of silently falling back here.
    this.persistenceStallSec = this.configService.get<number>('MONITOR_PERSISTENCE_STALL_SEC', 60);
    this.persistenceWarnSec = this.configService.get<number>('MONITOR_PERSISTENCE_WARN_SEC', 120);
    this.persistenceCritSec = this.configService.get<number>('MONITOR_PERSISTENCE_CRIT_SEC', 600);
  }

  protected getIntervalMs(): number {
    return this.settingsService.getCachedSettings().anomalyPollIntervalMs;
  }

  private get cacheTtlMs(): number {
    return this.settingsService.getCachedSettings().anomalyCacheTtlMs;
  }

  private get prometheusSummaryIntervalMs(): number {
    return this.settingsService.getCachedSettings().anomalyPrometheusIntervalMs;
  }

  onModuleInit() {
    this.logger.log('Starting anomaly detection service...');

    // Start multi-connection polling
    this.start();

    // Start correlation loop
    this.correlationInterval = setInterval(() => {
      this.correlateAnomalies().catch((err) => {
        this.logger.error('Failed to correlate anomalies:', err);
      });
    }, this.correlationIntervalMs);

    // Start prometheus summary loop
    this.prometheusSummaryInterval = setInterval(() => {
      this.updatePrometheusSummary().catch((err) => {
        this.logger.error('Failed to update prometheus summary:', err);
      });
    }, this.prometheusSummaryIntervalMs);
  }

  async onModuleDestroy(): Promise<void> {
    await super.onModuleDestroy();
    if (this.correlationInterval) {
      clearInterval(this.correlationInterval);
      this.correlationInterval = null;
    }
    if (this.prometheusSummaryInterval) {
      clearInterval(this.prometheusSummaryInterval);
      this.prometheusSummaryInterval = null;
    }
  }

  private getOrCreateBuffersAndDetectors(connectionId: string): {
    buffers: Map<MetricType, MetricBuffer>;
    detectors: Map<MetricType, SpikeDetector>;
  } {
    if (!this.buffers.has(connectionId)) {
      this.initializeBuffersAndDetectorsForConnection(connectionId);
    }
    return {
      buffers: this.buffers.get(connectionId)!,
      detectors: this.detectors.get(connectionId)!,
    };
  }

  private initializeMetricExtractors(): Map<MetricType, MetricExtractor> {
    return new Map<MetricType, MetricExtractor>([
      [MetricType.CONNECTIONS, (info) => this.parseNumber(info.connected_clients)],
      [MetricType.OPS_PER_SEC, (info) => this.parseNumber(info.instantaneous_ops_per_sec)],
      [MetricType.MEMORY_USED, (info) => this.parseNumber(info.used_memory)],
      [MetricType.INPUT_KBPS, (info) => this.parseNumber(info.instantaneous_input_kbps)],
      [MetricType.OUTPUT_KBPS, (info) => this.parseNumber(info.instantaneous_output_kbps)],
      // ACL_DENIED = auth/permission denials only. rejected_connections (the
      // maxclients-exhaustion signal) is tracked separately, as a per-poll delta,
      // so a connection-limit event is not misread as an auth attack. See the
      // REJECTED_CONNECTIONS rate-of-change block in pollConnection.
      [MetricType.ACL_DENIED, (info) => this.parseNumber(info.acl_access_denied_auth)],
      [MetricType.EVICTED_KEYS, (info) => this.parseNumber(info.evicted_keys)],
      [MetricType.BLOCKED_CLIENTS, (info) => this.parseNumber(info.blocked_clients)],
      [MetricType.KEYSPACE_MISSES, (info) => this.parseNumber(info.keyspace_misses)],
      [
        MetricType.FRAGMENTATION_RATIO,
        (info) => {
          return (
            this.parseNumber(info['allocator_frag_ratio']) ||
            this.parseNumber(info['mem_fragmentation_ratio'])
          );
        },
      ],
    ]);
  }

  private initializeBuffersAndDetectorsForConnection(connectionId: string): void {
    // Define custom configs for specific metrics
    const configs: Partial<Record<MetricType, SpikeDetectorConfig>> = {
      [MetricType.ACL_DENIED]: {
        warningZScore: 1.5,
        criticalZScore: 2.5,
        warningThreshold: 10,
        criticalThreshold: 50,
        consecutiveRequired: 2,
        cooldownMs: 30000,
      },
      [MetricType.MEMORY_USED]: {
        warningZScore: 2.5,
        criticalZScore: 3.5,
        consecutiveRequired: 3,
        cooldownMs: 60000,
      },
      [MetricType.EVICTED_KEYS]: {
        warningZScore: 2.0,
        criticalZScore: 3.0,
        consecutiveRequired: 2,
        cooldownMs: 30000,
      },
      [MetricType.FRAGMENTATION_RATIO]: {
        warningZScore: 2.0,
        criticalZScore: 3.0,
        warningThreshold: 1.5,
        criticalThreshold: 2.0,
        consecutiveRequired: 5,
        cooldownMs: 120000,
      },
      // Keep CPU z-score-only (no absolute warning/criticalThreshold): the
      // control-plane saturation detector already emits its own synthetic
      // CRITICAL CPU event at a fixed 90% threshold (see
      // createControlPlaneSaturationEvent) — a second absolute-threshold
      // source on this metric would double-alert the same condition.
      [MetricType.CPU_UTILIZATION]: {
        warningZScore: 2.0,
        criticalZScore: 3.0,
        consecutiveRequired: 3,
        cooldownMs: 60000,
        detectDrops: true,
      },
    };

    // Initialize buffers and detectors for all metrics
    const connectionBuffers = new Map<MetricType, MetricBuffer>();
    const connectionDetectors = new Map<MetricType, SpikeDetector>();

    for (const metricType of Object.values(MetricType)) {
      // State-based / delta-fed / deprecated metric types get no baseline buffer
      // (single source of truth shared with the test — see types.ts).
      if (METRICS_HANDLED_OUTSIDE_EXTRACTOR.has(metricType)) continue;
      connectionBuffers.set(metricType, new MetricBuffer(metricType));
      const config = configs[metricType] || {};
      connectionDetectors.set(metricType, new SpikeDetector(metricType, config));
    }

    this.buffers.set(connectionId, connectionBuffers);
    this.detectors.set(connectionId, connectionDetectors);
  }

  protected onConnectionRemoved(connectionId: string): void {
    this.buffers.delete(connectionId);
    this.detectors.delete(connectionId);
    this.lastSlowlogId.delete(connectionId);
    this.lastRejectedConnections.delete(connectionId);
    this.lastEvictedClients.delete(connectionId);
    this.replicaFanoutUnreachable.delete(connectionId);
    this.clientEvictionLimit.delete(connectionId);
    this.lastReplicationRole.delete(connectionId);
    this.lastClusterState.delete(connectionId);
    this.lastPersistenceState.delete(connectionId);
    this.activeTopologyConflicts.delete(connectionId);
    this.clientSaturationLevel.delete(connectionId);
    this.raftPrevTerm.delete(connectionId);
    this.raftTermChanges.delete(connectionId);
    this.raftLeaderlessSince.delete(connectionId);
    this.raftWatchCommit.delete(connectionId);
    this.raftLastSeeking.delete(connectionId);
    this.raftLeaderlessActive.delete(connectionId);
    this.raftMode.delete(connectionId);
    this.raftNodeTimeoutMs.delete(connectionId);
    this.raftNodeTimeoutRecheck.delete(connectionId);
    this.stuckReplicaFirstSeen.delete(connectionId);
    this.activeStuckReplicas.delete(connectionId);
    this.hostnameStalenessFirstSeen.delete(connectionId);
    this.activeHostnameStaleness.delete(connectionId);
    this.ghostMemberFirstSeen.delete(connectionId);
    this.activeGhostMembers.delete(connectionId);
    this.replicaSlotFirstSeen.delete(connectionId);
    this.activeReplicaSlotAnomalies.delete(connectionId);
    this.replicaSlotEventIds.delete(connectionId);
    this.failoverChurnState.delete(connectionId);
    this.forkMemoryState.delete(connectionId);
    this.forkMemLastChanges.delete(connectionId);
    const hadCobState = this.cobState.delete(connectionId);
    this.cobLimitCache.delete(connectionId);
    this.cobLimitRecheck.delete(connectionId);
    this.cobLastSyncFull.delete(connectionId);
    this.memoryOverheadState.delete(connectionId);
    this.memOverheadLastEvictedKeys.delete(connectionId);
    if (hadCobState) {
      try {
        this.prometheusService.updateReplBufferPressure(connectionId, []);
      } catch (promErr) {
        this.logger.debug(
          `Failed to clear repl buffer gauge for removed connection ${connectionId}: ${promErr instanceof Error ? promErr.message : promErr}`,
        );
      }
    }
    this.controlPlaneState.delete(connectionId);
    this.cpSatLastConnectedSlaves.delete(connectionId);
    this.loadSaturationState.delete(connectionId);
    this.prevCpuByConnection.delete(connectionId);
    this.prevReplSnapshot.delete(connectionId);
    this.activeLargeReplyOffenders.delete(connectionId);
    this.largeReplyThresholdCache.delete(connectionId);
    this.largeReplyThresholdRecheck.delete(connectionId);
    // Drop this connection's config snapshot so it can't linger as a phantom
    // drift source (comparisons would otherwise keep "seeing" its last-known
    // config forever). Signatures involving it self-heal on the next
    // detectConfigDrift call, which rebuilds its node list from what remains.
    this.configSnapshot.delete(connectionId);
    this.logger.debug(`Cleaned up anomaly detection state for connection ${connectionId}`);
  }

  private parseNumber(value: string | undefined): number | null {
    if (!value) return null;
    const parsed = parseFloat(value);
    return isNaN(parsed) ? null : parsed;
  }

  /**
   * Sums the `keys=` count across every `db<N>` entry of the INFO keyspace
   * section.
   *
   * Reads the typed `keyspace` section straight off the parsed INFO response —
   * NOT the flattened record — because `convertInfoToRecord` stringifies each
   * value, which would turn an object-shaped db into `"[object Object]"` and
   * silently zero the count. `MetricsParser.parseInfoToTyped` owns db-key
   * matching and emits every db* entry as a `{ keys, expires, avg_ttl }`
   * object; a string value here means the line was not a parseable db entry
   * and contributes nothing.
   */
  private sumKeyspaceKeys(infoResponse: { keyspace?: Record<string, unknown> } | null): number {
    const keyspace = infoResponse?.keyspace;
    if (keyspace === null || typeof keyspace !== 'object') return 0;
    let total = 0;
    for (const value of Object.values(keyspace)) {
      if (value !== null && typeof value === 'object' && 'keys' in value) {
        total += Number((value as { keys: unknown }).keys) || 0;
      }
    }
    return total;
  }

  protected async pollConnection(ctx: ConnectionContext): Promise<void> {
    try {
      // Timed around the socket call only: this round-trip doubles as the
      // control-plane probe latency sample for detectControlPlaneSaturation.
      const probeStart = performance.now();
      const infoResponse = await ctx.client.getInfoParsed();
      const probeRttMs = performance.now() - probeStart;
      const info = this.convertInfoToRecord(infoResponse);
      const timestamp = Date.now();
      let cpuUtilizationSample: number | null = null;
      let cpuCounterReset = false;

      const { buffers, detectors } = this.getOrCreateBuffersAndDetectors(ctx.connectionId);

      // Process each metric from INFO
      for (const [metricType, extractor] of this.metricExtractors.entries()) {
        const value = extractor(info);
        if (value === null) continue;

        const buffer = buffers.get(metricType);
        const detector = detectors.get(metricType);

        if (!buffer || !detector) continue;

        buffer.addSample(value, timestamp);

        const anomaly = detector.detect(buffer, value, timestamp);
        if (anomaly) {
          anomaly.connectionId = ctx.connectionId;
          this.logger.warn(`Anomaly detected for ${ctx.connectionName}: ${anomaly.message}`);
          await this.addAnomaly(anomaly, ctx);
        }
      }

      // CPU utilization delta computation (cumulative counters → rate)
      const cpuSys = this.parseNumber(info.used_cpu_sys);
      const cpuUser = this.parseNumber(info.used_cpu_user);
      if (cpuSys !== null && cpuUser !== null) {
        const prev = this.prevCpuByConnection.get(ctx.connectionId);
        const cpuTotal = cpuSys + cpuUser;

        if (prev) {
          const dtSec = (timestamp - prev.ts) / 1000;
          if (dtSec > 0) {
            const prevTotal = prev.sys + prev.user;
            const utilization = ((cpuTotal - prevTotal) / dtSec) * 100;
            if (utilization < 0) {
              // counter reset (server restart) - skip this sample, new baseline set below
              cpuCounterReset = true;
            } else {
              cpuUtilizationSample = utilization;
              const cpuBuffer = buffers.get(MetricType.CPU_UTILIZATION)!;
              const cpuDetector = detectors.get(MetricType.CPU_UTILIZATION)!;
              cpuBuffer.addSample(utilization, timestamp);
              const anomaly = cpuDetector.detect(cpuBuffer, utilization, timestamp);
              if (anomaly) {
                anomaly.connectionId = ctx.connectionId;
                this.logger.warn(`Anomaly detected for ${ctx.connectionName}: ${anomaly.message}`);
                await this.addAnomaly(anomaly, ctx);
              }
            }
          }
        }

        this.prevCpuByConnection.set(ctx.connectionId, {
          sys: cpuSys,
          user: cpuUser,
          ts: timestamp,
        });
      }

      // Slowlog rate-of-change detection (sourced from SlowLogAnalyticsService, not INFO)
      const currentSlowlogId = this.slowLogAnalytics.getLastSeenId(ctx.connectionId);
      if (currentSlowlogId !== null) {
        const lastId = this.lastSlowlogId.get(ctx.connectionId);
        const delta = Math.max(0, currentSlowlogId - (lastId ?? currentSlowlogId));
        this.lastSlowlogId.set(ctx.connectionId, currentSlowlogId);

        // Lazily create buffer/detector on first available data
        if (!buffers.has(MetricType.SLOWLOG_LAST_ID)) {
          buffers.set(MetricType.SLOWLOG_LAST_ID, new MetricBuffer(MetricType.SLOWLOG_LAST_ID));
          detectors.set(
            MetricType.SLOWLOG_LAST_ID,
            new SpikeDetector(MetricType.SLOWLOG_LAST_ID, {
              warningZScore: 1.5,
              criticalZScore: 2.5,
              consecutiveRequired: 1,
              cooldownMs: 30000,
            }),
          );
        }

        const slowlogBuffer = buffers.get(MetricType.SLOWLOG_LAST_ID)!;
        const slowlogDetector = detectors.get(MetricType.SLOWLOG_LAST_ID)!;
        slowlogBuffer.addSample(delta, timestamp);
        const anomaly = slowlogDetector.detect(slowlogBuffer, delta, timestamp);
        if (anomaly) {
          anomaly.connectionId = ctx.connectionId;
          this.logger.warn(`Anomaly detected for ${ctx.connectionName}: ${anomaly.message}`);
          await this.addAnomaly(anomaly, ctx);
        }
      }

      // Rejected-connections rate-of-change (maxclients exhaustion). rejected_connections
      // is a lifetime counter, so we feed the per-poll delta — the count of NEW refusals
      // since the last poll — not the raw counter, which would keep alerting forever after
      // a single historical hit. Absolute thresholds apply to that delta.
      const currentRejected = this.parseNumber(info.rejected_connections);
      if (currentRejected !== null) {
        const lastRejected = this.lastRejectedConnections.get(ctx.connectionId);
        // max(0, …) also absorbs a counter reset (server restart → counter back to 0).
        const rejectedDelta = Math.max(0, currentRejected - (lastRejected ?? currentRejected));
        this.lastRejectedConnections.set(ctx.connectionId, currentRejected);

        if (!buffers.has(MetricType.REJECTED_CONNECTIONS)) {
          buffers.set(
            MetricType.REJECTED_CONNECTIONS,
            new MetricBuffer(MetricType.REJECTED_CONNECTIONS),
          );
          detectors.set(
            MetricType.REJECTED_CONNECTIONS,
            new SpikeDetector(MetricType.REJECTED_CONNECTIONS, {
              warningZScore: 1.5,
              criticalZScore: 2.5,
              warningThreshold: 5,
              criticalThreshold: 25,
              consecutiveRequired: 1,
              cooldownMs: 30000,
            }),
          );
        }

        const rejectedBuffer = buffers.get(MetricType.REJECTED_CONNECTIONS)!;
        const rejectedDetector = detectors.get(MetricType.REJECTED_CONNECTIONS)!;
        rejectedBuffer.addSample(rejectedDelta, timestamp);
        const rejectedAnomaly = rejectedDetector.detect(rejectedBuffer, rejectedDelta, timestamp);
        if (rejectedAnomaly) {
          rejectedAnomaly.connectionId = ctx.connectionId;
          this.logger.warn(
            `Anomaly detected for ${ctx.connectionName}: ${rejectedAnomaly.message}`,
          );
          await this.addAnomaly(rejectedAnomaly, ctx);
        }
      }

      // Client-eviction storm (maxmemory-clients). evicted_clients is a lifetime
      // counter, so we feed the per-poll delta — the count of clients disconnected
      // by client-buffer eviction since the last poll — not the raw counter. Any
      // eviction is abnormal, so absolute thresholds are low. Skipped when eviction
      // is disabled (maxmemory-clients = 0). See valkey#4151.
      const currentEvicted = this.parseNumber(info.evicted_clients);
      if (currentEvicted !== null && (await this.clientEvictionEnabled(ctx))) {
        const lastEvicted = this.lastEvictedClients.get(ctx.connectionId);
        // max(0, …) absorbs a counter reset on server restart.
        const evictedDelta = Math.max(0, currentEvicted - (lastEvicted ?? currentEvicted));
        this.lastEvictedClients.set(ctx.connectionId, currentEvicted);

        if (!buffers.has(MetricType.EVICTED_CLIENTS)) {
          buffers.set(MetricType.EVICTED_CLIENTS, new MetricBuffer(MetricType.EVICTED_CLIENTS));
          detectors.set(
            MetricType.EVICTED_CLIENTS,
            new SpikeDetector(MetricType.EVICTED_CLIENTS, {
              warningZScore: 1.5,
              criticalZScore: 2.5,
              warningThreshold: 1,
              criticalThreshold: 10,
              consecutiveRequired: 1,
              cooldownMs: 30000,
            }),
          );
        }

        const evictedBuffer = buffers.get(MetricType.EVICTED_CLIENTS)!;
        const evictedDetector = detectors.get(MetricType.EVICTED_CLIENTS)!;
        evictedBuffer.addSample(evictedDelta, timestamp);
        const evictedAnomaly = evictedDetector.detect(evictedBuffer, evictedDelta, timestamp);
        if (evictedAnomaly) {
          evictedAnomaly.connectionId = ctx.connectionId;
          evictedAnomaly.message = this.describeClientEviction(
            evictedDelta,
            info,
            ctx.connectionId,
            evictedAnomaly.severity,
          );
          this.logger.warn(`Anomaly detected for ${ctx.connectionName}: ${evictedAnomaly.message}`);
          await this.addAnomaly(evictedAnomaly, ctx);
        }
      }

      // Replication role state-change detection (not z-score based)
      const roleStr = info['role'];
      if (roleStr) {
        const currentRole =
          roleStr === 'master' ? 1 : roleStr === 'slave' || roleStr === 'replica' ? 0 : -1;
        if (currentRole !== -1) {
          const lastRole = this.lastReplicationRole.get(ctx.connectionId);
          if (lastRole !== undefined && currentRole !== lastRole) {
            if (currentRole === 0) {
              // master → replica demotion (failover started)
              const failoverEvent: AnomalyEvent = {
                id: `${ctx.connectionId}-failover-${timestamp}`,
                timestamp,
                metricType: MetricType.REPLICATION_ROLE,
                anomalyType: AnomalyType.DROP,
                severity: AnomalySeverity.CRITICAL,
                value: 0,
                baseline: 1,
                zScore: 0,
                stdDev: 0,
                threshold: 0,
                message:
                  'CRITICAL: Node role changed from master to replica — possible failover or split-brain detected',
                resolved: false,
                connectionId: ctx.connectionId,
              };
              this.logger.warn(
                `Anomaly detected for ${ctx.connectionName}: ${failoverEvent.message}`,
              );
              await this.addAnomaly(failoverEvent, ctx);

              // Dispatch failover.started webhook. No OTLP mirror here on
              // purpose — the cluster.failover OTLP emit lives solely in
              // PrometheusService to avoid double-emitting.
              if (this.webhookEventsProService) {
                this.webhookEventsProService
                  .dispatchFailoverStarted({
                    previousRole: 'master',
                    newRole: roleStr,
                    timestamp: Date.now(),
                    instance: { host: ctx.host, port: ctx.port },
                    connectionId: ctx.connectionId,
                  })
                  .catch((err) => {
                    this.logger.error('Failed to dispatch failover.started webhook', err);
                  });
              }
            } else if (currentRole === 1) {
              // replica → master promotion (failover completed)
              const promotionEvent: AnomalyEvent = {
                id: `${ctx.connectionId}-promotion-${timestamp}`,
                timestamp,
                metricType: MetricType.REPLICATION_ROLE,
                anomalyType: AnomalyType.SPIKE,
                severity: AnomalySeverity.WARNING,
                value: 1,
                baseline: 0,
                zScore: 0,
                stdDev: 0,
                threshold: 0,
                message: 'WARNING: Node promoted from replica to master — failover completed',
                resolved: false,
                connectionId: ctx.connectionId,
              };
              this.logger.warn(
                `Anomaly detected for ${ctx.connectionName}: ${promotionEvent.message}`,
              );
              await this.addAnomaly(promotionEvent, ctx);

              // Dispatch failover.completed webhook
              if (this.webhookEventsProService) {
                this.webhookEventsProService
                  .dispatchFailoverCompleted({
                    previousRole: 'replica',
                    newRole: 'master',
                    timestamp: Date.now(),
                    instance: { host: ctx.host, port: ctx.port },
                    connectionId: ctx.connectionId,
                  })
                  .catch((err) => {
                    this.logger.error('Failed to dispatch failover.completed webhook', err);
                  });
              }
            }
          }
          this.lastReplicationRole.set(ctx.connectionId, currentRole);
        }
      }

      // Data-loss detection (valkey/valkey#579): a primary that restarts empty
      // wipes its replicas via full resync. Rule A fires on the primary the
      // moment it comes back empty; Rule B confirms a replica has been wiped.
      const replid = info['master_replid'];
      if (replid && (roleStr === 'master' || roleStr === 'slave' || roleStr === 'replica')) {
        const snapshot = {
          role: (roleStr === 'master' ? 'master' : 'replica') as 'master' | 'replica',
          replid,
          offset: this.parseNumber(info.master_repl_offset) ?? 0,
          totalKeys: this.sumKeyspaceKeys(infoResponse),
          uptimeSec: this.parseNumber(info.uptime_in_seconds) ?? 0,
          connectedSlaves: this.parseNumber(info.connected_slaves) ?? 0,
        };

        // While the server is still loading its dataset from disk after a
        // restart (RDB/AOF), the keyspace reports zero until the load finishes.
        // Skip data-loss detection and keep the prior snapshot so a normal
        // restart with persistence does not look like an empty-primary wipe.
        const isLoading = info.loading === '1' || info.async_loading === '1';

        const prev = this.prevReplSnapshot.get(ctx.connectionId);
        if (prev && !isLoading) {
          let dataLossKind: 'primary_restarted_empty' | 'replica_wiped' | null = null;
          let message = '';

          if (
            prev.role === 'master' &&
            snapshot.role === 'master' &&
            prev.totalKeys > 0 &&
            snapshot.totalKeys === 0
          ) {
            // Rule A: primary restarted with an empty dataset. Requires restart/identity
            // evidence — same replid + empty means an intentional FLUSHALL, not a restart.
            const restartEvidence =
              snapshot.replid !== prev.replid ||
              snapshot.uptimeSec < prev.uptimeSec ||
              snapshot.offset < prev.offset;
            if (restartEvidence) {
              dataLossKind = 'primary_restarted_empty';
              message =
                snapshot.connectedSlaves > 0
                  ? `CRITICAL: Primary restarted with an empty dataset (replid changed, ${prev.totalKeys} keys → 0). Connected replicas (${snapshot.connectedSlaves}) will full-resync and WIPE their copies. Immediate action: detach replicas that still hold data (REPLICAOF NO ONE) before they resync, then restore.`
                  : `CRITICAL: Primary restarted with an empty dataset (replid changed, ${prev.totalKeys} keys → 0). Data on this node has been lost — restore from backup or a surviving replica before reattaching replicas.`;
            }
          } else if (
            prev.role === 'replica' &&
            snapshot.role === 'replica' &&
            snapshot.replid !== prev.replid &&
            prev.totalKeys > 0 &&
            (snapshot.totalKeys === 0 || snapshot.totalKeys <= prev.totalKeys * 0.1)
          ) {
            // Rule B: replica wiped by a full resync from a (near-)empty primary
            dataLossKind = 'replica_wiped';
            message = `CRITICAL: Replica was wiped by a full resync from a (near-)empty primary — data loss has propagated (${prev.totalKeys} keys → ${snapshot.totalKeys}). The old dataset may still exist on other replicas or in backups; do not let further nodes resync.`;
          }

          if (dataLossKind) {
            const dataLossEvent: AnomalyEvent = {
              // Storage adapters (postgres) require UUID event ids
              id: randomUUID(),
              timestamp,
              metricType: MetricType.DATASET_KEYS,
              anomalyType: AnomalyType.DROP,
              severity: AnomalySeverity.CRITICAL,
              value: snapshot.totalKeys,
              baseline: prev.totalKeys,
              zScore: 0,
              stdDev: 0,
              threshold: 0,
              message,
              resolved: false,
              connectionId: ctx.connectionId,
            };
            this.logger.warn(
              `Anomaly detected for ${ctx.connectionName}: ${dataLossEvent.message}`,
            );
            await this.addAnomaly(dataLossEvent, ctx);

            if (this.webhookEventsProService) {
              this.webhookEventsProService
                .dispatchDataLossDetected({
                  kind: dataLossKind,
                  previousKeys: prev.totalKeys,
                  currentKeys: snapshot.totalKeys,
                  previousReplid: prev.replid,
                  newReplid: snapshot.replid,
                  connectedSlaves: snapshot.connectedSlaves,
                  role: snapshot.role,
                  message,
                  timestamp: Date.now(),
                  instance: { host: ctx.host, port: ctx.port },
                  connectionId: ctx.connectionId,
                })
                .catch((err) => {
                  this.logger.error('Failed to dispatch data.loss.detected webhook', err);
                });
            }
          }

          // Lagging uncoordinated promotion (valkey#2587): in a standalone
          // (cluster-mode-disabled) setup a REPLICAOF NO ONE just promoted this
          // replica — warn if a sibling replica was further ahead, meaning its
          // extra writes are lost and it must full-resync down to this node.
          if (
            info['cluster_enabled'] !== '1' &&
            prev.role === 'replica' &&
            snapshot.role === 'master'
          ) {
            // Compare the promoted node's CURRENT offset (snapshot.offset), not
            // its last replica-poll offset: a coordinated FAILOVER catches the
            // target fully up before promoting, so the prior-poll offset would
            // false-positive on a clean failover even though no writes were lost.
            // Group siblings by the FORMER master's replid (prev.replid) — the id
            // co-replicas still share; snapshot.replid may be this node's own new
            // id post-promotion. (valkey#2587 Bugbot: stale-offset false positive.)
            await this.detectLaggingPromotion(ctx, timestamp, prev.replid, snapshot.offset);
          }
        }

        // Don't record the transient empty snapshot taken mid-load; otherwise
        // the next poll (keys restored) would compare against zero.
        if (!isLoading) {
          this.prevReplSnapshot.set(ctx.connectionId, snapshot);
        }
      }

      // Cluster state transition detection
      const clusterEnabled = info['cluster_enabled'];
      if (clusterEnabled === '1') {
        // Raft (Cluster V2) vs gossip is decided from CLUSTER INFO. Default to the
        // last known mode so a transient CLUSTER INFO failure can't flip a Raft
        // connection back to gossip and run the gossip topology detectors on it.
        let isRaft = this.raftMode.get(ctx.connectionId) ?? false;
        try {
          const clusterInfo = await ctx.client.getClusterInfo();
          const clusterState = clusterInfo?.cluster_state;
          if (clusterState) {
            const lastState = this.lastClusterState.get(ctx.connectionId);
            if (lastState !== undefined && clusterState !== lastState) {
              const isRecovery = lastState === 'fail' && clusterState === 'ok';
              const isFailure = lastState === 'ok' && clusterState === 'fail';
              if (isRecovery || isFailure) {
                const clusterEvent: AnomalyEvent = {
                  id: `${ctx.connectionId}-cluster-state-${timestamp}`,
                  timestamp,
                  metricType: MetricType.CLUSTER_STATE,
                  anomalyType: isFailure ? AnomalyType.DROP : AnomalyType.SPIKE,
                  severity: isFailure ? AnomalySeverity.CRITICAL : AnomalySeverity.WARNING,
                  value: clusterState === 'ok' ? 1 : 0,
                  baseline: lastState === 'ok' ? 1 : 0,
                  zScore: 0,
                  stdDev: 0,
                  threshold: 0,
                  message: isFailure
                    ? `CRITICAL: Cluster state changed from ok to fail — slots may be uncovered`
                    : `WARNING: Cluster state recovered from fail to ok`,
                  resolved: false,
                  connectionId: ctx.connectionId,
                };
                this.logger.warn(
                  `Anomaly detected for ${ctx.connectionName}: ${clusterEvent.message}`,
                );
                await this.addAnomaly(clusterEvent, ctx);

                // cluster.failover is mirrored to OTLP once from
                // PrometheusService, the always-loaded core detector, so a
                // single failover yields one OTLP record. Emitting here too
                // would double-count it (and also on recovery, which is not a
                // failover). The webhook below is unchanged.
                if (this.webhookEventsProService) {
                  this.webhookEventsProService
                    .dispatchClusterFailover({
                      clusterState,
                      previousState: lastState,
                      slotsAssigned: parseInt(clusterInfo.cluster_slots_assigned) || 0,
                      slotsFailed: parseInt(clusterInfo.cluster_slots_fail) || 0,
                      knownNodes: parseInt(clusterInfo.cluster_known_nodes) || 0,
                      timestamp: Date.now(),
                      instance: { host: ctx.host, port: ctx.port },
                      connectionId: ctx.connectionId,
                    })
                    .catch((err) => {
                      this.logger.error('Failed to dispatch cluster.failover webhook', err);
                    });
                }
              }
            }
            this.lastClusterState.set(ctx.connectionId, clusterState);
          }

          // Raft (Cluster V2) health: leaderless/quorum-loss + election churn.
          // No-op in gossip mode (no cluster_raft_* fields).
          if (clusterInfo) {
            isRaft = clusterInfo['cluster_raft_role'] !== undefined;
            this.raftMode.set(ctx.connectionId, isRaft);
            await this.detectRaftHealth(clusterInfo, ctx, timestamp);
          }
        } catch (clusterErr) {
          this.logger.debug(
            `Failed to get cluster info for ${ctx.connectionName}: ${clusterErr instanceof Error ? clusterErr.message : clusterErr}`,
          );
        }

        // Gossip-era topology detectors — two primaries per shard (#2261),
        // orphaned/stuck replicas (#2090), and stale/inconsistent hostname
        // gossip (#304). Under Raft, topology is consensus-managed, so these
        // gossip-race detectors are skipped; Raft health is
        // covered by detectRaftHealth above. Gated on `!isRaft` only, which
        // defaults to the last known mode — so a transient CLUSTER INFO failure
        // neither runs them on a known-Raft connection nor suppresses them on a
        // gossip cluster (where they must keep running through the blip).
        if (!isRaft) {
          // Fetch the topology ONCE for all gossip-era detectors (was multiple
          // independent CLUSTER NODES calls per poll), and CLUSTER SHARDS
          // concurrently (optional refinement — never rejects). A CLUSTER NODES
          // failure is a single observation gap: skip the detectors this poll
          // WITHOUT clearing the WARNING detectors' dedupe/grace state (so a
          // transient blip can't re-fire a duplicate), while preserving the
          // duplicate-primary detector's deliberate re-alert-after-gap behavior.
          // For failover churn the skip also carries the window state — churn
          // evidence must survive a probe blip or a flapping shard could never
          // accumulate enough observations to fire.
          const shardsPromise = this.safeGetClusterShards(ctx);
          let nodes: ClusterNode[] | undefined;
          try {
            nodes = await ctx.client.getClusterNodes();
          } catch (topologyErr) {
            this.activeTopologyConflicts.delete(ctx.connectionId);
            this.logger.debug(
              `Failed to fetch cluster topology for ${ctx.connectionName}: ${topologyErr instanceof Error ? topologyErr.message : topologyErr}`,
            );
          }
          const shards = await shardsPromise;

          if (nodes) {
            await this.detectDuplicatePrimaries(ctx, timestamp, nodes);
            await this.detectStuckReplicas(ctx, timestamp, nodes);
            await this.detectHostnameStaleness(ctx, timestamp, nodes, shards);
            await this.detectGhostMembers(ctx, timestamp, nodes);
            await this.detectFailoverChurn(ctx, timestamp, nodes);
            // Replica migrating/importing markers are node-local — only the
            // queried node's own line carries them — so aggregate each replica's
            // self-view before detecting (falls back to `nodes` without fan-out).
            const perNodeView = await this.gatherReplicaSlotView(nodes, ctx);
            await this.detectReplicaSlotState(
              ctx,
              timestamp,
              perNodeView.nodes,
              shards,
              perNodeView.unreachableIds,
            );
          }
        }
      }

      // Persistence-child stall detection (stuck BGSAVE / AOF rewrite) — state-based, not z-score
      await this.detectPersistenceStall(info, ctx, timestamp);

      // Fork-based-save COW/OOM memory-risk (valkey-io/valkey#3609): projected
      // peak RSS (used_memory_rss + COW growth) approaching total system memory
      // during — or, under write pressure, just before — a BGSAVE/AOF rewrite.
      // State-based with hysteresis; complementary to the stall detector above.
      await this.detectForkMemoryRisk(info, ctx, timestamp);

      // Client-saturation detection — connected_clients approaching maxclients
      // (valkey-io/valkey#3918): warns before the pool exhausts and operators
      // can no longer connect. State-based with hysteresis, not z-score.
      await this.detectClientSaturation(info, ctx, timestamp);

      // Cross-node config drift (valkey-io/valkey#1193): CONFIG SET only ever
      // applies to the single node it's sent to today, so nodes in the same
      // replication group can silently drift on a critical setting (e.g. one
      // primary/replica ends up with a different maxmemory-policy). Updates
      // this connection's slice of the shared snapshot, then scans the whole
      // snapshot for cross-node disagreement. State-based, not z-score.
      await this.detectConfigDrift(info, ctx, timestamp);

      // Replication output-buffer pressure (valkey-io/valkey#3963): replica
      // omem approaching the slave COB limit, and the resync-loop signal once
      // an overflow already forced a full sync. State-based with hysteresis.
      await this.detectCobPressure(info, ctx, timestamp);

      // Non-dataset memory overhead (valkey-io/valkey#1792): operational
      // overhead (client buffers, repl backlog/buffers, AOF buffer, scripts,
      // cluster links) consuming the maxmemory budget and/or driving eviction
      // of user data. State-based with hysteresis, not z-score.
      await this.detectMemoryOverhead(info, ctx, timestamp);

      // Control-plane saturation (valkey-io/valkey#3927): sustained CPU
      // saturation paired with control-plane impact evidence. Runs last so
      // this poll's detector emissions can corroborate.
      await this.detectControlPlaneSaturation(
        info,
        ctx,
        timestamp,
        cpuUtilizationSample,
        probeRttMs,
        cpuCounterReset,
      );

      // Event-loop load saturation (valkey-io/valkey#2055): busy-fraction of
      // the event loop — the real-work busyness that raw CPU% hides. Passes the
      // same cpuUtilizationSample so the message can call out when CPU%
      // understates the load. State-based with hysteresis.
      await this.detectLoadSaturation(info, ctx, timestamp, cpuUtilizationSample);

      // Large-reply commandlog throughput pressure (valkey-io/valkey#2926): hot
      // commands repeatedly crossing commandlog-reply-larger-than pay the
      // large-reply logging/copy path's cost on every call — a regression
      // observed to cost up to ~25% GET throughput and still unfixed upstream.
      // Sourced from CommandLogAnalyticsService's cached LARGE-REPLY entries
      // (already polled on its own 30s cadence, so no extra COMMANDLOG call
      // here); the threshold config is fetched on a slow recheck like the COB
      // limit. State-based with per-offending-command dedupe.
      await this.detectLargeReplyPressure(ctx, timestamp);
    } catch (error) {
      this.logger.error(`Failed to poll metrics for ${ctx.connectionName}:`, error);
      throw error;
    }
  }

  private static readonly CLIENT_SATURATION_WARN = 0.8;
  private static readonly CLIENT_SATURATION_CRIT = 0.95;
  private static readonly SATURATION_RANK = { none: 0, warning: 1, critical: 2 } as const;

  // Minimum replication-offset gap (bytes) for a lagging-promotion alert
  // (valkey#2587). Sibling-replica offsets are compared same-cycle from the last
  // poll snapshot; healthy co-replicas sit at near-identical offsets, so any real
  // gap is meaningful. Kept as a single tunable knob so poll-skew noise (should
  // it appear under heavy write load) can be dialed up without touching logic.
  private static readonly LAGGING_PROMOTION_MIN_GAP_BYTES = 1;

  /**
   * Detect connected_clients approaching maxclients (valkey-io/valkey#3918).
   * Once the pool is exhausted, new connections — including operator/monitoring
   * sessions — are refused, so warning early gives time to shed load or connect
   * over a reserved/unix socket before that happens.
   *
   * State-based with hysteresis: emits only when saturation ESCALATES
   * (none→warning, none/warning→critical), never on every poll while steady, and
   * re-arms when it falls back below the warning threshold — so a busy-but-stable
   * server doesn't spam alerts.
   */
  private async detectClientSaturation(
    info: Record<string, string>,
    ctx: ConnectionContext,
    timestamp: number,
  ): Promise<void> {
    const connected = this.parseNumber(info.connected_clients);
    const maxClients = this.parseNumber(info.maxclients);
    if (connected === null || maxClients === null || maxClients <= 0) return;

    const ratio = connected / maxClients;
    const level: 'none' | 'warning' | 'critical' =
      ratio >= AnomalyService.CLIENT_SATURATION_CRIT
        ? 'critical'
        : ratio >= AnomalyService.CLIENT_SATURATION_WARN
          ? 'warning'
          : 'none';

    const prev = this.clientSaturationLevel.get(ctx.connectionId) ?? 'none';
    const escalated = AnomalyService.SATURATION_RANK[level] > AnomalyService.SATURATION_RANK[prev];

    // Only alert on escalation; de-escalation / steady state stays quiet.
    if (escalated) {
      const pct = (ratio * 100).toFixed(1);
      const severity = level === 'critical' ? AnomalySeverity.CRITICAL : AnomalySeverity.WARNING;
      const event: AnomalyEvent = {
        id: randomUUID(),
        timestamp,
        // Dedicated metric type (not CONNECTIONS) so the correlator's CONNECTION_LEAK
        // rule doesn't misdiagnose steady high saturation as a connection leak.
        metricType: MetricType.CLIENT_SATURATION,
        anomalyType: AnomalyType.SPIKE,
        severity,
        value: connected,
        baseline: maxClients,
        zScore: 0,
        stdDev: 0,
        threshold: Math.floor(maxClients * AnomalyService.CLIENT_SATURATION_WARN),
        message:
          `${severity === AnomalySeverity.CRITICAL ? 'CRITICAL' : 'WARNING'}: Client connections at ` +
          `${connected}/${maxClients} (${pct}% of maxclients). When the limit is reached new ` +
          `connections — including operator and monitoring sessions — are refused. ` +
          `Investigate for a connection leak/storm, raise maxclients, or connect over a reserved/unix socket.`,
        resolved: false,
        connectionId: ctx.connectionId,
      };
      this.logger.warn(`Anomaly detected for ${ctx.connectionName}: ${event.message}`);
      // Await the emit so a failure propagates to the poll error handler. The
      // stored level is advanced only AFTER a successful emit (below), so a failed
      // escalation is retried on the next poll rather than being silently swallowed
      // by the hysteresis.
      await this.addAnomaly(event, ctx);
    }

    // Advance the level last: on escalation only after addAnomaly resolved; on
    // steady/de-escalation immediately (the latter re-arms alerting on recovery).
    this.clientSaturationLevel.set(ctx.connectionId, level);
  }

  /**
   * Curated CONFIG keys compared for cross-node drift (valkey-io/valkey#1193).
   * Deliberately excludes node-specific keys that legitimately differ (bind,
   * port, dir, replica-announce-ip/port, unixsocket, logfile, requirepass, …).
   */
  private static readonly CONFIG_DRIFT_KEYS = DEFAULT_CONFIG_DRIFT_KEYS;

  /**
   * Detects a curated CRITICAL config key (maxmemory, maxmemory-policy, …)
   * disagreeing across nodes in the same replication group (valkey-io/
   * valkey#1193): `CONFIG SET` only ever applies to the node it's sent to, so
   * nodes can silently drift apart over time — a real source of incidents
   * (eviction behaving differently per node, one node not persisting, …).
   *
   * This is a two-part, cross-connection detector built the "shared snapshot"
   * way (no live fan-out to sibling nodes, so a hung peer can never stall this
   * poll): first it refreshes THIS connection's own slice of the shared
   * `configSnapshot` map — its curated config subset plus a replication-group
   * key (`master_replid`, shared by a primary and its attached replicas, and
   * — for a cluster shard — by that shard's primary and replicas). It then
   * hands the FULL snapshot (every connection's last-known slice) to the pure
   * `detectConfigDrift`, which does the actual grouping/comparison.
   *
   * Because every connection's poll calls this, the same global state may be
   * recomputed several times per tick; that's intentional idempotent
   * reconciliation, not redundant alerting — `activeConfigDriftSignatures` is
   * a single dedupe set (not per-connection, since a drift is a property of
   * the GROUP), so only a genuinely NEW mismatch pattern emits, and a
   * resolved one is dropped so a later recurrence re-alerts.
   */
  private async detectConfigDrift(
    info: Record<string, string>,
    ctx: ConnectionContext,
    timestamp: number,
  ): Promise<void> {
    try {
      const replid = info['master_replid'];
      const roleStr = info['role'];
      const isReplicating = roleStr === 'master' || roleStr === 'slave' || roleStr === 'replica';

      if (!replid || !isReplicating) {
        // Not (yet) part of a known replication group — drop any stale entry
        // so it can't linger as a phantom drift source.
        this.configSnapshot.delete(ctx.connectionId);
      } else {
        const capabilities = ctx.client.getCapabilities();
        if (!capabilities.hasConfig) {
          this.configSnapshot.delete(ctx.connectionId);
        } else {
          // Bounded to the curated allowlist (not CONFIG GET '*'): all calls
          // race concurrently against this connection's OWN already-open
          // client (no fan-out to sibling nodes). Use getConfigValues (which
          // returns the parsed map) rather than getConfigValue (which collapses
          // an empty value to null): a key set to the EMPTY string — e.g.
          // `save ""` (RDB disabled) — must be recorded as "" and compared, not
          // dropped as if unsupported, since an empty-vs-non-empty `save` is
          // exactly the persistence drift we want to catch. A per-key failure
          // (unsupported on this version, or a transient error) omits that key.
          const entries = await Promise.all(
            AnomalyService.CONFIG_DRIFT_KEYS.map(async (key) => {
              try {
                const cfg = await ctx.client.getConfigValues(key);
                const value = cfg[key];
                return value !== undefined ? ([key, value] as const) : null;
              } catch {
                return null;
              }
            }),
          );
          // Only touch the snapshot when we actually read at least one key this
          // poll. An all-keys-failed poll must leave the snapshot ENTIRELY
          // unchanged — including its groupKey: a failover often changes
          // master_replid at the same time it triggers LOADING (which fails
          // these reads), so rewriting groupKey from the current replid on a
          // stale-config poll would move the node into a new replication group,
          // clear the old drift signature, and re-fire the same mismatch as a
          // brand-new alert.
          const fetchedAny = entries.some((entry) => entry !== null);
          if (fetchedAny) {
            // MERGE freshly-read keys onto the last-known snapshot rather than
            // replacing it, so a PARTIAL failure (some keys succeed, some fail)
            // doesn't drop the keys that failed — a dropped drifted key would
            // make the mismatch momentarily vanish and re-fire on recovery. A
            // key that failed this poll retains its prior value.
            const prior = this.configSnapshot.get(ctx.connectionId)?.config ?? {};
            const config: Record<string, string> = { ...prior };
            for (const entry of entries) {
              if (entry) config[entry[0]] = entry[1];
            }
            this.configSnapshot.set(ctx.connectionId, {
              groupKey: `replid:${replid}`,
              name: ctx.connectionName,
              config,
            });
          }
        }
      }

      const nodes: ConfigDriftNode[] = Array.from(this.configSnapshot.entries()).map(
        ([connectionId, snap]) => ({
          connectionId,
          name: snap.name,
          groupKey: snap.groupKey,
          config: snap.config,
        }),
      );
      const drifts = detectConfigDrift(nodes, AnomalyService.CONFIG_DRIFT_KEYS);
      const currentSignatures = new Set(drifts.map(configDriftSignature));

      // This method runs from EVERY connection's poll and MultiConnectionPoller
      // runs those polls concurrently, all mutating the shared
      // activeConfigDriftSignatures set. Reconcile it SYNCHRONOUSLY here — with
      // no await in between — so the check-and-claim is atomic per poll: a
      // concurrent poll can neither double-emit the same new drift nor drop
      // another poll's still-active signature. Snapshots persist across polls
      // (a failed fetch keeps the last-known values, above), so every poll
      // computes the same currentSignatures rather than a partial view.
      const newDrifts: ConfigDrift[] = [];
      for (const drift of drifts) {
        const signature = configDriftSignature(drift);
        if (this.activeConfigDriftSignatures.has(signature)) continue; // already claimed/alerted
        this.activeConfigDriftSignatures.add(signature); // claim before the emit await
        newDrifts.push(drift);
      }
      // Drop only signatures that are genuinely no longer drifting, so a
      // resolved-then-recurring mismatch alerts again (targeted delete, not a
      // whole-set replace that a concurrent poll's claim could be lost to).
      for (const signature of this.activeConfigDriftSignatures) {
        if (!currentSignatures.has(signature)) this.activeConfigDriftSignatures.delete(signature);
      }

      for (const drift of newDrifts) {
        const signature = configDriftSignature(drift);

        const valuesLabel = drift.values
          .map((v) => `${v.name ?? v.connectionId} = ${v.value}`)
          .join(', ');

        const event: AnomalyEvent = {
          id: `config-drift-${signature}-${timestamp}`,
          timestamp,
          metricType: MetricType.CONFIG_DRIFT,
          anomalyType: AnomalyType.SPIKE,
          severity: AnomalySeverity.WARNING,
          value: new Set(drift.values.map((v) => v.value)).size,
          baseline: 1,
          zScore: 0,
          stdDev: 0,
          threshold: 1,
          message:
            `WARNING: Config key '${drift.key}' differs across nodes in the same replication ` +
            `group: ${valuesLabel}. valkey-io/valkey#1193 — CONFIG SET only applies to the node ` +
            `it's sent to, so this key must be reconciled on every node by hand until an ` +
            `in-engine cluster-wide CONFIG SET exists.`,
          resolved: false,
          // Attributed to the first drifting node — NOT necessarily ctx, whose
          // own poll may just be the one that happened to run this scan (this
          // method runs from every connection's poll; see class doc above).
          connectionId: drift.values[0].connectionId,
        };
        this.logger.warn(`Anomaly detected: ${event.message}`);
        // Resolve the ATTRIBUTED node's own context (host/port/name) so
        // Prometheus/OTLP labels and the stored sourceHost/sourcePort reflect
        // the drifting node rather than defaulting to `unknown`/database.host.
        // The attributed node is frequently NOT the connection whose poll ran
        // this scan, so we must not pass the polling ctx. Falls back to the
        // event's connectionId (storage-only) if the node isn't resolvable.
        const attributedCtx = this.buildConnectionContext(drift.values[0].connectionId);
        await this.addAnomaly(event, attributedCtx);
      }
    } catch (err) {
      this.logger.debug(
        `Failed to check config drift for ${ctx.connectionName}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Builds a ConnectionContext for an arbitrary connection id from the registry,
   * so an event attributed to a node OTHER than the polling connection (e.g. a
   * config-drift member) carries that node's real host/port/name for telemetry
   * and storage. Returns undefined if the connection is no longer registered or
   * its client can't be resolved (a since-removed node) — the caller then falls
   * back to storage-only attribution via the event's connectionId.
   */
  private buildConnectionContext(connectionId: string): ConnectionContext | undefined {
    const info = this.connectionRegistry.list().find((c) => c.id === connectionId);
    if (!info) return undefined;
    let client: DatabasePort;
    try {
      client = this.connectionRegistry.get(connectionId);
    } catch {
      return undefined;
    }
    return {
      connectionId,
      connectionName: info.name,
      client,
      host: info.host,
      port: info.port,
    };
  }

  /**
   * Emits a data-loss WARNING when a standalone node was just promoted to primary
   * (REPLICAOF NO ONE) while a sibling replica of the same primary was further
   * ahead in the replication stream (valkey-io/valkey#2587). Siblings are found
   * from the last-poll replication snapshots by matching the master replication
   * id; the byte gap is the data the ahead replica must discard on its forced
   * full resync. `promotedOffset` is the node's CURRENT offset at promotion, so a
   * coordinated FAILOVER (which fully catches the target up before promoting)
   * shows the promoted node at/above its siblings and never fires. No-op when no
   * sibling replica is visible to compare against.
   */
  private async detectLaggingPromotion(
    ctx: ConnectionContext,
    timestamp: number,
    replid: string,
    promotedOffset: number,
  ): Promise<void> {
    const peers: ReplPeer[] = [];
    for (const [connId, snap] of this.prevReplSnapshot) {
      if (connId === ctx.connectionId) continue;
      if (snap.role !== 'replica') continue;
      if (snap.replid !== replid) continue;
      peers.push({ connectionId: connId, offset: snap.offset, role: 'slave' });
    }

    const finding = detectLaggingPromotion(
      ctx.connectionId,
      promotedOffset,
      peers,
      AnomalyService.LAGGING_PROMOTION_MIN_GAP_BYTES,
    );
    if (!finding) return;

    const aheadName =
      this.connectionRegistry.list().find((c) => c.id === finding.aheadId)?.name ??
      finding.aheadId.substring(0, 8);

    const event: AnomalyEvent = {
      // Storage adapters (postgres) require UUID event ids.
      id: randomUUID(),
      timestamp,
      metricType: MetricType.LAGGING_PROMOTION,
      anomalyType: AnomalyType.SPIKE,
      severity: AnomalySeverity.WARNING,
      value: finding.lagBytes,
      baseline: 0,
      zScore: 0,
      stdDev: 0,
      threshold: 0,
      message:
        `WARNING: This node was promoted to primary while sibling replica '${aheadName}' was ` +
        `${finding.lagBytes} bytes ahead in the replication stream (offset ${finding.aheadOffset} vs ` +
        `${finding.promotedOffset}). An uncoordinated REPLICAOF NO ONE promotes a possibly-lagging ` +
        `replica, so those writes are lost and the more up-to-date replica must full-resync down to ` +
        `this node (valkey#2587). Prefer a coordinated FAILOVER, or promote the most up-to-date replica.`,
      resolved: false,
      connectionId: ctx.connectionId,
    };
    this.logger.warn(`Anomaly detected for ${ctx.connectionName}: ${event.message}`);
    await this.addAnomaly(event, ctx);
  }

  /**
   * Detect event-loop SATURATION using the real-work busyness signal that raw
   * CPU% hides (valkey-io/valkey#2055). On a largely single-threaded server the
   * true busyness indicator is how much of wall-clock time the event loop
   * spends doing work, derived from INFO stats
   * `instantaneous_eventloop_duration_usec` * `instantaneous_eventloop_cycles_per_sec`.
   * Those fields are optional (older servers omit them), so this is a graceful
   * no-op when they are absent. State-based with hysteresis: emits only when
   * busyness escalates and re-arms on a drop; the passed cpuUtilization lets the
   * message point out when CPU% understates the load.
   */
  private async detectLoadSaturation(
    info: Record<string, string>,
    ctx: ConnectionContext,
    timestamp: number,
    cpuUtilization: number | null,
  ): Promise<void> {
    let state = this.loadSaturationState.get(ctx.connectionId);
    if (state === undefined) {
      state = createLoadSaturationState();
      this.loadSaturationState.set(ctx.connectionId, state);
    }

    const finding = evaluateLoadSaturation(state, {
      eventloopDurationUsecPerCycle: this.parseNumber(info.instantaneous_eventloop_duration_usec),
      eventloopCyclesPerSec: this.parseNumber(info.instantaneous_eventloop_cycles_per_sec),
      cpuUtilizationPct: cpuUtilization,
      opsPerSec: this.parseNumber(info.instantaneous_ops_per_sec),
      timestamp,
    });
    if (finding === null) return;

    const severity =
      finding.level === 'critical' ? AnomalySeverity.CRITICAL : AnomalySeverity.WARNING;
    const busyPct = finding.busyFraction * 100;
    const event: AnomalyEvent = {
      id: randomUUID(),
      timestamp,
      metricType: MetricType.LOAD_SATURATION,
      anomalyType: AnomalyType.SPIKE,
      severity,
      value: busyPct,
      baseline: LOAD_WARN_FRACTION * 100,
      zScore: 0,
      stdDev: 0,
      threshold: (finding.level === 'critical' ? LOAD_CRIT_FRACTION : LOAD_WARN_FRACTION) * 100,
      message: finding.message,
      resolved: false,
      connectionId: ctx.connectionId,
    };
    this.logger.warn(`Anomaly detected for ${ctx.connectionName}: ${event.message}`);
    // Await the emit so a failure propagates to the poll error handler, and
    // acknowledge only AFTER a successful emit — a failed escalation is then
    // retried on the next poll rather than being swallowed by the hysteresis.
    await this.addAnomaly(event, ctx);
    acknowledgeLoadSaturationFinding(state, finding);
  }

  /**
   * How often (in polls) the cached commandlog-reply-larger-than threshold is
   * re-read via CONFIG GET. Mirrors COB_LIMIT_RECHECK_POLLS: a slow-changing
   * config value doesn't need re-fetching on every ~1s poll, but a runtime
   * CONFIG SET should still be picked up eventually.
   */
  private static readonly LARGE_REPLY_THRESHOLD_RECHECK_POLLS = 60;

  /**
   * Large-reply commandlog throughput pressure (valkey-io/valkey#2926): warns
   * when a hot command is repeatedly producing replies that cross the
   * configured `commandlog-reply-larger-than` threshold, meaning it routinely
   * pays the LARGE-REPLY logging/copy path's cost — observed upstream to cost
   * up to ~25% GET throughput, and still unfixed (PR #3397 only raised the
   * default threshold).
   *
   * Entries come from `CommandLogAnalyticsService`'s cache, which is already
   * populated on its own ~30s poll cadence — this method issues NO extra
   * COMMANDLOG call. The threshold config is fetched via CONFIG GET only when
   * there is at least one cached entry to evaluate, and even then only on a
   * slow recheck cadence (like the COB limit triplet), so a connection that
   * never produces large replies costs nothing beyond the free cache read.
   *
   * State-based with per-offending-command dedupe (mirrors
   * detectDuplicatePrimaries' activeTopologyConflicts): each distinct
   * offending command is alerted once, and dropping out of the current
   * offender set (recovery, or threshold raised past its replies) clears its
   * signature so a later recurrence alerts again.
   */
  private async detectLargeReplyPressure(ctx: ConnectionContext, timestamp: number): Promise<void> {
    try {
      const cachedEntries = this.commandLogAnalytics.getCachedEntries(
        'large-reply',
        ctx.connectionId,
      );

      if (cachedEntries.length === 0) {
        // Nothing to evaluate this poll. Also clears any stale active
        // offenders (e.g. after COMMANDLOG RESET) so a future recurrence
        // re-alerts rather than staying suppressed by dedupe forever.
        if ((this.activeLargeReplyOffenders.get(ctx.connectionId)?.size ?? 0) > 0) {
          this.activeLargeReplyOffenders.set(ctx.connectionId, new Set());
        }
        return;
      }

      let thresholdBytes = this.largeReplyThresholdCache.get(ctx.connectionId) ?? null;
      const countdown = this.largeReplyThresholdRecheck.get(ctx.connectionId) ?? 0;
      if (countdown > 0) {
        this.largeReplyThresholdRecheck.set(ctx.connectionId, countdown - 1);
      } else {
        try {
          const raw = await ctx.client.getConfigValue('commandlog-reply-larger-than');
          const parsed = raw !== null ? parseInt(raw, 10) : NaN;
          if (Number.isFinite(parsed)) {
            thresholdBytes = parsed;
            this.largeReplyThresholdCache.set(ctx.connectionId, parsed);
          }
          this.largeReplyThresholdRecheck.set(
            ctx.connectionId,
            AnomalyService.LARGE_REPLY_THRESHOLD_RECHECK_POLLS,
          );
        } catch (cfgErr) {
          this.logger.debug(
            `CONFIG GET commandlog-reply-larger-than failed for ${ctx.connectionName}: ${cfgErr instanceof Error ? cfgErr.message : cfgErr}`,
          );
        }
      }

      // Threshold unknown (never successfully fetched) or negative (large-reply
      // logging disabled server-side) — nothing meaningful to compare against.
      // Clear any armed offenders too (as the empty-cache path does): cached
      // LARGE-REPLY entries can linger after logging is disabled, so without
      // this the re-arm reconcile below is skipped and prior command signatures
      // stay armed — suppressing recurrence alerts if logging is later
      // re-enabled, until a COMMANDLOG RESET or connection cleanup.
      if (thresholdBytes === null || thresholdBytes < 0) {
        if ((this.activeLargeReplyOffenders.get(ctx.connectionId)?.size ?? 0) > 0) {
          this.activeLargeReplyOffenders.set(ctx.connectionId, new Set());
        }
        return;
      }

      const entries: LargeReplyEntry[] = cachedEntries.map((e) => {
        return {
          command: (e.command[0] ?? '').toUpperCase(),
          replyBytes: e.duration,
          timestamp: e.timestamp,
        };
      });

      const offenders = detectLargeReplyPressure(entries, thresholdBytes);

      const active = this.activeLargeReplyOffenders.get(ctx.connectionId) ?? new Set<string>();
      const currentSignatures = new Set(offenders.map(largeReplyPressureSignature));

      for (const offender of offenders) {
        const signature = largeReplyPressureSignature(offender);
        if (active.has(signature)) continue; // already alerted for this command

        const event: AnomalyEvent = {
          id: randomUUID(),
          timestamp,
          metricType: MetricType.LARGE_REPLY_PRESSURE,
          anomalyType: AnomalyType.SPIKE,
          severity: AnomalySeverity.WARNING,
          value: offender.crossings,
          baseline: 0,
          zScore: 0,
          stdDev: 0,
          threshold: thresholdBytes,
          message: offender.message,
          resolved: false,
          connectionId: ctx.connectionId,
        };
        this.logger.warn(`Anomaly detected for ${ctx.connectionName}: ${event.message}`);
        await this.addAnomaly(event, ctx);
      }

      // Keep only signatures still offending so a resolved-then-recurring
      // command alerts again (mirrors activeTopologyConflicts).
      this.activeLargeReplyOffenders.set(ctx.connectionId, currentSignatures);
    } catch (err) {
      this.logger.debug(
        `Failed to check large-reply commandlog pressure for ${ctx.connectionName}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Detect fork-based-persistence copy-on-write (COW) memory blow-up / OOM risk
   * (valkey-io/valkey#3609). BGSAVE and AOF rewrite fork the server; writes
   * arriving while the child runs dirty COW-shared pages, so RSS climbs toward
   * used_memory + bytes-written-during-save and can cross available RAM, letting
   * the OOM killer terminate the server mid-save. Surfaces the LIVE risk while a
   * save runs and the PROJECTED risk (from the last save's COW) when write
   * pressure makes the next save imminent.
   *
   * State-based with escalation-only hysteresis (mirrors detectClientSaturation /
   * detectCobPressure): the finding is emitted on escalation, the stored level is
   * advanced ONLY after a successful emit, and it re-arms as the risk recedes.
   */
  private async detectForkMemoryRisk(
    info: Record<string, string>,
    ctx: ConnectionContext,
    timestamp: number,
  ): Promise<void> {
    const state = this.forkMemoryState.get(ctx.connectionId) ?? createForkMemoryState();
    this.forkMemoryState.set(ctx.connectionId, state);

    // Current write rate from the per-poll delta of rdb_changes_since_last_save.
    // max(0, …) absorbs the counter reset on an RDB save (and server restart);
    // null on the first poll (no baseline yet) so the projected path stays quiet
    // until a rate can be measured.
    let writeRatePerSec: number | null = null;
    const currentChanges = this.parseNumber(info.rdb_changes_since_last_save);
    if (currentChanges !== null) {
      const prev = this.forkMemLastChanges.get(ctx.connectionId);
      if (prev !== undefined) {
        const dtSec = (timestamp - prev.ts) / 1000;
        if (dtSec > 0) {
          writeRatePerSec = Math.max(0, currentChanges - prev.changes) / dtSec;
        }
      }
      this.forkMemLastChanges.set(ctx.connectionId, { changes: currentChanges, ts: timestamp });
    }

    const finding = evaluateForkMemoryRisk(state, {
      bgsaveInProgress: info.rdb_bgsave_in_progress === '1',
      aofRewriteInProgress: info.aof_rewrite_in_progress === '1',
      currentCowSize: this.parseNumber(info.current_cow_size),
      rdbLastCowSize: this.parseNumber(info.rdb_last_cow_size),
      aofLastCowSize: this.parseNumber(info.aof_last_cow_size),
      latestForkUsec: this.parseNumber(info.latest_fork_usec),
      usedMemory: this.parseNumber(info.used_memory) ?? 0,
      usedMemoryRss: this.parseNumber(info.used_memory_rss),
      totalSystemMemory: this.parseNumber(info.total_system_memory),
      writeRatePerSec,
      timestamp,
    });

    if (finding === null) return;

    const isCritical = finding.level === 'critical';
    const event: AnomalyEvent = {
      id: randomUUID(),
      timestamp,
      metricType: MetricType.FORK_MEMORY_RISK,
      anomalyType: AnomalyType.SPIKE,
      severity: isCritical ? AnomalySeverity.CRITICAL : AnomalySeverity.WARNING,
      value: Math.round(finding.projectedFraction * 100),
      baseline: Math.round(FORK_OOM_WARN_FRACTION * 100),
      zScore: 0,
      stdDev: 0,
      // Report the boundary actually crossed, not always the WARN fraction.
      threshold: Math.round((isCritical ? FORK_OOM_CRIT_FRACTION : FORK_OOM_WARN_FRACTION) * 100),
      message: `${isCritical ? 'CRITICAL' : 'WARNING'}: ${finding.message}`,
      resolved: false,
      connectionId: ctx.connectionId,
    };
    this.logger.warn(`Anomaly detected for ${ctx.connectionName}: ${event.message}`);
    // Await so a failed emit propagates to the poll error handler; the
    // acknowledged level is advanced only AFTER a successful emit, so a failed
    // escalation is retried on the next poll rather than swallowed by hysteresis.
    await this.addAnomaly(event, ctx);
    acknowledgeForkMemoryFinding(state, finding);
  }

  /**
   * Whether client-buffer eviction is active for this connection. Cached once from
   * `maxmemory-clients` (getConfigValue): a value of "0" means eviction is disabled
   * so evicted_clients can't climb and we skip the detector. On an unreadable or
   * absent config we default to enabled (better to arm than to miss a real storm).
   */
  private async clientEvictionEnabled(ctx: ConnectionContext): Promise<boolean> {
    let limit = this.clientEvictionLimit.get(ctx.connectionId);
    if (limit === undefined) {
      try {
        limit = (await ctx.client.getConfigValue('maxmemory-clients')) ?? '';
      } catch {
        limit = '';
      }
      this.clientEvictionLimit.set(ctx.connectionId, limit);
    }
    return limit.trim() !== '0';
  }

  /**
   * Message for a client-eviction spike. Surfaces the maxmemory-clients limit and
   * current client-buffer memory so operators can tell the justified case (real
   * client-buffer pressure) from the over-aggressive one (valkey#4151), where the
   * same eviction happens with comfortable headroom below the limit.
   */
  private describeClientEviction(
    delta: number,
    info: Record<string, string>,
    connectionId: string,
    severity: AnomalySeverity,
  ): string {
    const limit = this.clientEvictionLimit.get(connectionId)?.trim() || 'unset';
    const memClients = info['mem_clients_normal'];
    // mem_clients_normal is sampled in the same poll that already saw the eviction,
    // i.e. AFTER eviction freed buffers — it reflects post-reclaim memory, not the
    // pressure that triggered the eviction. Surface it with that caveat rather than
    // letting a low reading be misread as headroom (a false over-aggressive signal).
    const memPart = memClients
      ? ` Post-eviction client-buffer memory ~${memClients} bytes (sampled after buffers were ` +
        `reclaimed, so it understates the pre-eviction peak).`
      : '';
    return (
      `${severity.toUpperCase()}: ${delta} Valkey client${delta === 1 ? '' : 's'} disconnected by ` +
      `maxmemory-clients eviction in the last interval (maxmemory-clients=${limit}).${memPart} ` +
      `Eviction has already freed buffers, so this snapshot alone can't separate an over-aggressive ` +
      `eviction from a justified one: if evictions recur while the limit sits well above steady-state ` +
      `client memory, eviction may be over-aggressive (valkey#4151); if they cluster with rising ` +
      `client-buffer memory, it is genuine pressure — raise maxmemory-clients or investigate large ` +
      `client output buffers (pub/sub, MONITOR, oversized replies).`
    );
  }

  private static readonly COB_LIMIT_RECHECK_POLLS = 60;

  /**
   * Replication output-buffer pressure (valkey-io/valkey#3963). Standalone
   * primaries and primaries with zero replicas (and no pending state) add no
   * command overhead. CLIENT LIST being unavailable degrades to the
   * mem_clients_slaves aggregate (which still needs the limit triplet for a
   * ratio); CONFIG GET being unavailable degrades further, to the
   * growth-gated sync_full delta alone. Neither crashes the poll. The limit
   * triplet is cached and re-read on a slow cadence so a runtime CONFIG SET
   * is eventually picked up; a failed read retries next poll instead of
   * pinning one value forever.
   */
  private async detectCobPressure(
    info: Record<string, string>,
    ctx: ConnectionContext,
    timestamp: number,
  ): Promise<void> {
    if (info.role !== 'master') {
      // A demoted node keeps no COB history: pressure memory and the
      // sync_full baseline from its master era would otherwise turn a
      // legitimate first sync after failback into a false resync-loop
      // CRITICAL, and its per-replica gauges would go stale.
      const hadState = this.cobState.delete(ctx.connectionId);
      this.cobLastSyncFull.delete(ctx.connectionId);
      if (hadState) {
        try {
          this.prometheusService.updateReplBufferPressure(ctx.connectionId, []);
        } catch (promErr) {
          this.logger.debug(
            `Failed to clear repl buffer gauge for ${ctx.connectionName}: ${promErr instanceof Error ? promErr.message : promErr}`,
          );
        }
      }
      return;
    }

    const connectedSlaves = this.parseNumber(info.connected_slaves) ?? 0;

    let syncFullDelta = 0;
    const syncFull = this.parseNumber(info.sync_full);
    if (syncFull !== null) {
      const prev = this.cobLastSyncFull.get(ctx.connectionId);
      if (prev !== undefined && syncFull > prev) {
        syncFullDelta = syncFull - prev;
      }
      this.cobLastSyncFull.set(ctx.connectionId, syncFull);
    }

    const state = this.cobState.get(ctx.connectionId) ?? createCobConnectionState();
    this.cobState.set(ctx.connectionId, state);

    if (connectedSlaves === 0 && state.replicas.size === 0 && syncFullDelta === 0) {
      return;
    }

    let limit = this.cobLimitCache.get(ctx.connectionId) ?? null;
    const countdown = this.cobLimitRecheck.get(ctx.connectionId) ?? 0;
    if (countdown > 0) {
      this.cobLimitRecheck.set(ctx.connectionId, countdown - 1);
    } else {
      try {
        const raw = await ctx.client.getConfigValue('client-output-buffer-limit');
        const parsed = parseSlaveOutputBufferLimit(raw);
        if (parsed !== null) {
          limit = parsed;
          this.cobLimitCache.set(ctx.connectionId, parsed);
          this.cobLimitRecheck.set(ctx.connectionId, AnomalyService.COB_LIMIT_RECHECK_POLLS);
        }
      } catch (cobErr) {
        this.logger.debug(
          `CONFIG GET client-output-buffer-limit failed for ${ctx.connectionName}: ${cobErr instanceof Error ? cobErr.message : cobErr}`,
        );
      }
    }

    let replicas: ReplicaObservation[] | null = [];
    if (connectedSlaves > 0) {
      try {
        const clients = await ctx.client.getClients({ type: 'replica' });
        replicas = clients.map((c) => {
          return { addr: c.addr, omem: c.omem };
        });
      } catch (listErr) {
        this.logger.debug(
          `CLIENT LIST TYPE replica failed for ${ctx.connectionName}: ${listErr instanceof Error ? listErr.message : listErr}`,
        );
        replicas = null;
      }
    }

    // Published even when ratios are uncomputable (unlimited/unreadable limit,
    // CLIENT LIST denied): an empty set removes stale per-replica series so a
    // runtime switch to `slave 0 0 0` doesn't leave dashboards showing
    // outdated pressure.
    const hardBytes = limit !== null ? limit.hardBytes : 0;
    const gaugeEntries =
      replicas !== null && hardBytes > 0
        ? replicas.map((r) => {
            return { replica: r.addr, ratio: r.omem / hardBytes };
          })
        : [];
    try {
      this.prometheusService.updateReplBufferPressure(ctx.connectionId, gaugeEntries);
    } catch (promErr) {
      this.logger.debug(
        `Failed to update repl buffer gauge for ${ctx.connectionName}: ${promErr instanceof Error ? promErr.message : promErr}`,
      );
    }

    const findings = evaluateCobPressure(state, {
      replicas,
      limit,
      memClientsSlaves: this.parseNumber(info.mem_clients_slaves),
      connectedSlaves,
      syncFullDelta,
      timestamp,
    });

    for (const finding of findings) {
      const isCritical = finding.level === 'critical';
      const event: AnomalyEvent = {
        id: randomUUID(),
        timestamp,
        metricType: MetricType.REPL_BUFFER_PRESSURE,
        anomalyType: AnomalyType.SPIKE,
        severity: isCritical ? AnomalySeverity.CRITICAL : AnomalySeverity.WARNING,
        value: finding.ratio !== null ? Math.round(finding.ratio * 100) : 0,
        baseline:
          finding.kind === 'soft-sustained' ? (limit?.softBytes ?? 0) : (limit?.hardBytes ?? 0),
        zScore: 0,
        stdDev: 0,
        threshold: Math.round(COB_WARN_RATIO * 100),
        message: `${isCritical ? 'CRITICAL' : 'WARNING'}: ${finding.message}`,
        resolved: false,
        connectionId: ctx.connectionId,
      };
      this.logger.warn(`Anomaly detected for ${ctx.connectionName}: ${event.message}`);
      await this.addAnomaly(event, ctx);
      acknowledgeCobFinding(state, finding);
    }
  }

  /**
   * Detect non-dataset memory overhead consuming the maxmemory budget
   * (valkey-io/valkey#1792). Operational overhead (used_memory_overhead minus
   * the fixed startup baseline) is charged against the same maxmemory budget as
   * user data, so when it grows it shrinks the room for the dataset and, under
   * an eviction policy, drives eviction of keys that would otherwise fit.
   *
   * State-based with escalation-only hysteresis (mirrors detectClientSaturation
   * and detectCobPressure): the finding is emitted only when the level escalates
   * above the acknowledged level, and the ackedLevel is advanced only AFTER a
   * successful emit so a failed emit retries on the next poll.
   */
  private async detectMemoryOverhead(
    info: Record<string, string>,
    ctx: ConnectionContext,
    timestamp: number,
  ): Promise<void> {
    // evicted_keys is a lifetime counter, so feed the per-poll delta. max(0, …)
    // absorbs a counter reset (server restart), like the rejected_connections
    // block above. Tracked BEFORE the maxmemory gate so a stretch with
    // maxmemory unset keeps the baseline current — otherwise the first poll
    // after maxmemory is restored would absorb every eviction from the gap as a
    // single spike and flip the eviction-driven CRITICAL.
    const currentEvicted = this.parseNumber(info.evicted_keys);
    let evictedKeysDelta = 0;
    if (currentEvicted !== null) {
      const lastEvicted = this.memOverheadLastEvictedKeys.get(ctx.connectionId);
      evictedKeysDelta = Math.max(0, currentEvicted - (lastEvicted ?? currentEvicted));
      this.memOverheadLastEvictedKeys.set(ctx.connectionId, currentEvicted);
    }

    const maxmemory = this.parseNumber(info.maxmemory);
    // No eviction budget → the pure detector returns null anyway; skip early.
    if (maxmemory === null || maxmemory <= 0) return;

    const usedMemory = this.parseNumber(info.used_memory);
    const usedMemoryOverhead = this.parseNumber(info.used_memory_overhead);
    const usedMemoryStartup = this.parseNumber(info.used_memory_startup);
    if (usedMemory === null || usedMemoryOverhead === null || usedMemoryStartup === null) {
      return;
    }

    const state = this.memoryOverheadState.get(ctx.connectionId) ?? createMemoryOverheadState();
    this.memoryOverheadState.set(ctx.connectionId, state);

    const finding = evaluateMemoryOverhead(state, {
      usedMemory,
      usedMemoryOverhead,
      usedMemoryStartup,
      usedMemoryDataset: this.parseNumber(info.used_memory_dataset) ?? 0,
      usedMemoryDatasetPerc: this.parseNumber(info.used_memory_dataset_perc),
      maxmemory,
      maxmemoryPolicy: info.maxmemory_policy ?? 'noeviction',
      components: {
        clientsNormal: this.parseNumber(info.mem_clients_normal) ?? 0,
        clientsSlaves: this.parseNumber(info.mem_clients_slaves) ?? 0,
        replBacklog: this.parseNumber(info.mem_replication_backlog) ?? 0,
        replBuffers: this.parseNumber(info.mem_total_replication_buffers) ?? 0,
        aofBuffer: this.parseNumber(info.mem_aof_buffer) ?? 0,
        scriptsFunctions:
          (this.parseNumber(info.used_memory_scripts) ?? 0) +
          (this.parseNumber(info.used_memory_functions) ?? 0),
        clusterLinks: this.parseNumber(info.mem_cluster_links) ?? 0,
      },
      evictedKeysDelta,
      timestamp,
    });

    if (finding === null) return;

    let severity = AnomalySeverity.INFO;
    if (finding.level === 'critical') {
      severity = AnomalySeverity.CRITICAL;
    } else if (finding.level === 'warning') {
      severity = AnomalySeverity.WARNING;
    }
    const event: AnomalyEvent = {
      id: randomUUID(),
      timestamp,
      metricType: MetricType.MEMORY_OVERHEAD,
      anomalyType: AnomalyType.SPIKE,
      severity,
      value: finding.overheadBytes,
      baseline: maxmemory,
      zScore: 0,
      stdDev: 0,
      // Boundary actually crossed (the detector distinguishes the fraction vs
      // eviction-driven CRITICAL), so value stays consistent with threshold.
      threshold: Math.round(maxmemory * finding.thresholdFraction),
      message: finding.message,
      resolved: false,
      connectionId: ctx.connectionId,
    };
    if (severity === AnomalySeverity.INFO) {
      this.logger.log(`Advisory for ${ctx.connectionName}: ${event.message}`);
    } else {
      this.logger.warn(`Anomaly detected for ${ctx.connectionName}: ${event.message}`);
    }
    // Await the emit so a failure propagates; advance ackedLevel only AFTER a
    // successful emit so a failed escalation is retried next poll.
    await this.addAnomaly(event, ctx);
    acknowledgeMemoryOverheadFinding(state, finding);
  }

  /**
   * Control-plane saturation (valkey-io/valkey#3927): sustained ≥90% CPU
   * paired with control-plane impact evidence — probe RTT spike, replica
   * drops (a lone single drop needs a second signal; see the detector), or a
   * recent replication/cluster/COB anomaly. Emits one synthetic
   * CRITICAL CPU_UTILIZATION event per episode; the correlator maps its
   * structural marker to CONTROL_PLANE_SATURATION. CPU alone never fires.
   */
  private async detectControlPlaneSaturation(
    info: Record<string, string>,
    ctx: ConnectionContext,
    timestamp: number,
    cpuUtilization: number | null,
    probeRttMs: number,
    cpuCounterReset: boolean,
  ): Promise<void> {
    const state = this.controlPlaneState.get(ctx.connectionId) ?? createControlPlaneState();
    this.controlPlaneState.set(ctx.connectionId, state);

    const connectedSlaves = this.parseNumber(info.connected_slaves);
    let replicaDropCount = 0;
    if (connectedSlaves !== null) {
      const prev = this.cpSatLastConnectedSlaves.get(ctx.connectionId);
      if (prev !== undefined && connectedSlaves < prev) {
        replicaDropCount = prev - connectedSlaves;
      }
      this.cpSatLastConnectedSlaves.set(ctx.connectionId, connectedSlaves);
    }

    const recentControlPlaneEvents = this.recentAnomalies
      .filter((a) => {
        return (
          a.connectionId === ctx.connectionId &&
          timestamp - a.timestamp <= SATURATION_CORROBORATION_WINDOW_MS &&
          CONTROL_PLANE_CORROBORATING_METRICS.includes(a.metricType) &&
          isControlPlaneSaturationEvent(a) === false
        );
      })
      .map((a) => {
        return { metricType: a.metricType as string, timestamp: a.timestamp };
      });

    const finding = evaluateControlPlaneSaturation(state, {
      cpuUtilization,
      cpuCounterReset,
      probeRttMs,
      replicaDropCount,
      recentControlPlaneEvents,
      timestamp,
    });
    if (finding === null) {
      return;
    }

    const event = createControlPlaneSaturationEvent(
      finding,
      randomUUID(),
      timestamp,
      ctx.connectionId,
    );
    this.logger.warn(`Anomaly detected for ${ctx.connectionName}: ${event.message}`);
    await this.addAnomaly(event, ctx);
    acknowledgeSaturationFinding(state, timestamp);
  }

  private static readonly RAFT_CHURN_WINDOW_MS = 60_000;
  private static readonly RAFT_CHURN_MIN_ELECTIONS = 3;
  // The leaderless windows are derived from cluster-node-timeout (see
  // raftLeaderlessWindows): a quorum-lost node re-enters candidate/pre-candidate
  // within ~1 election timeout (randomised up to ~2x node-timeout), so the
  // recovery window must exceed that to avoid closing between the seeks of an
  // oscillating outage, while still being short enough that a one-off blip
  // settles and clears before the (larger) fire window elapses.
  private static readonly RAFT_DEFAULT_NODE_TIMEOUT_MS = 15_000;
  private static readonly RAFT_RECOVERED_FLOOR_MS = 30_000;
  // Clamp the node-timeout used for sizing (not the derived window): the recovery
  // window must stay 3x node-timeout to exceed the ~2x inter-seek gap, so bounding
  // the *input* keeps that invariant for every realistic tuning (this covers up to
  // a 5-minute node-timeout) while still bounding worst-case detection latency.
  private static readonly RAFT_MAX_NODE_TIMEOUT_MS = 300_000;
  private static readonly RAFT_FIRE_MARGIN_MS = 10_000;
  // When cluster-node-timeout is unreadable we fall back to the default window but
  // keep retrying the lookup every this-many polls — so we neither hammer CONFIG on
  // every poll (an ACL-restricted read) nor pin the wrong default forever if the
  // read only fails transiently at startup on a cluster with a larger real timeout.
  private static readonly RAFT_NODE_TIMEOUT_RECHECK_POLLS = 60;

  /**
   * Health of a Valkey Raft cluster (Cluster V2, `cluster-protocol raft`), from
   * the connected node's `CLUSTER INFO`. No-op in gossip mode. Two signals,
   * calibrated against a live 3-node Raft cluster (majority killed, sampled 60s):
   *
   * - **Leaderless / quorum loss (CRITICAL):** the node repeatedly seeks a
   *   leader (`candidate`/`pre-candidate`) it cannot elect while the commit index
   *   stays frozen. `cluster_state` is deliberately NOT used — a surviving
   *   replica keeps reporting `cluster_state:ok` through a majority outage. A
   *   watch opens when seeking begins and fires only if the node keeps failing to
   *   settle for the fire window. The watch closes (no alert) when a leader
   *   emerges, the commit index advances, or the node stops seeking for the
   *   recovery window — so a one-off election blip that re-hears its leader on an
   *   idle cluster (commit never advances, role never becomes leader) settles and
   *   clears instead of firing a false CRITICAL. Both windows are derived from
   *   cluster-node-timeout (see raftLeaderlessWindows) so the recovery window
   *   always exceeds one flap period regardless of how the cluster is tuned.
   * - **Election churn (WARNING):** the term advancing repeatedly in a short
   *   window. The pre-vote protocol means the term only rises on a *completed*
   *   election, so rapid term growth = genuine flapping leadership (with quorum),
   *   distinct from the term-frozen seeking of an outage.
   */
  /**
   * Leaderless watch windows, scaled to the cluster's `cluster-node-timeout`
   * (fetched once per connection, cached). A quorum-lost node re-seeks within
   * ~1 election timeout — randomised up to ~2x node-timeout — so the recovery
   * window is 3x node-timeout (comfortably above the max inter-seek gap) and the
   * fire window is one more timeout beyond that, guaranteeing a one-off blip
   * recovers before it could fire while an oscillating outage never settles.
   */
  private async raftLeaderlessWindows(
    ctx: ConnectionContext,
  ): Promise<{ recoveredMs: number; fireMs: number }> {
    let nodeTimeout = this.raftNodeTimeoutMs.get(ctx.connectionId);
    // nodeTimeout is only ever cached once a REAL positive value is read. While
    // it's unknown we retry the lookup, but only every RECHECK_POLLS polls so an
    // unreadable CONFIG isn't hammered — falling back to the default window in the
    // meantime and picking up the real value as soon as CONFIG becomes readable.
    if (nodeTimeout === undefined) {
      const countdown = this.raftNodeTimeoutRecheck.get(ctx.connectionId) ?? 0;
      if (countdown > 0) {
        this.raftNodeTimeoutRecheck.set(ctx.connectionId, countdown - 1);
      } else {
        let fetched: number | undefined;
        try {
          const raw = await ctx.client.getConfigValue('cluster-node-timeout');
          const n = raw != null ? parseInt(raw, 10) : NaN;
          if (Number.isFinite(n) && n > 0) fetched = n;
        } catch {
          // fetched stays undefined
        }
        if (fetched !== undefined) {
          nodeTimeout = fetched;
          this.raftNodeTimeoutMs.set(ctx.connectionId, nodeTimeout);
          this.raftNodeTimeoutRecheck.delete(ctx.connectionId);
        } else {
          // Back off before the next attempt; keep using the default until then.
          this.raftNodeTimeoutRecheck.set(
            ctx.connectionId,
            AnomalyService.RAFT_NODE_TIMEOUT_RECHECK_POLLS,
          );
        }
      }
    }
    const effective = Math.min(
      AnomalyService.RAFT_MAX_NODE_TIMEOUT_MS,
      nodeTimeout ?? AnomalyService.RAFT_DEFAULT_NODE_TIMEOUT_MS,
    );
    const recoveredMs = Math.max(AnomalyService.RAFT_RECOVERED_FLOOR_MS, 3 * effective);
    const fireMs = recoveredMs + Math.max(AnomalyService.RAFT_FIRE_MARGIN_MS, effective);
    return { recoveredMs, fireMs };
  }

  /**
   * The connection's currently-active CRITICAL raft_health incidents, from the
   * SAME authoritative (storage-backed) feed the panel/banner read. Using this
   * rather than the in-memory ring makes "is the outage still pinned?" agree with
   * what the UI shows: an event evicted from the ring but still unresolved in
   * storage counts as live (no duplicate emit), and one resolved/removed from the
   * ring counts as gone (re-emit to keep the pin).
   */
  private async getActiveRaftOutages(connectionId: string): Promise<AnomalyEvent[]> {
    try {
      return await this.getRecentAnomalies(
        undefined,
        undefined,
        AnomalySeverity.CRITICAL,
        MetricType.RAFT_HEALTH,
        100,
        connectionId,
        true,
      );
    } catch {
      // Storage unavailable — fall back to the in-memory cache. This must NOT
      // pretend an outage is pinned when nothing is: with storage down and an
      // empty cache we return [], so a first quorum loss still emits a CRITICAL
      // (which the cache holds and the webhook delivers); an already-emitted one
      // is still in the cache, so we don't duplicate it.
      return this.recentAnomalies.filter(
        (e) =>
          !e.resolved &&
          e.severity === AnomalySeverity.CRITICAL &&
          e.metricType === MetricType.RAFT_HEALTH &&
          e.connectionId === connectionId,
      );
    }
  }

  /**
   * Resolve every active CRITICAL raft_health incident for the connection.
   * Returns true only when all were resolved (or there were none), so callers can
   * retry on the next poll after a storage blip.
   */
  private async resolveRaftOutages(connectionId: string): Promise<boolean> {
    const active = await this.getActiveRaftOutages(connectionId);
    let allResolved = true;
    for (const ev of active) {
      let ok = false;
      try {
        ok = await this.resolveAnomaly(ev.id);
      } catch {
        ok = false;
      }
      if (!ok) allResolved = false;
    }
    return allResolved;
  }

  private async detectRaftHealth(
    clusterInfo: Record<string, string>,
    ctx: ConnectionContext,
    timestamp: number,
  ): Promise<void> {
    const state = parseRaftState(clusterInfo);
    if (!state) {
      // Gossip mode — clear any stale Raft state so a later switch re-arms cleanly.
      this.raftPrevTerm.delete(ctx.connectionId);
      this.raftTermChanges.delete(ctx.connectionId);
      this.raftLeaderlessSince.delete(ctx.connectionId);
      this.raftWatchCommit.delete(ctx.connectionId);
      this.raftLastSeeking.delete(ctx.connectionId);
      // If an outage was open, resolve its incident(s) before the protocol switch
      // so nothing stays stuck active; keep the flag to retry on a resolve failure.
      if (this.raftLeaderlessActive.get(ctx.connectionId)) {
        if (await this.resolveRaftOutages(ctx.connectionId)) {
          this.raftLeaderlessActive.set(ctx.connectionId, false);
        }
      }
      return;
    }

    // --- Election churn ---
    // Record any new election (aging out old ones), persist BEFORE emitting, and
    // re-check the threshold every poll — not only on a term transition. That way
    // an addAnomaly failure doesn't drop the election (it stays in the window) and
    // the WARNING is retried on the next poll even after leadership stabilises.
    const prevTerm = this.raftPrevTerm.get(ctx.connectionId);
    this.raftPrevTerm.set(ctx.connectionId, state.currentTerm);
    const churnCutoff = timestamp - AnomalyService.RAFT_CHURN_WINDOW_MS;
    const isNewElection = prevTerm !== undefined && state.currentTerm > prevTerm;
    const recent = [
      ...(this.raftTermChanges.get(ctx.connectionId) ?? []),
      ...(isNewElection ? [timestamp] : []),
    ].filter((t) => t >= churnCutoff);
    this.raftTermChanges.set(ctx.connectionId, recent);
    if (recent.length >= AnomalyService.RAFT_CHURN_MIN_ELECTIONS) {
      const event: AnomalyEvent = {
        id: randomUUID(),
        timestamp,
        metricType: MetricType.RAFT_HEALTH,
        anomalyType: AnomalyType.SPIKE,
        severity: AnomalySeverity.WARNING,
        value: state.currentTerm,
        baseline: 0,
        zScore: 0,
        stdDev: 0,
        threshold: AnomalyService.RAFT_CHURN_MIN_ELECTIONS,
        message:
          `WARNING: Raft leadership is flapping — ${recent.length} elections in ` +
          `${Math.round(AnomalyService.RAFT_CHURN_WINDOW_MS / 1000)}s (now term ${state.currentTerm}). ` +
          `Investigate an unstable/overloaded primary or a split network in the Valkey Cluster V2 (Raft) group.`,
        resolved: false,
        connectionId: ctx.connectionId,
      };
      this.logger.warn(`Anomaly detected for ${ctx.connectionName}: ${event.message}`);
      await this.addAnomaly(event, ctx);
      this.raftTermChanges.set(ctx.connectionId, []); // dedupe: clear only after a successful emit
    }

    // --- Leaderless / quorum loss ---
    // A leader only holds office with a majority, so `role:leader` is proof of
    // quorum. Otherwise we run a "leaderless watch": it opens the moment the node
    // starts seeking (candidate/pre-candidate) and stays open while it keeps
    // seeking OR sits as a follower that makes no commit progress (during an
    // outage the role oscillates follower↔pre-candidate with the commit index
    // frozen). `raftLastSeeking` tracks the last poll the node was actually
    // seeking. The watch closes — quorum is fine — when the node becomes a
    // leader, the commit index advances past where the watch started (a leader
    // emerged and committed), OR the node has stopped seeking for
    // RAFT_RECOVERED_MS (it settled back under a live leader). That last clause is
    // what distinguishes a real outage (keeps re-seeking every ~node-timeout,
    // never settles) from a one-off blip on an idle cluster (seeks once, then
    // stays a quiet follower with an unchanged commit index).
    const { recoveredMs, fireMs } = await this.raftLeaderlessWindows(ctx);
    const seeking = isRaftSeeking(state);
    if (seeking) this.raftLastSeeking.set(ctx.connectionId, timestamp);
    const watching = this.raftLeaderlessSince.has(ctx.connectionId);
    const watchCommit = this.raftWatchCommit.get(ctx.connectionId);
    const madeProgress = watching && watchCommit !== undefined && state.commitIndex > watchCommit;
    const lastSeeking = this.raftLastSeeking.get(ctx.connectionId);
    const settled =
      watching && !seeking && lastSeeking !== undefined && timestamp - lastSeeking >= recoveredMs;

    // An active outage this poll = the node is seeking (or watching an already-open
    // outage) with no recovery signal. Anything else is treated as healthy.
    const recovered = state.role === 'leader' || madeProgress || settled;
    if (!recovered && (seeking || watching)) {
      // Seeking a leader, or already watching an unresolved outage.
      if (!watching) {
        this.raftLeaderlessSince.set(ctx.connectionId, timestamp);
        this.raftWatchCommit.set(ctx.connectionId, state.commitIndex);
      }
      const since = this.raftLeaderlessSince.get(ctx.connectionId)!;
      // Keep exactly one active CRITICAL incident present for the whole outage:
      // (re-)emit only when the authoritative feed currently has none for this
      // connection. That feed (storage-backed, same as the UI) treats an evicted-
      // but-unresolved event as still live (so we don't duplicate) and a
      // dismissed/removed one as gone (so we re-emit and the pin comes back).
      //
      // The FIRST fire is gated on the node actively seeking: the fire clock runs
      // from watch-open (`since`) but recovery (`settled`) runs from the last seek,
      // so a node that sought for a while then quietly recovered into an idle
      // follower must not trip a CRITICAL in the gap before `settled` closes the
      // watch. Once the outage is confirmed (raftLeaderlessActive set), we keep the
      // pin alive on EVERY poll regardless of the follower↔pre-candidate flap — so
      // a dismiss landing on a follower beat is re-pinned immediately, not left
      // green until the next seek.
      const outageConfirmed = this.raftLeaderlessActive.get(ctx.connectionId) === true;
      if (timestamp - since >= fireMs && (seeking || outageConfirmed)) {
        const active = await this.getActiveRaftOutages(ctx.connectionId);
        // Mark the outage active regardless (so recovery knows to resolve later),
        // then emit only when nothing is currently pinned.
        this.raftLeaderlessActive.set(ctx.connectionId, true);
        if (active.length === 0) {
          const heldMs = timestamp - since;
          const event: AnomalyEvent = {
            id: randomUUID(),
            timestamp,
            metricType: MetricType.RAFT_HEALTH,
            anomalyType: AnomalyType.DROP,
            severity: AnomalySeverity.CRITICAL,
            value: 0,
            baseline: 1,
            zScore: 0,
            stdDev: 0,
            threshold: 0,
            message:
              `CRITICAL: Valkey Cluster V2 (Raft) has no reachable leader — this node has been ` +
              `unable to elect one for ${Math.round(heldMs / 1000)}s ` +
              `(role=${state.role}, term=${state.currentTerm}, commit index frozen at ${state.commitIndex}). ` +
              `A majority of Raft voters is unreachable — the commit log is frozen and writes are refused ` +
              `(CLUSTERDOWN). Note cluster_state may still read "ok" on this node. ` +
              `Restore quorum by recovering the failed node(s).`,
            resolved: false,
            connectionId: ctx.connectionId,
          };
          this.logger.warn(`Anomaly detected for ${ctx.connectionName}: ${event.message}`);
          await this.addAnomaly(event, ctx);
        }
      }
    } else {
      // Healthy this poll (a leader, committed progress, a node that settled after
      // it stopped seeking, or a plain follower with a live leader). Close the watch
      // and, if an outage was flagged, resolve its incident(s). Gated on
      // raftLeaderlessActive so a healthy connection that never had an outage doesn't
      // hit storage every poll; the flag clears only once the resolve durably
      // succeeds, so it's retried on every healthy poll — including a follower
      // recovery, whose watch state is already gone — until a storage blip clears.
      this.raftLeaderlessSince.delete(ctx.connectionId);
      this.raftWatchCommit.delete(ctx.connectionId);
      this.raftLastSeeking.delete(ctx.connectionId);
      if (this.raftLeaderlessActive.get(ctx.connectionId)) {
        if (await this.resolveRaftOutages(ctx.connectionId)) {
          this.raftLeaderlessActive.set(ctx.connectionId, false);
        }
      }
    }
  }

  /**
   * Detect a stalled or failed persistence fork child (BGSAVE / AOF rewrite).
   *
   * This is state-based rather than statistical: a stuck fork shows the in-progress
   * flag set with its elapsed time climbing while save-key progress stays frozen
   * (see valkey-io/valkey#2322). Signals come from the INFO persistence section.
   */
  private async detectPersistenceStall(
    info: Record<string, string>,
    ctx: ConnectionContext,
    timestamp: number,
  ): Promise<void> {
    const state = this.lastPersistenceState.get(ctx.connectionId) ?? {};

    await this.evaluatePersistenceChild(
      'rdb',
      {
        inProgress: info['rdb_bgsave_in_progress'] === '1',
        elapsedSec: this.parseNumber(info['rdb_current_bgsave_time_sec']),
        // These two counters are intentionally NOT rdb_-prefixed in INFO persistence.
        processed: this.parseNumber(info['current_save_keys_processed']),
        total: this.parseNumber(info['current_save_keys_total']),
        lastStatus: info['rdb_last_bgsave_status'],
      },
      state,
      ctx,
      timestamp,
    );

    await this.evaluatePersistenceChild(
      'aof',
      {
        inProgress: info['aof_rewrite_in_progress'] === '1',
        elapsedSec: this.parseNumber(info['aof_current_rewrite_time_sec']),
        // AOF rewrite exposes no per-key progress counter, so frozen-progress
        // stall detection does not apply; it relies on the elapsed-time ceiling.
        processed: null,
        total: null,
        lastStatus: info['aof_last_bgrewrite_status'],
      },
      state,
      ctx,
      timestamp,
    );

    this.lastPersistenceState.set(ctx.connectionId, state);
  }

  private async evaluatePersistenceChild(
    kind: 'rdb' | 'aof',
    signals: {
      inProgress: boolean;
      elapsedSec: number | null;
      processed: number | null;
      total: number | null;
      lastStatus: string | undefined;
    },
    state: ConnectionPersistenceState,
    ctx: ConnectionContext,
    timestamp: number,
  ): Promise<void> {
    // Completed-status error (e.g. failed BGSAVE — the case #2322 users disable
    // stop-writes-on-bgsave-error around). Level-triggered, not edge-triggered:
    // fire whenever the status is err rather than only on an ok->err transition,
    // so a pre-existing error at monitor/connection start (no prior ok baseline)
    // is caught on the first poll. A latch keeps a persisting err from re-firing
    // every poll; a later non-err (ok) sample re-arms it for the next failure.
    const status = signals.lastStatus;
    if (status !== undefined && status !== '') {
      const errorReported = kind === 'rdb' ? state.rdbErrorReported : state.aofErrorReported;
      if (status === 'err') {
        if (!errorReported) {
          await this.addAnomaly(
            this.buildPersistenceEvent(kind, 'error', 0, signals, timestamp, ctx),
            ctx,
          );
          if (kind === 'rdb') state.rdbErrorReported = true;
          else state.aofErrorReported = true;
        }
      } else if (errorReported) {
        if (kind === 'rdb') state.rdbErrorReported = false;
        else state.aofErrorReported = false;
      }
    }

    if (!signals.inProgress) {
      // Episode ended (or never started) — clear per-episode tracking.
      if (kind === 'rdb') delete state.rdb;
      else delete state.aof;
      return;
    }

    // INFO reports -1 for elapsed when no child is running; clamp to 0.
    const elapsedSec =
      signals.elapsedSec !== null && signals.elapsedSec >= 0 ? signals.elapsedSec : 0;

    let track = kind === 'rdb' ? state.rdb : state.aof;
    if (!track) {
      // First observation of this episode — establish a baseline to measure progress against.
      track = {
        startedAt: timestamp,
        lastProcessed: signals.processed ?? 0,
        lastAdvanceTs: timestamp,
        lastElapsedSec: elapsedSec,
        warnedLong: false,
        reportedStall: false,
      };
      if (kind === 'rdb') state.rdb = track;
      else state.aof = track;
      return;
    }

    // A running child's elapsed time and processed-key count are both
    // monotonic within a single episode and reset when a new fork starts.
    // Episode boundaries are otherwise inferred only from observing an idle
    // (in_progress = 0) sample, which is missed when a new child begins
    // between polls (tight save cadence, slow interval, or a failed poll).
    // Without this guard the prior track would be reused — misreporting the
    // fresh child as a stalled episode (stale lastAdvanceTs) or suppressing
    // its alerts (carried-over reportedStall/warnedLong). Detect the restart
    // via a regression in either signal and re-baseline, mirroring the
    // first-observation branch above.
    const elapsedRegressed = elapsedSec < track.lastElapsedSec;
    const processedRegressed =
      signals.processed !== null && signals.processed < track.lastProcessed;
    if (elapsedRegressed || processedRegressed) {
      track.startedAt = timestamp;
      track.lastProcessed = signals.processed ?? 0;
      track.lastAdvanceTs = timestamp;
      track.lastElapsedSec = elapsedSec;
      track.warnedLong = false;
      track.reportedStall = false;
      return;
    }
    track.lastElapsedSec = elapsedSec;

    // Advance tracking (RDB only exposes processed-keys progress).
    if (signals.processed !== null && signals.processed > track.lastProcessed) {
      track.lastProcessed = signals.processed;
      track.lastAdvanceTs = timestamp;
    }

    const stalledForMs = timestamp - track.lastAdvanceTs;
    // Frozen key progress only means "stuck" while there are still keys left to write.
    // Once all keys are serialized (processed === total) the child stays in_progress
    // through the RDB flush/fsync/rename tail, during which processed is frozen at N/N —
    // on a large save over a slow disk that tail can exceed persistenceStallSec and would
    // otherwise trip a false "appears stuck (processed N/N keys)". A genuine hang in that
    // tail is still caught by the elapsed-time ceiling (tooLong).
    //
    // We can only assert "keys remain" when the total is known. If current_save_keys_total
    // is absent (processed reported without a total) we can't tell the completion tail from a
    // real stall, so we skip frozen-progress detection entirely and rely on the elapsed-time
    // thresholds — consistent with not raising a CRITICAL we can't substantiate.
    const progressIncomplete = signals.total !== null && signals.processed! < signals.total;
    const frozenStall =
      signals.processed !== null &&
      progressIncomplete &&
      stalledForMs >= this.persistenceStallSec * 1000;
    const tooLong = elapsedSec >= this.persistenceCritSec;

    if (!track.reportedStall && (frozenStall || tooLong)) {
      track.reportedStall = true;
      // Frozen key progress and the elapsed-time ceiling are distinct failures
      // with different thresholds and messages. Prefer the frozen-progress
      // reason when both trip (a stuck child is the more actionable signal).
      const reason = frozenStall ? 'stall' : 'exceeded';
      await this.addAnomaly(
        this.buildPersistenceEvent(kind, reason, elapsedSec, signals, timestamp, ctx),
        ctx,
      );
      return;
    }

    if (!track.reportedStall && !track.warnedLong && elapsedSec >= this.persistenceWarnSec) {
      track.warnedLong = true;
      await this.addAnomaly(
        this.buildPersistenceEvent(kind, 'long', elapsedSec, signals, timestamp, ctx),
        ctx,
      );
    }
  }

  private buildPersistenceEvent(
    kind: 'rdb' | 'aof',
    reason: 'error' | 'stall' | 'exceeded' | 'long',
    elapsedSec: number,
    signals: { processed: number | null; total: number | null },
    timestamp: number,
    ctx: ConnectionContext,
  ): AnomalyEvent {
    const label =
      kind === 'rdb'
        ? { name: 'RDB save', op: 'BGSAVE' }
        : { name: 'AOF rewrite', op: 'BGREWRITEAOF' };
    const progress =
      signals.processed !== null && signals.total !== null
        ? ` (processed ${signals.processed}/${signals.total} keys)`
        : '';
    let severity: AnomalySeverity;
    let message: string;
    let threshold: number;

    if (reason === 'error') {
      severity = AnomalySeverity.CRITICAL;
      threshold = 0;
      message = `CRITICAL: last ${label.name} (${label.op}) reported an error — persistence may be failing`;
    } else if (reason === 'stall') {
      // Key progress frozen for persistenceStallSec while the child keeps running.
      severity = AnomalySeverity.CRITICAL;
      threshold = this.persistenceStallSec;
      message = `CRITICAL: ${label.name} (${label.op}) appears stuck — running ${elapsedSec}s with no progress${progress}`;
    } else if (reason === 'exceeded') {
      // Elapsed time crossed the persistenceCritSec ceiling; keys may still be
      // advancing, so this is a duration breach, not a frozen-progress stall.
      severity = AnomalySeverity.CRITICAL;
      threshold = this.persistenceCritSec;
      message = `CRITICAL: ${label.name} (${label.op}) exceeded the ${this.persistenceCritSec}s time ceiling — running ${elapsedSec}s${progress}`;
    } else {
      severity = AnomalySeverity.WARNING;
      threshold = this.persistenceWarnSec;
      message = `WARNING: ${label.name} (${label.op}) running long — ${elapsedSec}s elapsed`;
    }

    return {
      id: `${ctx.connectionId}-persistence-${kind}-${reason}-${timestamp}`,
      timestamp,
      metricType: MetricType.PERSISTENCE_CHILD,
      anomalyType: AnomalyType.SPIKE,
      severity,
      value: elapsedSec,
      baseline: 0,
      zScore: 0,
      stdDev: 0,
      threshold,
      message,
      resolved: false,
      connectionId: ctx.connectionId,
    };
  }

  /**
   * Detects two primaries claiming overlapping slots (the topology fault behind
   * valkey-io/valkey#2261) from this connection's `CLUSTER NODES` view. Emits one
   * CRITICAL anomaly per distinct conflict and clears the dedupe entry once the
   * conflict resolves, so recovery re-arms alerting.
   */
  private async detectDuplicatePrimaries(
    ctx: ConnectionContext,
    timestamp: number,
    nodes: ClusterNode[],
  ): Promise<void> {
    try {
      const conflicts = detectDuplicatePrimaries(nodes);

      const active = this.activeTopologyConflicts.get(ctx.connectionId) ?? new Set<string>();
      const currentSignatures = new Set(conflicts.map((c) => conflictSignature(c)));

      for (const conflict of conflicts) {
        const signature = conflictSignature(conflict);
        if (active.has(signature)) continue; // already alerted for this conflict

        const [authoritative, phantom] = conflict.masters;
        const slotLabel =
          conflict.slotStart === conflict.slotEnd
            ? `slot ${conflict.slotStart}`
            : `slots ${conflict.slotStart}-${conflict.slotEnd}`;

        const event: AnomalyEvent = {
          id: `${ctx.connectionId}-dup-primary-${signature}-${timestamp}`,
          timestamp,
          metricType: MetricType.CLUSTER_TOPOLOGY,
          anomalyType: AnomalyType.SPIKE,
          severity: AnomalySeverity.CRITICAL,
          value: 2,
          baseline: 1,
          zScore: 0,
          stdDev: 0,
          threshold: 1,
          message:
            `CRITICAL: Two primaries claim ${slotLabel} in the same shard — split-brain topology. ` +
            `${phantom.address} (${phantom.id.substring(0, 8)}, configEpoch ${phantom.configEpoch}) ` +
            `is the suspected stale primary and should be a replica of ` +
            `${authoritative.address} (${authoritative.id.substring(0, 8)}, configEpoch ${authoritative.configEpoch}).`,
          resolved: false,
          connectionId: ctx.connectionId,
        };

        this.logger.warn(`Anomaly detected for ${ctx.connectionName}: ${event.message}`);
        await this.addAnomaly(event, ctx);
      }

      // Keep only signatures still in conflict so a resolved-then-recurring
      // conflict alerts again. (A CLUSTER NODES observation gap is handled at the
      // poll level, which clears this set so a missed heal re-alerts.)
      this.activeTopologyConflicts.set(ctx.connectionId, currentSignatures);
    } catch (topologyErr) {
      this.logger.debug(
        `Failed to check cluster topology for ${ctx.connectionName}: ${topologyErr instanceof Error ? topologyErr.message : topologyErr}`,
      );
    }
  }

  /**
   * How long an orphaned (replica, primary) pair must persist before it is
   * alerted, to exclude the transient orphaned window of a normal failover. A
   * healthy failover promotes/re-points the replica well within a few cluster
   * node timeouts; a stuck replica (valkey#2090) stays orphaned indefinitely.
   */
  private static readonly STUCK_REPLICA_MIN_PERSIST_MS = 30_000;

  /**
   * Detects a replica orphaned by a lost/replaced primary that never re-attaches
   * (valkey-io/valkey#2090) from this connection's `CLUSTER NODES` view. Emits a
   * WARNING once the orphaned pair has persisted past the failover grace window,
   * dedupes per (replica, primary) pair, and clears state on recovery so a
   * resolved-then-recurring stuck replica alerts again.
   */
  private async detectStuckReplicas(
    ctx: ConnectionContext,
    timestamp: number,
    nodes: ClusterNode[],
  ): Promise<void> {
    try {
      await this.applyTopologyPersistenceGate({
        ctx,
        timestamp,
        findings: detectStuckReplicas(nodes),
        signatureOf: stuckReplicaSignature,
        firstSeenByConn: this.stuckReplicaFirstSeen,
        activeByConn: this.activeStuckReplicas,
        minPersistMs: AnomalyService.STUCK_REPLICA_MIN_PERSIST_MS,
        buildEvent: (s, signature) => {
          const primaryLabel =
            s.reason === 'primary_unknown'
              ? `unknown primary ${s.primaryId.substring(0, 8)} (absent from the cluster view)`
              : `failed primary ${s.primaryId.substring(0, 8)} at ${s.primaryAddress}`;
          return {
            id: `${ctx.connectionId}-stuck-replica-${signature}-${timestamp}`,
            timestamp,
            metricType: MetricType.CLUSTER_TOPOLOGY,
            anomalyType: AnomalyType.SPIKE,
            severity: AnomalySeverity.WARNING,
            value: 1,
            baseline: 0,
            zScore: 0,
            stdDev: 0,
            threshold: 0,
            message:
              `WARNING: Replica ${this.clientAddress(s.replicaAddress)} (${s.replicaId.substring(0, 8)}) is stuck replicating a ` +
              `${primaryLabel} and has not re-attached to a live primary (valkey#2090). ` +
              `If a replacement node took over this shard, run ` +
              `\`CLUSTER REPLICATE <new-primary-id>\` on ${this.clientAddress(s.replicaAddress)} to recover.`,
            resolved: false,
            connectionId: ctx.connectionId,
          };
        },
      });
    } catch (stuckErr) {
      this.logger.debug(
        `Failed to check stuck replicas for ${ctx.connectionName}: ${stuckErr instanceof Error ? stuckErr.message : stuckErr}`,
      );
    }
  }

  /**
   * How long a hostname-staleness finding (valkey#304) must persist before it
   * is alerted, to exclude the transient gossip-convergence window of a
   * normal node join/restart or a `cluster-announce-hostname` rollout. A
   * healthy convergence settles within roughly a cluster-node-timeout; a
   * genuinely stuck/inconsistent node stays that way indefinitely.
   */
  private static readonly HOSTNAME_STALENESS_MIN_PERSIST_MS = 30_000;

  /**
   * Detects hostname info that is missing (while peers have one) or
   * inconsistent between `CLUSTER NODES` and `CLUSTER SHARDS` for the same
   * node (valkey-io/valkey#304). This typically self-heals once gossip
   * converges — TLS-SNI clients and hostname-keyed routing can fail in the
   * meantime — so we emit a WARNING only once the condition has persisted
   * past the convergence grace window, deduped per (node, reason), and
   * cleared on recovery so a resolved-then-recurring case alerts again.
   */
  private async detectHostnameStaleness(
    ctx: ConnectionContext,
    timestamp: number,
    nodes: ClusterNode[],
    shards: ClusterShard[] | undefined,
  ): Promise<void> {
    try {
      await this.applyTopologyPersistenceGate({
        ctx,
        timestamp,
        findings: detectHostnameStaleness(nodes, shards),
        signatureOf: hostnameStalenessSignature,
        firstSeenByConn: this.hostnameStalenessFirstSeen,
        activeByConn: this.activeHostnameStaleness,
        minPersistMs: AnomalyService.HOSTNAME_STALENESS_MIN_PERSIST_MS,
        buildEvent: (f, signature) => {
          const addr = this.clientAddress(f.address);
          const message =
            f.reason === 'missing_hostname'
              ? `WARNING: Node ${addr} (${f.nodeId.substring(0, 8)}) has no announced hostname while other ` +
                `nodes in the cluster view do — hostname gossip has not converged for this node ` +
                `(valkey#304). TLS-SNI clients or hostname-keyed routing against this node may fail ` +
                `until it propagates. This usually self-heals; investigate if it persists.`
              : `WARNING: Node ${addr} (${f.nodeId.substring(0, 8)}) reports a different hostname in ` +
                `CLUSTER NODES (${f.nodesHostname}) than in CLUSTER SHARDS (${f.shardsHostname}) — the two ` +
                `views disagree about this node's hostname (valkey#304). TLS-SNI clients or hostname-keyed ` +
                `routing may hit the wrong endpoint until this converges. This usually self-heals; ` +
                `investigate if it persists.`;
          return {
            id: `${ctx.connectionId}-hostname-staleness-${signature}-${timestamp}`,
            timestamp,
            metricType: MetricType.HOSTNAME_STALENESS,
            anomalyType: AnomalyType.SPIKE,
            severity: AnomalySeverity.WARNING,
            value: 1,
            baseline: 0,
            zScore: 0,
            stdDev: 0,
            threshold: 0,
            message,
            resolved: false,
            connectionId: ctx.connectionId,
          };
        },
      });
    } catch (hostnameErr) {
      this.logger.debug(
        `Failed to check hostname staleness for ${ctx.connectionName}: ${hostnameErr instanceof Error ? hostnameErr.message : hostnameErr}`,
      );
    }
  }

  /**
   * How long a ghost membership (valkey#1757) must persist before it is alerted,
   * to exclude the transient re-MEET/handshake window of a normal node join or
   * failover where an endpoint may briefly carry two ids. A real ghost — an old
   * node-id peers never forgot after a reset — lingers indefinitely.
   */
  private static readonly GHOST_MEMBER_MIN_PERSIST_MS = 30_000;

  /**
   * Detects a ghost cluster member (valkey-io/valkey#1757) from this connection's
   * `CLUSTER NODES` view: an endpoint claimed by a stale (`fail`/`fail?`/`noaddr`)
   * node-id that peers never forgot after a `CLUSTER RESET`/restart, alongside the
   * live id that now occupies it. Emits a WARNING once the ghost has persisted
   * past the re-MEET grace window, dedupes per (endpoint, ids) signature, and
   * clears state on recovery so a re-appearing ghost alerts again.
   */
  private async detectGhostMembers(
    ctx: ConnectionContext,
    timestamp: number,
    nodes: ClusterNode[],
  ): Promise<void> {
    try {
      await this.applyTopologyPersistenceGate({
        ctx,
        timestamp,
        findings: detectGhostMembers(nodes),
        signatureOf: ghostMemberSignature,
        firstSeenByConn: this.ghostMemberFirstSeen,
        activeByConn: this.activeGhostMembers,
        minPersistMs: AnomalyService.GHOST_MEMBER_MIN_PERSIST_MS,
        buildEvent: (g, signature) => {
          const ghostLabel = g.ghostIds.map((id) => id.substring(0, 8)).join(', ');
          const forgetCmds = g.ghostIds.map((id) => `CLUSTER FORGET ${id}`).join('; ');
          const plural = g.ghostIds.length > 1;
          return {
            id: `${ctx.connectionId}-ghost-member-${signature}-${timestamp}`,
            timestamp,
            metricType: MetricType.GHOST_MEMBERSHIP,
            anomalyType: AnomalyType.SPIKE,
            severity: AnomalySeverity.WARNING,
            value: g.ghostIds.length,
            baseline: 0,
            zScore: 0,
            stdDev: 0,
            threshold: 0,
            message:
              `WARNING: Endpoint ${g.endpoint} is now node ${g.liveId.substring(0, 8)}, but ` +
              `stale node-id${plural ? 's' : ''} ${ghostLabel} still linger${plural ? '' : 's'} in the ` +
              `cluster view. A CLUSTER RESET/restart does not make peers forget a node (valkey#1757), ` +
              `so the old identity keeps re-joining and causing errors. Run \`${forgetCmds}\` on every ` +
              `other node in the cluster — primaries AND replicas — to fully evict the ghost; any node ` +
              `that still remembers it re-gossips it back after the 60s FORGET ban expires.`,
            resolved: false,
            connectionId: ctx.connectionId,
          };
        },
      });
    } catch (ghostErr) {
      this.logger.debug(
        `Failed to check ghost membership for ${ctx.connectionName}: ${ghostErr instanceof Error ? ghostErr.message : ghostErr}`,
      );
    }
  }

  /**
   * How long a replica slot-state anomaly (valkey#1664) must persist before it
   * is alerted, to exclude the transient window of a normal reshard/failover
   * where a node may briefly show slot state. A healthy reshard settles within a
   * few polls; a stuck replica stays inconsistent indefinitely.
   */
  private static readonly REPLICA_SLOT_STATE_MIN_PERSIST_MS = 30_000;

  /**
   * Per-command timeout for the replica slot-state fan-out. Bounds each remote
   * `CLUSTER NODES` so a blackholed replica can't hang the shared poll loop.
   * Matches the spirit of healthCheckNode's 2s ping race.
   */
  private static readonly FANOUT_COMMAND_TIMEOUT_MS = 2_000;

  /**
   * Detects a replica wrongly reporting slot migrating/importing/owned state
   * (valkey-io/valkey#1664) from a per-node-aggregated `CLUSTER NODES` view (see
   * `gatherReplicaSlotView` — migration markers are node-local, so each replica
   * must be queried directly), refined with `CLUSTER SHARDS` for role authority,
   * shard attribution, and slot-view divergence. Emits a WARNING once the
   * condition has persisted past the reshard grace window, dedupes per (replica,
   * reason, slots) signature, and — via the shared gate's auto-resolve — resolves
   * the emitted event on recovery so the activeOnly banner clears.
   */
  private async detectReplicaSlotState(
    ctx: ConnectionContext,
    timestamp: number,
    nodes: ClusterNode[],
    shards: ClusterShard[] | undefined,
    unreachableReplicaIds: Set<string> = new Set(),
  ): Promise<void> {
    try {
      // A replica we couldn't reach this poll is an observation GAP, not a
      // recovery: its base gossip line never carries node-local migrating/
      // importing markers, so its finding would vanish and the gate would restart
      // the grace clock and auto-resolve a still-open WARNING. Preserve the prior
      // state of any signature belonging to an unreachable replica (the signature
      // is `<replicaId>|<reason>|<slots>`, so the node id is the leading field) —
      // mirroring how a failed base CLUSTER NODES fetch skips detectors entirely.
      const preserveSignature = unreachableReplicaIds.size
        ? (signature: string) => unreachableReplicaIds.has(signature.split('|')[0])
        : undefined;
      await this.applyTopologyPersistenceGate({
        ctx,
        timestamp,
        findings: detectReplicaSlotState(nodes, shards),
        signatureOf: replicaSlotSignature,
        firstSeenByConn: this.replicaSlotFirstSeen,
        activeByConn: this.activeReplicaSlotAnomalies,
        eventIdsByConn: this.replicaSlotEventIds,
        minPersistMs: AnomalyService.REPLICA_SLOT_STATE_MIN_PERSIST_MS,
        metricType: MetricType.REPLICA_SLOT_STATE,
        preserveSignature,
        buildEvent: (a, signature) => ({
          id: `${ctx.connectionId}-replica-slot-state-${signature}-${timestamp}`,
          timestamp,
          metricType: MetricType.REPLICA_SLOT_STATE,
          anomalyType: AnomalyType.SPIKE,
          severity: AnomalySeverity.WARNING,
          value: 1,
          baseline: 0,
          zScore: 0,
          stdDev: 0,
          threshold: 0,
          message: this.buildReplicaSlotMessage(a),
          resolved: false,
          connectionId: ctx.connectionId,
        }),
      });
    } catch (err) {
      this.logger.debug(
        `Failed to check replica slot state for ${ctx.connectionName}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Fetch `CLUSTER SHARDS`, degrading to `undefined` (never throwing) if the
   * command is unsupported or the call fails — it is an optional refinement.
   */
  private async safeGetClusterShards(ctx: ConnectionContext): Promise<ClusterShard[] | undefined> {
    try {
      return await ctx.client.getClusterShards();
    } catch (err) {
      this.logger.debug(
        `CLUSTER SHARDS unavailable for ${ctx.connectionName}, using CLUSTER NODES only: ${err instanceof Error ? err.message : err}`,
      );
      return undefined;
    }
  }

  /**
   * Build a topology view where each replica's slot-migration state reflects its
   * OWN `CLUSTER NODES` line. Migrating/importing markers are node-local — the
   * connected node's reply annotates only its own (`myself`) line — so detecting
   * a stuck replica requires querying that replica directly. When cluster
   * discovery is unavailable, returns the base view unchanged (degrade: detection
   * then works only when the monitor connects directly to the stuck replica).
   */
  private async gatherReplicaSlotView(
    baseNodes: ClusterNode[],
    ctx: ConnectionContext,
  ): Promise<{ nodes: ClusterNode[]; unreachableIds: Set<string> }> {
    if (!this.clusterDiscovery) return { nodes: baseNodes, unreachableIds: new Set() };

    // Only fan out to reachable remote replicas. A replica flagged dead/
    // unreachable (fail/fail?/noaddr/handshake) can't provide a self-view, and
    // attempting it would burn a connection timeout every poll — worst exactly
    // when the cluster is already degraded.
    const DEAD_FLAGS = ['fail', 'fail?', 'noaddr', 'handshake'];
    const remoteReplicas = baseNodes.filter(
      (n) =>
        (n.flags.includes('slave') || n.flags.includes('replica')) &&
        !n.flags.includes('myself') &&
        !DEAD_FLAGS.some((flag) => n.flags.includes(flag)),
    );
    if (remoteReplicas.length === 0) return { nodes: baseNodes, unreachableIds: new Set() };

    const selfViews = await Promise.allSettled(
      remoteReplicas.map(async (r) => {
        const client = await this.clusterDiscovery!.getNodeConnection(r.id, ctx.connectionId);
        // Bound the command itself, not just connect(): a blackholed peer (socket
        // established but unresponsive) leaves iovalkey `ready`, so the reused
        // client's CLUSTER NODES would otherwise hang for TCP-retransmit
        // timescales. MultiConnectionPoller holds `polling` until every
        // pollConnection settles, so one hung fan-out would suspend anomaly
        // detection for ALL connections. Race a timeout the way healthCheckNode
        // does; a timeout surfaces as a rejected (unreachable) self-view.
        const raw = await this.raceWithTimeout(
          client.call('CLUSTER', 'NODES'),
          AnomalyService.FANOUT_COMMAND_TIMEOUT_MS,
          `CLUSTER NODES to replica ${r.id.substring(0, 8)} timed out`,
        );
        const self = MetricsParser.parseClusterNodes(raw as string).find((n) =>
          n.flags.includes('myself'),
        );
        return self ? { id: r.id, self } : null;
      }),
    );

    const merged = baseNodes.map((n) => ({ ...n }));
    const byId = new Map(merged.map((n) => [n.id, n]));
    const unreachableIds = new Set<string>();
    // allSettled preserves order, so selfViews[i] corresponds to remoteReplicas[i].
    selfViews.forEach((result, i) => {
      // A rejected self-view is an unreachable replica (connect/command timeout or
      // error). Track its id so detection can PRESERVE that node's prior state
      // instead of reading the absence as recovery, and surface a degraded signal
      // below — the discovery service logs each unique connect error only once.
      if (result.status === 'rejected') {
        unreachableIds.add(remoteReplicas[i].id);
        return;
      }
      if (!result.value) return;
      const target = byId.get(result.value.id);
      if (!target) return;
      const self = result.value.self;
      // Overlay the node's authoritative self-reported view: its ROLE (flags +
      // master) as well as its slot state. The connected node's gossip flags can
      // be stale — e.g. it still calls a just-promoted node a `slave` — and so
      // can the same-origin CLUSTER SHARDS role. Trusting the node's own line
      // prevents flagging a live primary that now legitimately owns slots as a
      // divergent replica (which would emit CLUSTER REPLICATE advice demoting it).
      // Strip `myself` — that flag is relative to the queried node, not this view.
      target.flags = self.flags.filter((flag) => flag !== 'myself');
      target.master = self.master;
      target.slots = self.slots;
      target.migratingSlots = self.migratingSlots;
      target.importingSlots = self.importingSlots;
    });

    // Log only on a change in the degraded count (the poll runs ~1/s, so an
    // every-poll warn would spam). This gives an ongoing signal that slot-state
    // detection is blind for some replicas, and a recovery line when it clears.
    const unreachable = unreachableIds.size;
    const prevUnreachable = this.replicaFanoutUnreachable.get(ctx.connectionId) ?? 0;
    if (unreachable !== prevUnreachable) {
      if (unreachable > 0) {
        this.logger.warn(
          `Replica slot-state fan-out for ${ctx.connectionName}: ${unreachable}/${remoteReplicas.length} replica self-views unreachable — divergence/stuck detection is degraded for those nodes.`,
        );
      } else {
        this.logger.log(
          `Replica slot-state fan-out for ${ctx.connectionName}: all replica self-views reachable again.`,
        );
      }
      this.replicaFanoutUnreachable.set(ctx.connectionId, unreachable);
    }
    return { nodes: merged, unreachableIds };
  }

  /**
   * Resolve a promise, or reject with `message` if it doesn't settle within `ms`.
   * The timer is always cleared so a settled race can't leave a dangling handle.
   */
  private async raceWithTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Shared persistence-gated dedupe pipeline for snapshot topology detectors
   * (stuck-replica #2090, replica-slot-state #1664). Given this poll's findings it
   * restarts the grace clock for recovered signatures, emits one event per finding
   * that has persisted past `minPersistMs` and isn't already active, dedupes
   * repeats, and re-arms after recovery. It performs NO I/O and never clears state
   * on error — a transient fetch failure is handled upstream (the detectors aren't
   * called), so an already-alerted condition can't re-fire a duplicate. When
   * `eventIdsByConn` is supplied, it also records each emitted event id and, on
   * recovery, resolves exactly that event so an activeOnly banner clears.
   */
  private async applyTopologyPersistenceGate<T>(params: {
    ctx: ConnectionContext;
    timestamp: number;
    findings: T[];
    signatureOf: (finding: T) => string;
    firstSeenByConn: Map<string, Map<string, number>>;
    activeByConn: Map<string, Set<string>>;
    minPersistMs: number;
    buildEvent: (finding: T, signature: string) => AnomalyEvent;
    eventIdsByConn?: Map<string, Map<string, string>>;
    // Metric type of the emitted events — narrows the storage dedupe lookup below.
    metricType?: MetricType;
    // Predicate marking signatures whose source node is an observation GAP this
    // poll (e.g. an unreachable replica). Such signatures are neither forgotten
    // (grace preserved) nor auto-resolved — their prior state is carried forward
    // rather than read as recovery.
    preserveSignature?: (signature: string) => boolean;
  }): Promise<void> {
    const {
      ctx,
      timestamp,
      findings,
      signatureOf,
      firstSeenByConn,
      activeByConn,
      minPersistMs,
      buildEvent,
      eventIdsByConn,
      metricType,
      preserveSignature,
    } = params;
    const connId = ctx.connectionId;
    const isPreserved = (sig: string): boolean => preserveSignature?.(sig) ?? false;

    const firstSeen = firstSeenByConn.get(connId) ?? new Map<string, number>();
    const active = activeByConn.get(connId) ?? new Set<string>();
    const eventIds = eventIdsByConn?.get(connId) ?? new Map<string, string>();
    const currentSignatures = new Set(findings.map(signatureOf));

    // Forget recovered signatures so their grace window restarts if they recur.
    // A preserved (observation-gap) signature is NOT recovered — keep its clock.
    for (const sig of [...firstSeen.keys()]) {
      if (!currentSignatures.has(sig) && !isPreserved(sig)) firstSeen.delete(sig);
    }

    for (const finding of findings) {
      const signature = signatureOf(finding);
      const seenAt = firstSeen.get(signature) ?? timestamp;
      if (!firstSeen.has(signature)) firstSeen.set(signature, timestamp);

      // Persistence gate.
      if (timestamp - seenAt < minPersistMs) continue;

      // Dedupe — but stay aware of EXTERNAL resolution. For tracked detectors an
      // operator can dismiss the banner (resolve the event) while the condition
      // is still present; a non-self-healing valkey#1664 state must then RE-EMIT
      // rather than stay silently suppressed. So we dedupe only while the tracked
      // event is still unresolved and present in the cache. This also covers the
      // recovered-then-failed-resolve-then-recurred case: the still-open event is
      // reused, never orphaned by a second emit. If the event was resolved
      // externally or evicted, we stop tracking it and fall through to re-emit
      // (mirrors the Raft re-pin behavior).
      if (eventIdsByConn) {
        const existingId = eventIds.get(signature);
        if (existingId) {
          const existing = this.recentAnomalies.find((e) => e.id === existingId);
          // Still open in the in-memory ring → dedupe. If it's been evicted from
          // the ring we can't tell from memory alone, so consult the storage-
          // backed feed (the source of truth for activeOnly reads): only re-emit
          // when the tracked event is genuinely gone/resolved there — otherwise a
          // still-unresolved stored row would get a duplicate WARNING alongside it.
          const stillOpen =
            existing !== undefined
              ? !existing.resolved
              : await this.isAnomalyUnresolvedInStorage(existingId, connId, metricType);
          if (stillOpen) {
            active.add(signature);
            continue;
          }
          eventIds.delete(signature);
          active.delete(signature);
        }
      } else if (active.has(signature)) {
        continue;
      }

      const event = buildEvent(finding, signature);
      this.logger.warn(`Anomaly detected for ${ctx.connectionName}: ${event.message}`);
      await this.addAnomaly(event, ctx);
      active.add(signature);
      if (eventIdsByConn) eventIds.set(signature, event.id);
    }

    // Auto-resolve (when wired): a recovered signature (has an emitted event id
    // but is absent this poll) gets its event resolved so an activeOnly banner
    // clears. Iterate the id map, not `active`. Drop the mapping when resolution
    // SUCCEEDS, and also when the event is `gone` (absent from both cache and
    // storage — otherwise a never-persisted, since-evicted id retries every poll
    // forever and the map grows unbounded). Only a `retry` outcome (transient
    // storage blip, or a cache-present momentary miss) keeps the mapping so the
    // next poll retries. Retry is decoupled from `active`, so a genuine
    // recurrence of the same signature still re-alerts.
    if (eventIdsByConn) {
      for (const [sig, id] of [...eventIds]) {
        // Still active this poll, or an observation gap (unreachable node) — don't
        // resolve: a gap must not read as recovery.
        if (currentSignatures.has(sig) || isPreserved(sig)) continue;
        let outcome: 'resolved' | 'retry' | 'gone' = 'retry';
        try {
          outcome = await this.resolveAnomalyOutcome(id);
        } catch {
          outcome = 'retry';
        }
        if (outcome !== 'retry') eventIds.delete(sig);
      }
      eventIdsByConn.set(connId, eventIds);
    }

    firstSeenByConn.set(connId, firstSeen);
    activeByConn.set(
      connId,
      // Keep signatures active this poll AND preserved ones (unreachable nodes),
      // so a transient connectivity gap doesn't drop a still-open finding.
      new Set([...active].filter((sig) => currentSignatures.has(sig) || isPreserved(sig))),
    );
  }

  /**
   * Whether an emitted anomaly is still present-and-unresolved in the storage-
   * backed feed. Used by the dedupe gate when the event has been evicted from the
   * in-memory ring, so a still-open stored row isn't duplicated. On a storage
   * read error, assume still-open (conservative: avoid emitting a duplicate).
   */
  private async isAnomalyUnresolvedInStorage(
    id: string,
    connectionId: string,
    metricType?: MetricType,
  ): Promise<boolean> {
    try {
      const open = await this.storage.getAnomalyEvents({
        connectionId,
        resolved: false,
        metricType,
      });
      return open.some((e) => e.id === id);
    } catch {
      return true;
    }
  }

  /** Human-readable message for a replica slot-state anomaly (valkey#1664). */
  private buildReplicaSlotMessage(a: ReplicaSlotAnomaly): string {
    const addr = this.clientAddress(a.replicaAddress);
    const replica = `${addr} (${a.replicaId.substring(0, 8)})`;
    const shard =
      a.shardId && a.shardSlots && a.shardSlots.length > 0
        ? ` Its shard (${a.shardId.substring(0, 8)}) authoritatively owns slots ${this.formatSlotRanges(a.shardSlots)}.`
        : '';

    if (a.reason === 'slot_view_divergence') {
      // SETSLOT ... STABLE only clears migrating/importing markers — it does NOT
      // fix a replica that OWNS slots — so give ownership-divergence guidance.
      const owned =
        a.ownedSlots && a.ownedSlots.length > 0
          ? this.formatSlotRanges(a.ownedSlots)
          : this.formatSlotList(a.affectedSlots);
      return (
        `WARNING: Replica ${replica} owns slots ${owned} in CLUSTER NODES that diverge from its ` +
        `shard's authoritative ownership — a replica should never own slots (valkey#1664).${shard} ` +
        `Verify the shard topology; if the replica is genuinely stuck, re-attach it to its primary ` +
        `with \`CLUSTER REPLICATE <primary-id>\` on ${addr}. Do NOT run \`SETSLOT ... STABLE\` — ` +
        `it clears migration markers, not slot ownership.`
      );
    }

    const state = a.reason === 'replica_migrating' ? 'MIGRATING' : 'IMPORTING';
    const slotList = this.formatSlotList(a.affectedSlots);
    // Every stuck slot needs its own SETSLOT STABLE, not just the first.
    return (
      `WARNING: Replica ${replica} is reporting slot(s) ${slotList} in ${state} state — replicas must ` +
      `never carry slot-migration state, so this is a stuck, inconsistent cluster state (valkey#1664).${shard} ` +
      `Run \`CLUSTER SETSLOT <slot> STABLE\` on ${addr} for each affected slot (${slotList}) to clear it.`
    );
  }

  /**
   * Strip the cluster-bus port from a `CLUSTER NODES` address (`ip:port@cport`)
   * so the shown `host:port` is directly usable with valkey-cli.
   */
  private clientAddress(address: string): string {
    return address.split('@')[0];
  }

  /** Compact rendering of a slot-number list for messages. */
  private formatSlotList(slots: number[]): string {
    if (slots.length === 0) return 'none';
    if (slots.length <= 5) return slots.join(', ');
    return `${slots.slice(0, 5).join(', ')}, … (${slots.length} total)`;
  }

  /** Render `[[start,end], …]` ranges as `start-end` (or `n` for singletons). */
  private formatSlotRanges(ranges: number[][]): string {
    return ranges.map(([s, e]) => (s === e ? String(s) : `${s}-${e}`)).join(', ');
  }

  /**
   * Gossip-mode failover churn (valkey#3996): one shard re-electing repeatedly
   * within the detector window — competing FAILOVER coordinators. Raft-mode
   * churn is covered by detectRaftHealth; callers gate this on `!isRaft` and
   * pass the poll's CLUSTER NODES snapshot (fetch failures are handled at the
   * call site by skipping the evaluation, which carries the window state).
   */
  private async detectFailoverChurn(
    ctx: ConnectionContext,
    timestamp: number,
    nodes: ClusterNode[],
  ): Promise<void> {
    const state = this.failoverChurnState.get(ctx.connectionId) ?? new Map();
    this.failoverChurnState.set(ctx.connectionId, state);

    const findings = evaluateFailoverChurn(state, nodes, timestamp);
    for (const finding of findings) {
      const severity =
        finding.severity === 'critical' ? AnomalySeverity.CRITICAL : AnomalySeverity.WARNING;
      const prefix = finding.severity === 'critical' ? 'CRITICAL' : 'WARNING';
      const event: AnomalyEvent = {
        id: randomUUID(),
        timestamp,
        metricType: MetricType.FAILOVER_CHURN,
        anomalyType: AnomalyType.SPIKE,
        severity,
        value: finding.changes,
        baseline: 0,
        zScore: 0,
        stdDev: 0,
        threshold: FAILOVER_CHURN_MIN_CHANGES,
        message: `${prefix}: ${finding.message}`,
        resolved: false,
        connectionId: ctx.connectionId,
      };
      this.logger.warn(`Anomaly detected for ${ctx.connectionName}: ${event.message}`);
      await this.addAnomaly(event, ctx);
      acknowledgeChurnFinding(state, finding.shardKey, timestamp);
    }
  }

  private convertInfoToRecord(infoResponse: any): Record<string, string> {
    const info: Record<string, string> = {};

    // Flatten all sections into a single record
    for (const section of Object.values(infoResponse)) {
      if (typeof section === 'object' && section !== null) {
        Object.assign(info, section);
      }
    }

    // Convert all values to strings
    for (const key of Object.keys(info)) {
      if (typeof info[key] !== 'string') {
        info[key] = String(info[key]);
      }
    }

    return info;
  }

  private toStoredAnomalyEvent(anomaly: AnomalyEvent, ctx?: ConnectionContext): StoredAnomalyEvent {
    return {
      id: anomaly.id,
      timestamp: anomaly.timestamp,
      metricType: anomaly.metricType,
      anomalyType: anomaly.anomalyType,
      severity: anomaly.severity,
      value: anomaly.value,
      baseline: anomaly.baseline,
      stdDev: anomaly.stdDev,
      zScore: anomaly.zScore,
      threshold: anomaly.threshold,
      message: anomaly.message,
      correlationId: anomaly.correlationId,
      relatedMetrics: anomaly.relatedMetrics,
      resolved: anomaly.resolved || false,
      resolvedAt: undefined,
      durationMs: undefined,
      sourceHost: ctx?.host || this.configService.get('database.host'),
      sourcePort: ctx?.port || this.configService.get('database.port'),
      connectionId: ctx?.connectionId || anomaly.connectionId,
    };
  }

  private async addAnomaly(anomaly: AnomalyEvent, ctx?: ConnectionContext): Promise<void> {
    this.recentAnomalies.push(anomaly);

    if (this.recentAnomalies.length > this.maxRecentEvents) {
      this.recentAnomalies = this.recentAnomalies.slice(-this.maxRecentEvents);
    }

    // Metrics/telemetry emits are best-effort: a failure in the Prometheus counter
    // or the OTLP dispatch must never abort recording/persisting the anomaly, and
    // must never propagate out of addAnomaly (that would let one detector's emit
    // failure abort a later detector in the same poll — e.g. a churn-warning throw
    // skipping quorum-loss detection).
    try {
      this.prometheusService.incrementAnomalyEvent(
        anomaly.severity,
        anomaly.metricType,
        anomaly.anomalyType,
        ctx?.connectionId,
      );
    } catch (err) {
      this.logger.error('Failed to increment anomaly metric:', err);
    }
    // OTLP export is decoupled from the Pro webhook: mirroring is its own opt-in
    // channel (gated only by the OTEL_* env vars inside the dispatcher, which
    // no-ops when disabled), so an operator can ship anomalies to their OTLP
    // collector without also configuring/enabling a webhook. Intentionally
    // broader than the webhook path too: OTLP includes command_p99 anomalies,
    // which webhook-anomaly-integration skips and delivers as
    // latency.regression.detected instead.
    try {
      this.otelEvents?.dispatch(
        WebhookEventType.ANOMALY_DETECTED,
        {
          severity: anomaly.severity,
          metricType: anomaly.metricType,
          anomalyType: anomaly.anomalyType,
        },
        ctx?.connectionId,
      );
    } catch (err) {
      this.logger.error('Failed to dispatch anomaly OTLP event:', err);
    }

    try {
      const connectionId = ctx?.connectionId || anomaly.connectionId;
      if (connectionId) {
        await this.storage.saveAnomalyEvent(this.toStoredAnomalyEvent(anomaly, ctx), connectionId);
        // Mark durable so resolution goes storage-first; a save failure (e.g. a
        // string id rejected by the Postgres UUID PK) leaves it memory-only.
        anomaly.persisted = true;
      }
    } catch (err) {
      this.logger.error('Failed to persist anomaly event:', err);
    }
  }

  private async correlateAnomalies(): Promise<void> {
    try {
      const uncorrelated = this.recentAnomalies.filter((a) => !a.correlationId && !a.resolved);
      if (uncorrelated.length === 0) return;

      const newGroups = this.correlator.correlate(uncorrelated);
      if (newGroups.length === 0) return;

      this.logger.log(
        `Correlated ${uncorrelated.length} anomalies into ${newGroups.length} pattern groups`,
      );

      for (const group of newGroups) {
        this.logger.warn(
          `Pattern detected: ${group.pattern} (${group.severity}) - ${group.diagnosis}`,
        );

        // Get connectionId from first anomaly in group (all should have same connectionId)
        const groupConnectionId = group.anomalies[0]?.connectionId;
        this.prometheusService.incrementCorrelatedGroup(
          group.pattern,
          group.severity,
          groupConnectionId,
        );

        const storedGroup: StoredCorrelatedGroup = {
          correlationId: group.correlationId,
          timestamp: group.timestamp,
          pattern: group.pattern,
          severity: group.severity,
          diagnosis: group.diagnosis,
          recommendations: group.recommendations,
          anomalyCount: group.anomalies.length,
          metricTypes: group.anomalies.map((a) => a.metricType),
          sourceHost: this.configService.get('database.host'),
          sourcePort: this.configService.get('database.port'),
        };

        try {
          // Get connectionId from first anomaly in group (all should have same connectionId)
          const connectionId = group.anomalies[0]?.connectionId;
          if (connectionId) {
            await this.storage.saveCorrelatedGroup(storedGroup, connectionId);
            for (const anomaly of group.anomalies) {
              await this.storage.saveAnomalyEvent(this.toStoredAnomalyEvent(anomaly), connectionId);
            }
          }
        } catch (err) {
          this.logger.error('Failed to persist correlated group:', err);
        }
      }

      this.recentGroups.push(...newGroups);
      if (this.recentGroups.length > this.maxRecentGroups) {
        this.recentGroups = this.recentGroups.slice(-this.maxRecentGroups);
      }
    } catch (error) {
      this.logger.error('Failed to correlate anomalies:', error);
    }
  }

  // Public API methods

  getRecentEvents(limit = 100, metricType?: MetricType): AnomalyEvent[] {
    let events = [...this.recentAnomalies].reverse();

    if (metricType) {
      events = events.filter((e) => e.metricType === metricType);
    }

    return events.slice(0, limit);
  }

  private storedToAnomalyEvent(s: StoredAnomalyEvent): AnomalyEvent {
    return {
      id: s.id,
      timestamp: s.timestamp,
      metricType: s.metricType as MetricType,
      anomalyType: s.anomalyType === 'spike' ? AnomalyType.SPIKE : AnomalyType.DROP,
      severity: s.severity as AnomalySeverity,
      value: s.value,
      baseline: s.baseline,
      stdDev: s.stdDev,
      zScore: s.zScore,
      threshold: s.threshold,
      message: s.message,
      correlationId: s.correlationId,
      relatedMetrics: s.relatedMetrics as MetricType[],
      resolved: s.resolved,
      connectionId: s.connectionId,
    };
  }

  async getRecentAnomalies(
    startTime?: number,
    endTime?: number,
    severity?: AnomalySeverity,
    metricType?: MetricType,
    limit = 100,
    connectionId?: string,
    activeOnly = false,
  ): Promise<AnomalyEvent[]> {
    // Active-incident feed (e.g. the data-loss banner): return every UNRESOLVED
    // event of any age. Must query durable storage — the in-memory cache is
    // capped and lost on restart, and a lingering open incident can be older
    // than any time window — with no startTime floor so old-but-open incidents
    // are never filtered out.
    if (activeOnly) {
      const stored = await this.storage.getAnomalyEvents({
        endTime,
        severity: severity as string,
        metricType: metricType as string,
        resolved: false,
        limit,
        connectionId,
      });
      const storedEvents = stored.map((s) => this.storedToAnomalyEvent(s));

      // Union with in-memory unresolved events not yet in storage: a persist failure in
      // addAnomaly() still leaves the incident in the cache (and still fires the Pro
      // webhook), so the banner must surface it rather than wait for a later poll to make
      // it durable. Dedupe by id (storage wins), apply the same filters.
      const seen = new Set(storedEvents.map((e) => e.id));
      const inMemory = this.recentAnomalies.filter(
        (e) =>
          !e.resolved &&
          !seen.has(e.id) &&
          (!connectionId || e.connectionId === connectionId) &&
          (!metricType || e.metricType === metricType) &&
          (!severity || e.severity === severity) &&
          (!endTime || e.timestamp <= endTime),
      );

      return [...storedEvents, ...inMemory]
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, limit);
    }

    const stored = await this.storage.getAnomalyEvents({
      startTime,
      endTime,
      severity: severity as string,
      metricType: metricType as string,
      limit,
      connectionId,
    });
    const storedEvents = stored.map((s) => this.storedToAnomalyEvent(s));

    // Union with the in-memory cache like the activeOnly branch above: the
    // cache can hold events whose persist failed, while storage holds events
    // some producers (e.g. command_p99 latency regressions) write without ever
    // entering the cache. Neither side alone is complete; storage wins on id.
    const cacheThreshold = Date.now() - this.cacheTtlMs;
    if (!startTime || startTime >= cacheThreshold) {
      const seen = new Set(storedEvents.map((e) => e.id));
      const cached = this.recentAnomalies.filter(
        (e) =>
          !seen.has(e.id) &&
          (!connectionId || e.connectionId === connectionId) &&
          (!metricType || e.metricType === metricType) &&
          (!severity || e.severity === severity) &&
          (!endTime || e.timestamp <= endTime) &&
          (!startTime || e.timestamp >= startTime),
      );
      return [...storedEvents, ...cached].sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
    }

    return storedEvents;
  }

  getRecentGroups(limit = 50, pattern?: AnomalyPattern): CorrelatedAnomalyGroup[] {
    let groups = [...this.recentGroups].reverse();

    if (pattern) {
      groups = groups.filter((g) => g.pattern === pattern);
    }

    return groups.slice(0, limit);
  }

  async getRecentCorrelatedGroups(
    startTime?: number,
    endTime?: number,
    pattern?: AnomalyPattern,
    limit = 50,
    connectionId?: string,
  ): Promise<CorrelatedAnomalyGroup[]> {
    const cacheThreshold = Date.now() - this.cacheTtlMs;

    if (!startTime || startTime >= cacheThreshold) {
      let groups = [...this.recentGroups];
      if (connectionId)
        groups = groups.filter((g) => g.anomalies.some((a) => a.connectionId === connectionId));
      if (pattern) groups = groups.filter((g) => g.pattern === pattern);
      if (endTime) groups = groups.filter((g) => g.timestamp <= endTime);
      return groups.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
    }

    const stored = await this.storage.getCorrelatedGroups({
      startTime,
      endTime,
      pattern: pattern as string,
      limit,
      connectionId,
    });

    const groups: CorrelatedAnomalyGroup[] = [];
    for (const s of stored) {
      const storedAnomalies = await this.storage.getAnomalyEvents({
        startTime: s.timestamp - this.correlationIntervalMs,
        endTime: s.timestamp + this.correlationIntervalMs,
        connectionId,
      });
      const anomalies = storedAnomalies
        .filter((a) => a.correlationId === s.correlationId)
        .map((a) => this.storedToAnomalyEvent(a));

      groups.push({
        correlationId: s.correlationId,
        timestamp: s.timestamp,
        pattern: s.pattern as AnomalyPattern,
        severity: s.severity as AnomalySeverity,
        diagnosis: s.diagnosis,
        recommendations: s.recommendations,
        anomalies,
      });
    }

    return groups;
  }

  getBufferStats(connectionId?: string): BufferStats[] {
    const stats: BufferStats[] = [];

    // Iterate over all connections and their buffers
    for (const [connId, connectionBuffers] of this.buffers.entries()) {
      // Filter by connectionId if provided
      if (connectionId && connId !== connectionId) continue;

      for (const [, buffer] of connectionBuffers.entries()) {
        const bufferStats = buffer.getStats();
        stats.push({
          ...bufferStats,
          connectionId: connId,
        });
      }
    }

    // Sort by connectionId then metricType
    return stats.sort((a, b) => {
      const connCmp = (a.connectionId || '').localeCompare(b.connectionId || '');
      if (connCmp !== 0) return connCmp;
      return a.metricType.localeCompare(b.metricType);
    });
  }

  getWarmupStatus(): {
    isReady: boolean;
    buffersReady: number;
    buffersTotal: number;
    warmupProgress: number;
  } {
    const stats = this.getBufferStats();
    const buffersTotal = stats.length;
    const buffersReady = stats.filter((s) => s.isReady).length;

    return {
      isReady: buffersReady === buffersTotal,
      buffersReady,
      buffersTotal,
      warmupProgress: buffersTotal > 0 ? Math.round((buffersReady / buffersTotal) * 100) : 100,
    };
  }

  async getSummary(
    startTime?: number,
    endTime?: number,
    connectionId?: string,
  ): Promise<AnomalySummary> {
    const cacheThreshold = Date.now() - this.cacheTtlMs;

    // Use in-memory data if no start time or start time is within cache TTL
    if (!startTime || startTime >= cacheThreshold) {
      let events = [...this.recentAnomalies];
      let groups = [...this.recentGroups];

      if (connectionId) {
        events = events.filter((e) => e.connectionId === connectionId);
        groups = groups.filter((g) => g.anomalies.some((a) => a.connectionId === connectionId));
      }

      if (endTime) {
        events = events.filter((e) => e.timestamp <= endTime);
        groups = groups.filter((g) => g.timestamp <= endTime);
      }

      const activeEvents = events.filter((a) => !a.resolved);
      const resolvedEvents = events.filter((a) => a.resolved);

      const bySeverity: Record<AnomalySeverity, number> = {
        [AnomalySeverity.INFO]: 0,
        [AnomalySeverity.WARNING]: 0,
        [AnomalySeverity.CRITICAL]: 0,
      };

      const byMetric: Partial<Record<MetricType, number>> = {};
      const byPattern: Partial<Record<AnomalyPattern, number>> = {};

      for (const event of events) {
        bySeverity[event.severity]++;
        byMetric[event.metricType] = (byMetric[event.metricType] || 0) + 1;
      }

      for (const group of groups) {
        byPattern[group.pattern] = (byPattern[group.pattern] || 0) + 1;
      }

      return {
        totalEvents: events.length,
        totalGroups: groups.length,
        bySeverity,
        byMetric: byMetric as Record<MetricType, number>,
        byPattern: byPattern as Record<AnomalyPattern, number>,
        activeEvents: activeEvents.length,
        resolvedEvents: resolvedEvents.length,
      };
    }

    // Query historical data from storage
    const storedEvents = await this.storage.getAnomalyEvents({
      startTime,
      endTime,
    });

    const storedGroups = await this.storage.getCorrelatedGroups({
      startTime,
      endTime,
    });

    const events = storedEvents.map((s) => this.storedToAnomalyEvent(s));
    const activeEvents = events.filter((a) => !a.resolved);
    const resolvedEvents = events.filter((a) => a.resolved);

    const bySeverity: Record<AnomalySeverity, number> = {
      [AnomalySeverity.INFO]: 0,
      [AnomalySeverity.WARNING]: 0,
      [AnomalySeverity.CRITICAL]: 0,
    };

    const byMetric: Partial<Record<MetricType, number>> = {};
    const byPattern: Partial<Record<AnomalyPattern, number>> = {};

    for (const event of events) {
      bySeverity[event.severity]++;
      byMetric[event.metricType] = (byMetric[event.metricType] || 0) + 1;
    }

    for (const group of storedGroups) {
      const pattern = group.pattern as AnomalyPattern;
      byPattern[pattern] = (byPattern[pattern] || 0) + 1;
    }

    return {
      totalEvents: events.length,
      totalGroups: storedGroups.length,
      bySeverity,
      byMetric: byMetric as Record<MetricType, number>,
      byPattern: byPattern as Record<AnomalyPattern, number>,
      activeEvents: activeEvents.length,
      resolvedEvents: resolvedEvents.length,
    };
  }

  async resolveAnomaly(anomalyId: string): Promise<boolean> {
    return (await this.resolveAnomalyOutcome(anomalyId)) === 'resolved';
  }

  /**
   * Resolve an anomaly, distinguishing three outcomes so auto-resolve callers can
   * decide whether to retry:
   *   - `resolved`: the event was dismissed (cache flip or durable storage write).
   *   - `retry`:    a transient storage error, or a cache-present event storage
   *                 momentarily couldn't confirm — try again next poll.
   *   - `gone`:     the event exists in neither the cache nor storage, so it can
   *                 never be resolved (e.g. a deterministic string id the Postgres
   *                 UUID PK rejected, since evicted from recentAnomalies). Callers
   *                 must STOP retrying, or the id mapping is retried every poll
   *                 forever and grows unbounded.
   */
  private async resolveAnomalyOutcome(anomalyId: string): Promise<'resolved' | 'retry' | 'gone'> {
    const anomaly = this.recentAnomalies.find((a) => a.id === anomalyId);

    // Memory-only event (never durably stored — e.g. a deterministic string id
    // rejected by the Postgres UUID PK): a storage-backed poll can't resurface a
    // row that doesn't exist, so flipping the cached copy fully dismisses it.
    if (anomaly && !anomaly.persisted) {
      anomaly.resolved = true;
      return 'resolved';
    }

    // Durable event: storage is the source of truth for later (storage-backed)
    // polls, so persist first and only report success once the resolution is
    // durable. Reporting success on an in-memory-only flip would let a client
    // dismiss a banner that subsequent polls still return as unresolved.
    let persisted = false;
    try {
      persisted = await this.storage.resolveAnomaly(anomalyId, Date.now());
    } catch (err) {
      this.logger.error(`Failed to persist resolution for anomaly ${anomalyId}:`, err);
      return 'retry';
    }

    if (!persisted) {
      // Storage has no such row. If the event is also absent from the cache it no
      // longer exists anywhere and can never be resolved — report `gone` so the
      // caller drops it. A cache-present event may just be a momentary storage
      // miss, so keep retrying that one.
      return anomaly ? 'retry' : 'gone';
    }

    // Keep the cached copy in sync with the durable store.
    if (anomaly) {
      anomaly.resolved = true;
    }

    return 'resolved';
  }

  async resolveGroup(correlationId: string): Promise<boolean> {
    const group = this.recentGroups.find((g) => g.correlationId === correlationId);
    if (!group) return false;

    // Storage is the source of truth (same as resolveAnomaly): only flip the cached
    // copy for events whose resolution is durable, and report success only if EVERY
    // event in the group persisted — otherwise a client could dismiss the group while
    // later storage-backed polls still return some members unresolved.
    const resolvedAt = Date.now();
    let allResolved = true;
    for (const anomaly of group.anomalies) {
      // Memory-only member: safe to flip the cache (no durable row to resurface).
      if (!anomaly.persisted) {
        anomaly.resolved = true;
        continue;
      }
      let persisted = false;
      try {
        persisted = await this.storage.resolveAnomaly(anomaly.id, resolvedAt);
      } catch (err) {
        this.logger.error(`Failed to persist resolution for anomaly ${anomaly.id}:`, err);
      }
      if (persisted) {
        anomaly.resolved = true;
      } else {
        allResolved = false;
      }
    }
    return allResolved;
  }

  clearResolved(): number {
    const beforeCount = this.recentAnomalies.length;
    this.recentAnomalies = this.recentAnomalies.filter((a) => !a.resolved);
    return beforeCount - this.recentAnomalies.length;
  }

  private async updatePrometheusSummary(): Promise<void> {
    const oneHourAgo = Date.now() - 3600000;
    const bySeverity: Record<string, number> = { info: 0, warning: 0, critical: 0 };
    const byMetric: Record<string, number> = {};
    const unresolvedBySeverity: Record<string, number> = { info: 0, warning: 0, critical: 0 };
    const byPattern: Record<string, number> = {};

    for (const a of this.recentAnomalies) {
      if (a.timestamp < oneHourAgo) continue;
      bySeverity[a.severity] = (bySeverity[a.severity] ?? 0) + 1;
      byMetric[a.metricType] = (byMetric[a.metricType] ?? 0) + 1;
      if (!a.resolved)
        unresolvedBySeverity[a.severity] = (unresolvedBySeverity[a.severity] ?? 0) + 1;
    }

    for (const g of this.recentGroups) {
      if (g.timestamp >= oneHourAgo) byPattern[g.pattern] = (byPattern[g.pattern] ?? 0) + 1;
    }

    this.prometheusService.updateAnomalySummary({
      bySeverity,
      byMetric,
      byPattern,
      unresolvedBySeverity,
    });

    const bufferStats = this.getBufferStats().map((s) => ({
      metricType: s.metricType,
      mean: s.mean,
      stdDev: s.stdDev,
      ready: s.isReady,
    }));
    this.prometheusService.updateAnomalyBufferStats(bufferStats);
  }
}
