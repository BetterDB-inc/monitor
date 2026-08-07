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
export type { MetricForecastSettings, MetricKind } from '@betterdb/shared';
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
import type {
  AppSettings,
  AuditQueryOptions,
  AuditStats,
  ClientAnalyticsStats,
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
  usecTotal: number;
  usecPerCall: number;
  rejectedCalls: number;
  failedCalls: number;
  callsDelta: number;
  usecDelta: number;
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
  usedMemoryRss: number;
  usedMemoryPeak: number;
  memFragmentationRatio: number;
  maxmemory: number;
  allocatorFragRatio: number;
  opsPerSec: number;
  cpuSys: number;
  cpuUser: number;
  ioThreadedReads: number;
  ioThreadedWrites: number;
  connectionId?: string;
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
  ): Promise<KeyAnalyticsSummary | null>;
  getKeyPatternTrends(
    pattern: string,
    startTime: number,
    endTime: number,
    connectionId?: string,
  ): Promise<
    Array<{
      timestamp: number;
      keyCount: number;
      memoryBytes: number;
      staleCount: number;
    }>
  >;
  pruneOldKeyPatternSnapshots(cutoffTimestamp: number, connectionId?: string): Promise<number>;

  // Hot Key Stats Methods - connectionId required for writes, optional filter for reads
  saveHotKeys(entries: HotKeyEntry[], connectionId: string): Promise<number>;
  getHotKeys(options?: HotKeyQueryOptions): Promise<HotKeyEntry[]>;
  pruneOldHotKeys(cutoffTimestamp: number, connectionId?: string): Promise<number>;

  // Settings Methods (global, not connection-scoped)
  getSettings(): Promise<AppSettings | null>;
  saveSettings(settings: AppSettings): Promise<AppSettings>;
  updateSettings(updates: SettingsUpdateRequest): Promise<AppSettings>;

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

  // Command Stats Sample Methods - connectionId required for writes
  saveCommandStatsSamples(
    samples: Omit<StoredCommandStatsSample, 'id' | 'connectionId'>[],
    connectionId: string,
  ): Promise<number>;
  getCommandStatsHistory(
    options: CommandStatsHistoryQueryOptions,
  ): Promise<StoredCommandStatsSample[]>;
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

  // Agent/MCP Token Methods (cloud-only, optional — implementations may no-op)
  saveAgentToken(token: {
    id: string;
    name: string;
    type: 'agent' | 'mcp';
    tokenHash: string;
    createdAt: number;
    expiresAt: number;
    revokedAt: number | null;
    lastUsedAt: number | null;
  }): Promise<void>;
  getAgentTokens(type?: 'agent' | 'mcp'): Promise<
    Array<{
      id: string;
      name: string;
      type: 'agent' | 'mcp';
      tokenHash: string;
      createdAt: number;
      expiresAt: number;
      revokedAt: number | null;
      lastUsedAt: number | null;
    }>
  >;
  getAgentTokenByHash(hash: string): Promise<{
    id: string;
    name: string;
    type: 'agent' | 'mcp';
    tokenHash: string;
    createdAt: number;
    expiresAt: number;
    revokedAt: number | null;
    lastUsedAt: number | null;
  } | null>;
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
  failStaleApplyingMemoryProposalsBefore(now: number): Promise<StoredMemoryProposal[]>;
}
