export type { StoredAclEntry, AuditQueryOptions, AuditStats } from '@betterdb/shared';
export type {
  StoredClientSnapshot,
  ClientSnapshotQueryOptions,
  ClientTimeSeriesPoint,
  ClientAnalyticsStats,
  CommandDistributionParams,
  CommandDistributionResponse,
  IdleConnectionsParams,
  IdleConnectionsResponse,
  BufferAnomaliesParams,
  BufferAnomaliesResponse,
  ActivityTimelineParams,
  ActivityTimelineResponse,
  SpikeDetectionParams,
  SpikeDetectionResponse,
  AppSettings,
  SettingsUpdateRequest,
  KeyPatternSnapshot,
  KeyPatternQueryOptions,
  KeyAnalyticsSummary,
  HotKeyEntry,
  HotKeyQueryOptions,
  Webhook,
  WebhookDelivery,
  WebhookEventType,
  DeliveryStatus,
  DatabaseConnectionConfig,
  VectorIndexSnapshot,
  VectorIndexSnapshotQueryOptions,
  StoredAiCacheSample,
  AiCacheHistoryQueryOptions,
  StoredOtelSpan,
  OtelTraceSummary,
  OtelTraceQueryOptions,
} from '@betterdb/shared';
import type {
  ReadinessBand,
  ReadinessDimension,
  ReadinessDimensionKey,
  ScalingReadinessSettings,
  SessionNamespace,
  KvCacheEngineSample,
  KvCacheEngineSource,
  KvCacheFootprintSnapshot,
  KvCacheSettings,
} from '@betterdb/shared';
export type { MetricForecastSettings, MetricKind } from '@betterdb/shared';
export type { StoredCveDataset, CveScanResult } from '@betterdb/shared';
export type {
  CacheType,
  ProposalType,
  ProposalStatus,
  ProposalAuditEvent,
  ActorSource,
  ProposalPayload,
  StoredCacheProposal,
  StoredCacheProposalAudit,
  CreateCacheProposalInput,
  ListCacheProposalsOptions,
  UpdateProposalStatusInput,
  AppendProposalAuditInput,
  AppliedResult,
  StoredMemoryProposal,
  StoredMemoryProposalAudit,
  CreateMemoryProposalInput,
  ListMemoryProposalsOptions,
  UpdateMemoryProposalStatusInput,
  AppendMemoryProposalAuditInput,
} from '@betterdb/shared';
export type {
  CaptureSessionStatus,
  CaptureSessionSource,
  StoredCaptureSession,
  CaptureSessionQueryOptions,
  StoredCaptureChunk,
  CaptureSessionPatch,
  CaptureNodeSegment,
  CaptureTriggerStatus,
  StoredCaptureTrigger,
  CaptureTriggerQueryOptions,
  CaptureTriggerPatch,
  StoredScheduledCapture,
  ScheduledCaptureQueryOptions,
  ScheduledCapturePatch,
} from '@betterdb/shared';
import type { MaintenanceWindowRepository } from './maintenance-window-repository.interface';
import type { InvitationRepository } from './invitation-repository.interface';
import type { ActivityRepository } from './activity-repository.interface';
import type {
  AppSettings,
  AuditQueryOptions,
  AuditStats,
  ClientAnalyticsRollup,
  ClientAnalyticsStats,
  ClientSnapshotGroupRow,
  ClientSnapshotQueryOptions,
  ClientTimeSeriesPoint,
  DatabaseConnectionConfig,
  HotKeyEntry,
  HotKeyQueryOptions,
  KeyAnalyticsSummary,
  KeyPatternQueryOptions,
  KeyPatternSnapshot,
  SettingsUpdateRequest,
  StoredAclEntry,
  StoredClientSnapshot,
  MetricForecastSettings,
  MetricKind,
  StoredCveDataset,
  CveScanResult,
  VectorIndexSnapshot,
  VectorIndexSnapshotQueryOptions,
  StoredAiCacheSample,
  AiCacheHistoryQueryOptions,
  StoredOtelSpan,
  OtelTraceSummary,
  OtelTraceQueryOptions,
  Webhook,
  WebhookDelivery,
  WebhookEventType,
  StoredCacheProposal,
  StoredCacheProposalAudit,
  CreateCacheProposalInput,
  ListCacheProposalsOptions,
  UpdateProposalStatusInput,
  AppendProposalAuditInput,
  StoredMemoryProposal,
  StoredMemoryProposalAudit,
  CreateMemoryProposalInput,
  ListMemoryProposalsOptions,
  UpdateMemoryProposalStatusInput,
  AppendMemoryProposalAuditInput,
  StoredCaptureSession,
  CaptureSessionQueryOptions,
  StoredCaptureChunk,
  CaptureSessionPatch,
  StoredCaptureTrigger,
  CaptureTriggerQueryOptions,
  CaptureTriggerPatch,
  StoredScheduledCapture,
  ScheduledCaptureQueryOptions,
  ScheduledCapturePatch,
} from '@betterdb/shared';
import type { AgentToken, TokenType } from '@betterdb/shared';

// Anomaly Event Types
export interface StoredAnomalyEvent {
  id: string;
  timestamp: number;
  metricType: string;
  anomalyType: string;
  severity: string;
  value: number;
  baseline: number;
  stdDev: number;
  zScore: number;
  threshold: number;
  message: string;
  correlationId?: string;
  relatedMetrics?: string[];
  resolved: boolean;
  resolvedAt?: number;
  durationMs?: number;
  sourceHost?: string;
  sourcePort?: number;
  connectionId?: string;
}

// Bulk-Delete Audit Types (one row per execute run; dry-runs are not audited)
export interface StoredBulkDeleteAudit {
  id: string;
  connectionId: string;
  /** Job start time (ms). */
  timestamp: number;
  completedAt: number | null;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  match: string;
  type: string | null;
  scope: 'node' | 'cluster';
  matched: number;
  deleted: number;
  batches: number;
  nodes: number;
  truncated: boolean;
  /** Cluster primaries skipped because they were unreachable. */
  skippedNodes: string[];
  error: string | null;
  sourceHost: string | null;
  sourcePort: number | null;
}

export interface BulkDeleteAuditQueryOptions {
  connectionId?: string;
  startTime?: number;
  endTime?: number;
  limit?: number;
}

export interface StoredCorrelatedGroup {
  correlationId: string;
  timestamp: number;
  pattern: string;
  severity: string;
  diagnosis: string;
  recommendations: string[];
  anomalyCount: number;
  metricTypes: string[];
  sourceHost?: string;
  sourcePort?: number;
  connectionId?: string;
}

export interface AnomalyQueryOptions {
  startTime?: number;
  endTime?: number;
  severity?: string;
  metricType?: string;
  pattern?: string;
  resolved?: boolean;
  limit?: number;
  offset?: number;
  connectionId?: string;
}

export interface AnomalyStats {
  totalEvents: number;
  bySeverity: Record<string, number>;
  byMetric: Record<string, number>;
  byPattern: Record<string, number>;
  unresolvedCount: number;
}

// Slow Log Entry Types
export interface StoredSlowLogEntry {
  id: number; // Original slowlog ID from Valkey/Redis
  timestamp: number; // Unix timestamp in seconds
  duration: number; // Microseconds
  command: string[]; // Command name + args (e.g., ['GET', 'key1'])
  clientAddress: string;
  clientName: string;
  capturedAt: number; // When we captured this entry (ms)
  sourceHost: string;
  sourcePort: number;
  connectionId?: string;
}

/**
 * Ordering for slow/command-log queries.
 * - `recent` (default): newest first (`captured_at`/`timestamp` DESC).
 * - `magnitude`: worst offenders first (`duration` DESC). Note `duration` holds
 *   microseconds for `slow` entries and bytes for `large-request`/`large-reply`,
 *   so `magnitude` means "largest value of that log type" in both cases.
 */
export type CommandLogSortBy = 'recent' | 'magnitude';

export interface SlowLogQueryOptions {
  startTime?: number; // Unix timestamp in seconds
  endTime?: number;
  command?: string;
  clientName?: string;
  minDuration?: number; // Microseconds
  limit?: number;
  offset?: number;
  connectionId?: string;
  sortBy?: CommandLogSortBy;
}

// Command Log Entry Types (Valkey-specific)
export type CommandLogType = 'slow' | 'large-request' | 'large-reply';

export interface StoredCommandLogEntry {
  id: number; // Original commandlog ID from Valkey
  timestamp: number; // Unix timestamp in seconds
  duration: number; // Microseconds
  command: string[]; // Command name + args
  clientAddress: string;
  clientName: string;
  type: CommandLogType; // slow, large-request, or large-reply
  capturedAt: number; // When we captured this entry (ms)
  sourceHost: string;
  sourcePort: number;
  connectionId?: string;
}

export interface CommandLogQueryOptions {
  startTime?: number; // Unix timestamp in seconds
  endTime?: number;
  command?: string;
  clientName?: string;
  type?: CommandLogType;
  minDuration?: number; // Microseconds
  limit?: number;
  offset?: number;
  connectionId?: string;
  sortBy?: CommandLogSortBy;
}

// Latency Snapshot Types
export interface StoredLatencySnapshot {
  id: string; // UUID
  timestamp: number; // When we captured this snapshot (ms)
  eventName: string;
  latestEventTimestamp: number; // Unix timestamp from LATENCY LATEST
  maxLatency: number; // Microseconds
  connectionId?: string;
}

export interface LatencySnapshotQueryOptions {
  connectionId?: string;
  startTime?: number;
  endTime?: number;
  limit?: number;
  offset?: number;
}

export interface StoredLatencyHistogram {
  id: string;
  timestamp: number;
  data: Record<string, { calls: number; histogram: Record<string, number> }>;
  connectionId?: string;
}

// Command Stats Sample Types
export interface StoredCommandStatsSample {
  id: string;
  connectionId: string;
  command: string;
  callsTotal: number;
  usecTotal: number | null;
  usecPerCall: number | null;
  rejectedCalls: number | null;
  failedCalls: number | null;
  callsDelta: number;
  usecDelta: number | null;
  intervalMs: number;
  capturedAt: number;
}

export interface CommandStatsHistoryQueryOptions {
  connectionId: string;
  command: string;
  startTime: number;
  endTime: number;
  limit?: number;
}

// Latency Stats Sample Types (INFO latencystats, per-command p50/p99/p99.9)
export interface StoredLatencyStatsSample {
  id: string;
  connectionId: string;
  command: string;
  p50Us: number;
  p99Us: number;
  p999Us: number;
  serverVersion: string;
  capturedAt: number;
}

export interface LatencyStatsHistoryQueryOptions {
  connectionId: string;
  /** Optional so the regression detector can pull all commands in one query. */
  command?: string;
  startTime: number;
  endTime: number;
  /**
   * Max rows to keep PER COMMAND (most-recent within the window). Without a `command` filter the
   * cap is applied per command, not across the combined result — otherwise a busy instance with
   * many tracked commands would keep only a short shared slice per command and the regression
   * baselines (6h/≥5 upgrade, 24h/≥30 sustained) would be starved despite older rows in storage.
   * Default 10,000.
   */
  limit?: number;
}

// Memory Snapshot Types
export interface StoredMemorySnapshot {
  id: string; // UUID
  timestamp: number; // When we captured this snapshot (ms)
  usedMemory: number;
  usedMemoryRss: number | null;
  usedMemoryPeak: number | null;
  memFragmentationRatio: number | null;
  maxmemory: number;
  allocatorFragRatio: number | null;
  opsPerSec: number;
  cpuSys: number;
  cpuUser: number;
  ioThreadedReads: number | null;
  ioThreadedWrites: number | null;
  connectedClients?: number | null;
  maxclients?: number | null;
  totalKeys?: number | null;
  connectionId?: string;
}

export interface StoredScalingReadinessScore {
  id: string;
  connectionId: string;
  timestamp: number;
  score: number;
  band: ReadinessBand;
  bindingDimension: ReadinessDimensionKey | null;
  dimensions: ReadinessDimension[];
}

export interface ScalingReadinessScoreQuery {
  connectionId: string;
  from?: number;
  to?: number;
  limit?: number;
}

export interface StoredKvCacheEngine {
  id: string;
  connectionId: string;
  name: string;
  source: KvCacheEngineSource;
  scrapeUrl: string | null;
  scrapeAuthHeader: string | null;
  scrapeAuthEncrypted: boolean;
  otlpEngineId: string | null;
  enabled: boolean;
  createdAt: number;
  lastSeenAt: number | null;
  lastError: string | null;
}

export interface KvCacheRangeQuery {
  connectionId: string;
  from?: number;
  to?: number;
  limit?: number;
}

export interface KvCacheFootprintQuery extends KvCacheRangeQuery {
  bucketMs?: number;
}

export interface KvCacheSampleQuery extends KvCacheRangeQuery {
  engineId?: string;
  modelName?: string;
  bucketMs?: number;
}

export interface KvCacheSampleTotals {
  requestedTokens: number;
  hitTokens: number;
}

export interface MemorySnapshotQueryOptions {
  connectionId?: string;
  startTime?: number;
  endTime?: number;
  limit?: number;
  offset?: number;
}

/**
 * Common fields shared between StoredSlowLogEntry and StoredCommandLogEntry
 * that can be mapped to SlowLogEntry for pattern analysis.
 */
interface StoredLogEntryBase {
  id: number;
  timestamp: number;
  duration: number;
  command: string[];
  clientAddress: string;
  clientName: string;
}

/**
 * Converts a stored log entry (slowlog or commandlog) to SlowLogEntry format
 * for use with the pattern analyzer.
 */
export function toSlowLogEntry(entry: StoredLogEntryBase): {
  id: number;
  timestamp: number;
  duration: number;
  command: string[];
  clientAddress: string;
  clientName: string;
} {
  return {
    id: entry.id,
    timestamp: entry.timestamp,
    duration: entry.duration,
    command: entry.command,
    clientAddress: entry.clientAddress,
    clientName: entry.clientName,
  };
}

export interface StoragePort {
  initialize(): Promise<void>;
  close(): Promise<void>;
  isReady(): boolean;

  // ACL/Audit Methods - connectionId required for writes, optional filter for reads
  saveAclEntries(entries: StoredAclEntry[], connectionId: string): Promise<number>;
  getAclEntries(options?: AuditQueryOptions): Promise<StoredAclEntry[]>;
  getAuditStats(startTime?: number, endTime?: number, connectionId?: string): Promise<AuditStats>;
  pruneOldEntries(olderThanTimestamp: number, connectionId?: string): Promise<number>;

  // Client Analytics Methods - connectionId required for writes, optional filter for reads
  saveClientSnapshot(clients: StoredClientSnapshot[], connectionId: string): Promise<number>;
  getClientSnapshots(options?: ClientSnapshotQueryOptions): Promise<StoredClientSnapshot[]>;
  getClientTimeSeries(
    startTime: number,
    endTime: number,
    bucketSizeMs?: number,
    connectionId?: string,
  ): Promise<ClientTimeSeriesPoint[]>;
  /**
   * Aggregate stats over raw client_snapshots rows with captured_at in [startTime, endTime].
   * Callers must pass both bounds (and normally a connectionId): the read is a single pass over every
   * matching row, so an unbounded call scans the connection's (or the whole table's) history.
   * Historical / scrape-time reads should merge rollups instead. Semantics: byName / byUser
   * track only non-empty values, byUserAndName only pairs where both are non-empty
   * (keyed `${user}:${name}`); current = count in the latest batch in range; peak = largest
   * single batch (ties resolve to the earliest captured_at); avgAge = mean over rows;
   * uniqueIps counts addr up to the first ':'; timeRange is null when no rows match.
   */
  getClientAnalyticsStats(
    startTime?: number,
    endTime?: number,
    connectionId?: string,
  ): Promise<ClientAnalyticsStats>;
  getClientConnectionHistory(
    identifier: { name?: string; user?: string; addr?: string },
    startTime?: number,
    endTime?: number,
    connectionId?: string,
  ): Promise<StoredClientSnapshot[]>;
  pruneOldClientSnapshots(olderThanTimestamp: number, connectionId?: string): Promise<number>;

  // Client Analytics Rollups - fed by ClientAnalyticsRollupService, read by Prometheus and the UI.
  // Every raw read below is bounded by connection and a captured_at range and must be served by the
  // (connection_id, captured_at) index; none may scan the whole table.
  /** Oldest and newest captured_at for one connection, or null when it has no rows. */
  getClientSnapshotBounds(connectionId: string): Promise<{ earliest: number; latest: number } | null>;
  /**
   * Smallest captured_at among one connection's rows with captured_at > afterExclusive, or null when
   * none is newer. A single probe of the (connection_id, captured_at) index; lets the aggregator jump
   * over an empty gap (monitor downtime) instead of walking it chunk by chunk.
   */
  getClientSnapshotNextCapturedAt(connectionId: string, afterExclusive: number): Promise<number | null>;
  /** Raw rows with captured_at > startExclusive AND captured_at <= endInclusive, grouped by (captured_at, name, user, ip), ordered by captured_at ascending. */
  getClientSnapshotGroups(
    connectionId: string,
    startExclusive: number,
    endInclusive: number,
  ): Promise<ClientSnapshotGroupRow[]>;
  /** Insert or replace whole bucket rows keyed by (connectionId, bucketStart). */
  upsertClientAnalyticsRollups(rollups: ClientAnalyticsRollup[]): Promise<void>;
  /** Bucket rows with bucketStart in [startBucket, endBucket] inclusive, ordered by bucketStart then connectionId. Omitting connectionId returns every connection's rows. */
  getClientAnalyticsRollups(
    startBucket: number,
    endBucket: number,
    connectionId?: string,
  ): Promise<ClientAnalyticsRollup[]>;
  /** Newest lastCapturedAt among a connection's bucket rows, or null when it has none. */
  getClientAnalyticsRollupWatermark(connectionId: string): Promise<number | null>;
  /** Oldest bucketStart among a connection's bucket rows, or null when it has none. */
  getClientAnalyticsRollupFloor(connectionId: string): Promise<number | null>;
  /**
   * Largest peakConnections among a connection's bucket rows with bucketStart >= sinceBucket, with its
   * peakCapturedAt; ties resolve to the earliest peakCapturedAt. Null when no row matches. Reads only the
   * two numeric columns over the primary-key range, never the JSON columns.
   */
  getClientAnalyticsRollupPeak(
    connectionId: string,
    sinceBucket: number,
  ): Promise<{ peak: number; capturedAt: number } | null>;
  pruneOldClientAnalyticsRollups(olderThanBucketStart: number, connectionId?: string): Promise<number>;
  /** True once the (connection_id, captured_at) index on client_snapshots exists and is valid (always true on adapters that build it synchronously). */
  isClientSnapshotIndexReady(): Promise<boolean>;

  // Anomaly Methods - connectionId required for writes, optional filter for reads
  saveAnomalyEvent(event: StoredAnomalyEvent, connectionId: string): Promise<string>;
  saveAnomalyEvents(events: StoredAnomalyEvent[], connectionId: string): Promise<number>;
  getAnomalyEvents(options?: AnomalyQueryOptions): Promise<StoredAnomalyEvent[]>;
  getAnomalyStats(
    startTime?: number,
    endTime?: number,
    connectionId?: string,
  ): Promise<AnomalyStats>;
  /**
   * Mark an anomaly resolved. Idempotent: returns true when the anomaly is
   * resolved (whether this call changed it or it was already resolved), and
   * false only when no anomaly with that id exists.
   */
  resolveAnomaly(id: string, resolvedAt: number): Promise<boolean>;
  pruneOldAnomalyEvents(cutoffTimestamp: number, connectionId?: string): Promise<number>;

  saveCorrelatedGroup(group: StoredCorrelatedGroup, connectionId: string): Promise<string>;
  getCorrelatedGroups(options?: AnomalyQueryOptions): Promise<StoredCorrelatedGroup[]>;
  pruneOldCorrelatedGroups(cutoffTimestamp: number, connectionId?: string): Promise<number>;

  // Key Analytics Methods - connectionId required for writes, optional filter for reads
  saveKeyPatternSnapshots(snapshots: KeyPatternSnapshot[], connectionId: string): Promise<number>;
  getKeyPatternSnapshots(options?: KeyPatternQueryOptions): Promise<KeyPatternSnapshot[]>;
  getKeyAnalyticsSummary(
    startTime?: number,
    endTime?: number,
    connectionId?: string,
    db?: number,
  ): Promise<KeyAnalyticsSummary | null>;
  getKeyPatternTrends(
    pattern: string,
    startTime: number,
    endTime: number,
    connectionId?: string,
    db?: number,
  ): Promise<
    Array<{
      timestamp: number;
      keyCount: number;
      memoryBytes: number;
      staleCount: number;
    }>
  >;
  pruneOldKeyPatternSnapshots(cutoffTimestamp: number, connectionId?: string): Promise<number>;
  /** Distinct logical database indexes present in stored key-pattern snapshots. */
  getKeyAnalyticsDatabases(connectionId?: string): Promise<number[]>;

  // Hot Key Stats Methods - connectionId required for writes, optional filter for reads
  saveHotKeys(entries: HotKeyEntry[], connectionId: string): Promise<number>;
  getHotKeys(options?: HotKeyQueryOptions): Promise<HotKeyEntry[]>;
  /**
   * Distinct logical database indexes present in stored hot-key stats. Separate
   * from getKeyAnalyticsDatabases because hot-key / composite rows live in
   * hot_key_stats, which can diverge from key_pattern_snapshots.
   */
  getHotKeyDatabases(connectionId?: string): Promise<number[]>;
  pruneOldHotKeys(cutoffTimestamp: number, connectionId?: string): Promise<number>;

  // Settings Methods (global, not connection-scoped)
  getSettings(): Promise<AppSettings | null>;
  saveSettings(settings: AppSettings): Promise<AppSettings>;
  updateSettings(updates: Partial<AppSettings>): Promise<AppSettings>;

  // Webhook Methods - connectionId optional filter for scoping webhooks to connections
  createWebhook(webhook: Omit<Webhook, 'id' | 'createdAt' | 'updatedAt'>): Promise<Webhook>;
  getWebhook(id: string): Promise<Webhook | null>;
  getWebhooksByInstance(connectionId?: string): Promise<Webhook[]>;
  getWebhooksByEvent(event: WebhookEventType, connectionId?: string): Promise<Webhook[]>;
  updateWebhook(
    id: string,
    updates: Partial<Omit<Webhook, 'id' | 'createdAt' | 'updatedAt'>>,
  ): Promise<Webhook | null>;
  deleteWebhook(id: string): Promise<boolean>;

  // Webhook Delivery Methods - connectionId optional filter
  createDelivery(delivery: Omit<WebhookDelivery, 'id' | 'createdAt'>): Promise<WebhookDelivery>;
  getDelivery(id: string): Promise<WebhookDelivery | null>;
  getDeliveriesByWebhook(
    webhookId: string,
    limit?: number,
    offset?: number,
  ): Promise<WebhookDelivery[]>;
  updateDelivery(
    id: string,
    updates: Partial<Omit<WebhookDelivery, 'id' | 'webhookId' | 'createdAt'>>,
  ): Promise<boolean>;
  getRetriableDeliveries(limit?: number, connectionId?: string): Promise<WebhookDelivery[]>;
  pruneOldDeliveries(cutoffTimestamp: number, connectionId?: string): Promise<number>;

  // Bulk-Delete Audit Methods - one row per execute run
  saveBulkDeleteAudit(record: StoredBulkDeleteAudit): Promise<string>;
  getBulkDeleteAudits(options?: BulkDeleteAuditQueryOptions): Promise<StoredBulkDeleteAudit[]>;
  /**
   * Reconcile rows left 'running' by a crashed/restarted process: set them to
   * 'failed' with the given error/timestamp. Returns the number updated.
   */
  markInterruptedBulkDeleteRuns(error: string, completedAt: number): Promise<number>;

  // Slow Log Methods - connectionId required for writes, optional filter for reads
  saveSlowLogEntries(entries: StoredSlowLogEntry[], connectionId: string): Promise<number>;
  getSlowLogEntries(options?: SlowLogQueryOptions): Promise<StoredSlowLogEntry[]>;
  getLatestSlowLogId(connectionId?: string): Promise<number | null>;
  pruneOldSlowLogEntries(cutoffTimestamp: number, connectionId?: string): Promise<number>;

  // Command Log Methods (Valkey-specific) - connectionId required for writes, optional filter for reads
  saveCommandLogEntries(entries: StoredCommandLogEntry[], connectionId: string): Promise<number>;
  getCommandLogEntries(options?: CommandLogQueryOptions): Promise<StoredCommandLogEntry[]>;
  getLatestCommandLogId(type: CommandLogType, connectionId?: string): Promise<number | null>;
  pruneOldCommandLogEntries(cutoffTimestamp: number, connectionId?: string): Promise<number>;

  // Latency Snapshot Methods - connectionId required for writes, optional filter for reads
  saveLatencySnapshots(snapshots: StoredLatencySnapshot[], connectionId: string): Promise<number>;
  getLatencySnapshots(options?: LatencySnapshotQueryOptions): Promise<StoredLatencySnapshot[]>;
  pruneOldLatencySnapshots(cutoffTimestamp: number, connectionId?: string): Promise<number>;

  // Latency Histogram Methods
  saveLatencyHistogram(histogram: StoredLatencyHistogram, connectionId: string): Promise<number>;
  getLatencyHistograms(options?: {
    connectionId?: string;
    startTime?: number;
    endTime?: number;
    limit?: number;
  }): Promise<StoredLatencyHistogram[]>;
  pruneOldLatencyHistograms(cutoffTimestamp: number, connectionId?: string): Promise<number>;

  // Memory Snapshot Methods - connectionId required for writes, optional filter for reads
  saveMemorySnapshots(snapshots: StoredMemorySnapshot[], connectionId: string): Promise<number>;
  getMemorySnapshots(options?: MemorySnapshotQueryOptions): Promise<StoredMemorySnapshot[]>;
  pruneOldMemorySnapshots(cutoffTimestamp: number, connectionId?: string): Promise<number>;

  saveScalingReadinessScore(score: StoredScalingReadinessScore): Promise<void>;
  getScalingReadinessScores(query: ScalingReadinessScoreQuery): Promise<StoredScalingReadinessScore[]>;
  pruneOldScalingReadinessScores(cutoffTimestamp: number, connectionId?: string): Promise<number>;
  getScalingReadinessSettings(connectionId: string): Promise<ScalingReadinessSettings | null>;
  saveScalingReadinessSettings(settings: ScalingReadinessSettings): Promise<ScalingReadinessSettings>;
  saveKvCacheFootprintSnapshot(snapshot: KvCacheFootprintSnapshot): Promise<void>;
  getKvCacheFootprintSnapshots(query: KvCacheFootprintQuery): Promise<KvCacheFootprintSnapshot[]>;
  pruneOldKvCacheFootprintSnapshots(cutoffTimestamp: number, connectionId?: string): Promise<number>;
  saveKvCacheEngineSamples(samples: KvCacheEngineSample[]): Promise<void>;
  getKvCacheEngineSamples(query: KvCacheSampleQuery): Promise<KvCacheEngineSample[]>;
  getKvCacheSampleTotals(query: Omit<KvCacheSampleQuery, 'limit' | 'bucketMs'>): Promise<KvCacheSampleTotals>;
  pruneOldKvCacheEngineSamples(cutoffTimestamp: number, connectionId?: string): Promise<number>;
  deleteKvCacheEngineSamples(engineId: string): Promise<void>;
  saveKvCacheEngine(engine: StoredKvCacheEngine): Promise<StoredKvCacheEngine>;
  getKvCacheEngines(connectionId?: string): Promise<StoredKvCacheEngine[]>;
  getKvCacheEngine(id: string): Promise<StoredKvCacheEngine | null>;
  deleteKvCacheEngine(id: string): Promise<boolean>;
  getKvCacheSettings(connectionId: string): Promise<KvCacheSettings | null>;
  saveKvCacheSettings(settings: KvCacheSettings): Promise<KvCacheSettings>;
  deleteKvCacheConnectionData(connectionId: string): Promise<void>;

  listSessionNamespaces(connectionId: string): Promise<SessionNamespace[]>;
  getSessionNamespace(connectionId: string, id: string): Promise<SessionNamespace | null>;
  saveSessionNamespace(ns: SessionNamespace): Promise<SessionNamespace>;
  deleteSessionNamespace(connectionId: string, id: string): Promise<boolean>;

  // Command Stats Sample Methods - connectionId required for writes
  saveCommandStatsSamples(
    samples: Omit<StoredCommandStatsSample, 'id' | 'connectionId'>[],
    connectionId: string,
  ): Promise<number>;
  getCommandStatsHistory(options: CommandStatsHistoryQueryOptions): Promise<StoredCommandStatsSample[]>;
  pruneOldCommandStatsSamples(cutoffTimestamp: number, connectionId?: string): Promise<number>;

  // Latency Stats Sample Methods (INFO latencystats) - connectionId required for writes
  saveLatencyStatsSamples(
    samples: Omit<StoredLatencyStatsSample, 'id' | 'connectionId'>[],
    connectionId: string,
  ): Promise<number>;
  getLatencyStatsHistory(options: LatencyStatsHistoryQueryOptions): Promise<StoredLatencyStatsSample[]>;
  pruneOldLatencyStatsSamples(cutoffTimestamp: number, connectionId?: string): Promise<number>;

  // AI Cache/Memory Sample Methods (AI Cache & Memory observability) - connectionId required for writes
  saveAiCacheSamples(
    samples: Omit<StoredAiCacheSample, 'id' | 'connectionId'>[],
    connectionId: string,
  ): Promise<number>;
  getAiCacheHistory(options: AiCacheHistoryQueryOptions): Promise<StoredAiCacheSample[]>;
  pruneOldAiCacheSamples(cutoffTimestamp: number, connectionId?: string): Promise<number>;

  // OTLP Trace Methods (AI Cache & Memory observability — Phase 2)
  saveOtelSpans(spans: StoredOtelSpan[]): Promise<number>;
  getOtelTraces(options: OtelTraceQueryOptions): Promise<OtelTraceSummary[]>;
  getOtelTraceSpans(traceId: string): Promise<StoredOtelSpan[]>;
  pruneOldOtelSpans(cutoffTimestamp: number): Promise<number>;

  // Vector Index Snapshot Methods
  saveVectorIndexSnapshots(snapshots: VectorIndexSnapshot[], connectionId: string): Promise<number>;
  getVectorIndexSnapshots(options: VectorIndexSnapshotQueryOptions): Promise<VectorIndexSnapshot[]>;
  pruneOldVectorIndexSnapshots(cutoffTimestamp: number, connectionId?: string): Promise<number>;

  // CVE Inspection Methods
  saveCveDataset(dataset: StoredCveDataset): Promise<void>;
  getCveDataset(): Promise<StoredCveDataset | null>;
  saveCveScanResult(result: CveScanResult): Promise<void>;
  getCveScanResult(connectionId: string): Promise<CveScanResult | null>;
  deleteCveScanResult(connectionId: string): Promise<void>;

  // Monitor Capture Session Methods - connectionId required for writes, optional filter for reads
  saveCaptureSession(session: StoredCaptureSession, connectionId: string): Promise<string>;
  updateCaptureSession(id: string, patch: CaptureSessionPatch): Promise<boolean>;
  getCaptureSession(id: string): Promise<StoredCaptureSession | null>;
  getCaptureSessions(options?: CaptureSessionQueryOptions): Promise<StoredCaptureSession[]>;
  saveCaptureChunk(chunk: StoredCaptureChunk): Promise<number>;
  getCaptureChunks(sessionId: string): Promise<StoredCaptureChunk[]>;

  // Monitor Capture Trigger Methods (Pro+)
  saveCaptureTrigger(trigger: StoredCaptureTrigger): Promise<string>;
  updateCaptureTrigger(id: string, patch: CaptureTriggerPatch): Promise<boolean>;
  getCaptureTrigger(id: string): Promise<StoredCaptureTrigger | null>;
  getCaptureTriggers(options?: CaptureTriggerQueryOptions): Promise<StoredCaptureTrigger[]>;

  // Monitor Scheduled Capture Methods (Pro+)
  saveScheduledCapture(schedule: StoredScheduledCapture): Promise<string>;
  updateScheduledCapture(id: string, patch: ScheduledCapturePatch): Promise<boolean>;
  deleteScheduledCapture(id: string): Promise<boolean>;
  getScheduledCapture(id: string): Promise<StoredScheduledCapture | null>;
  getScheduledCaptures(options?: ScheduledCaptureQueryOptions): Promise<StoredScheduledCapture[]>;

  // Monitor data-retention prune hooks (PR 22)
  pruneOldCaptureSessions(cutoffTimestamp: number): Promise<number>;
  pruneOldCaptureChunks(cutoffTimestamp: number): Promise<number>;
  pruneOldCaptureTriggers(cutoffTimestamp: number): Promise<number>;
  pruneOldScheduledCaptures(cutoffTimestamp: number): Promise<number>;

  // Connection Management Methods (not connection-scoped, they manage connections themselves)
  saveConnection(config: DatabaseConnectionConfig): Promise<void>;
  getConnections(): Promise<DatabaseConnectionConfig[]>;
  getConnection(id: string): Promise<DatabaseConnectionConfig | null>;
  deleteConnection(id: string): Promise<void>;
  updateConnection(id: string, updates: Partial<DatabaseConnectionConfig>): Promise<void>;

  saveAgentToken(token: AgentToken): Promise<void>;
  getAgentTokens(type?: TokenType): Promise<AgentToken[]>;
  getAgentTokenByHash(hash: string): Promise<AgentToken | null>;
  revokeAgentToken(id: string): Promise<void>;
  updateAgentTokenLastUsed(id: string): Promise<void>;

  // Metric Forecasting Settings
  getMetricForecastSettings(
    connectionId: string,
    metricKind: MetricKind,
  ): Promise<MetricForecastSettings | null>;
  saveMetricForecastSettings(settings: MetricForecastSettings): Promise<MetricForecastSettings>;
  deleteMetricForecastSettings(connectionId: string, metricKind: MetricKind): Promise<boolean>;
  getActiveMetricForecastSettings(): Promise<MetricForecastSettings[]>;

  // Cache Proposal Methods
  createCacheProposal(input: CreateCacheProposalInput): Promise<StoredCacheProposal>;
  getCacheProposal(id: string): Promise<StoredCacheProposal | null>;
  listCacheProposals(options: ListCacheProposalsOptions): Promise<StoredCacheProposal[]>;
  updateCacheProposalStatus(input: UpdateProposalStatusInput): Promise<StoredCacheProposal | null>;
  expireCacheProposalsBefore(now: number): Promise<StoredCacheProposal[]>;
  appendCacheProposalAudit(input: AppendProposalAuditInput): Promise<StoredCacheProposalAudit>;
  getCacheProposalAudit(proposalId: string): Promise<StoredCacheProposalAudit[]>;

  // Memory Proposal Methods
  createMemoryProposal(input: CreateMemoryProposalInput): Promise<StoredMemoryProposal>;
  getMemoryProposal(id: string): Promise<StoredMemoryProposal | null>;
  listMemoryProposals(options: ListMemoryProposalsOptions): Promise<StoredMemoryProposal[]>;
  updateMemoryProposalStatus(
    input: UpdateMemoryProposalStatusInput,
  ): Promise<StoredMemoryProposal | null>;
  appendMemoryProposalAudit(
    input: AppendMemoryProposalAuditInput,
  ): Promise<StoredMemoryProposalAudit>;
  getMemoryProposalAudit(proposalId: string): Promise<StoredMemoryProposalAudit[]>;
  expireMemoryProposalsBefore(now: number): Promise<StoredMemoryProposal[]>;
  /**
   * Move `applying` rows claimed before `cutoff` to `failed`. The apply path
   * deliberately leaves a visible in-flight row if the process dies mid-apply;
   * without this they stay `applying` forever and are found only by hand.
   */
  failStaleApplyingMemoryProposalsBefore(cutoff: number): Promise<StoredMemoryProposal[]>;
  /**
   * How many pending proposals in this store already target the same thing.
   * Answers the duplicate question in the query rather than paging rows into
   * memory and comparing them there.
   */
  countPendingMemoryProposalsByTarget(input: {
    connection_id: string;
    store_name: string;
    target_discriminator: string;
  }): Promise<number>;

  getMaintenanceWindowRepository(): MaintenanceWindowRepository;

  getInvitationRepository(): InvitationRepository;

  getActivityRepository(): ActivityRepository;
}
