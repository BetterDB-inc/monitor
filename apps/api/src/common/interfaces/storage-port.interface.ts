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
  Webhook,
  WebhookDelivery,
  WebhookEventType,
  DeliveryStatus,
  DatabaseConnectionConfig,
} from '@betterdb/shared';
import type { StoredAclEntry, AuditQueryOptions, AuditStats } from '@betterdb/shared';
import type {
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
  Webhook,
  WebhookDelivery,
  WebhookEventType,
  DeliveryStatus,
  DatabaseConnectionConfig,
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
  id: number;  // Original slowlog ID from Valkey/Redis
  timestamp: number;  // Unix timestamp in seconds
  duration: number;  // Microseconds
  command: string[];  // Command name + args (e.g., ['GET', 'key1'])
  clientAddress: string;
  clientName: string;
  capturedAt: number;  // When we captured this entry (ms)
  sourceHost: string;
  sourcePort: number;
  connectionId?: string;
}

export interface SlowLogQueryOptions {
  startTime?: number;  // Unix timestamp in seconds
  endTime?: number;
  command?: string;
  clientName?: string;
  minDuration?: number;  // Microseconds
  limit?: number;
  offset?: number;
  connectionId?: string;
}

// Command Log Entry Types (Valkey-specific)
export type CommandLogType = 'slow' | 'large-request' | 'large-reply';

export interface StoredCommandLogEntry {
  id: number;  // Original commandlog ID from Valkey
  timestamp: number;  // Unix timestamp in seconds
  duration: number;  // Microseconds
  command: string[];  // Command name + args
  clientAddress: string;
  clientName: string;
  type: CommandLogType;  // slow, large-request, or large-reply
  capturedAt: number;  // When we captured this entry (ms)
  sourceHost: string;
  sourcePort: number;
  connectionId?: string;
}

export interface CommandLogQueryOptions {
  startTime?: number;  // Unix timestamp in seconds
  endTime?: number;
  command?: string;
  clientName?: string;
  type?: CommandLogType;
  minDuration?: number;  // Microseconds
  limit?: number;
  offset?: number;
  connectionId?: string;
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
  getClientTimeSeries(startTime: number, endTime: number, bucketSizeMs?: number, connectionId?: string): Promise<ClientTimeSeriesPoint[]>;
  getClientAnalyticsStats(startTime?: number, endTime?: number, connectionId?: string): Promise<ClientAnalyticsStats>;
  getClientConnectionHistory(identifier: { name?: string; user?: string; addr?: string }, startTime?: number, endTime?: number, connectionId?: string): Promise<StoredClientSnapshot[]>;
  pruneOldClientSnapshots(olderThanTimestamp: number, connectionId?: string): Promise<number>;

  // Anomaly Methods - connectionId required for writes, optional filter for reads
  saveAnomalyEvent(event: StoredAnomalyEvent, connectionId: string): Promise<string>;
  saveAnomalyEvents(events: StoredAnomalyEvent[], connectionId: string): Promise<number>;
  getAnomalyEvents(options?: AnomalyQueryOptions): Promise<StoredAnomalyEvent[]>;
  getAnomalyStats(startTime?: number, endTime?: number, connectionId?: string): Promise<AnomalyStats>;
  resolveAnomaly(id: string, resolvedAt: number): Promise<boolean>;
  pruneOldAnomalyEvents(cutoffTimestamp: number, connectionId?: string): Promise<number>;

  saveCorrelatedGroup(group: StoredCorrelatedGroup, connectionId: string): Promise<string>;
  getCorrelatedGroups(options?: AnomalyQueryOptions): Promise<StoredCorrelatedGroup[]>;
  pruneOldCorrelatedGroups(cutoffTimestamp: number, connectionId?: string): Promise<number>;

  // Key Analytics Methods - connectionId required for writes, optional filter for reads
  saveKeyPatternSnapshots(snapshots: KeyPatternSnapshot[], connectionId: string): Promise<number>;
  getKeyPatternSnapshots(options?: KeyPatternQueryOptions): Promise<KeyPatternSnapshot[]>;
  getKeyAnalyticsSummary(startTime?: number, endTime?: number, connectionId?: string): Promise<KeyAnalyticsSummary | null>;
  getKeyPatternTrends(pattern: string, startTime: number, endTime: number, connectionId?: string): Promise<Array<{
    timestamp: number;
    keyCount: number;
    memoryBytes: number;
    staleCount: number;
  }>>;
  pruneOldKeyPatternSnapshots(cutoffTimestamp: number, connectionId?: string): Promise<number>;

  // Settings Methods (global, not connection-scoped)
  getSettings(): Promise<AppSettings | null>;
  saveSettings(settings: AppSettings): Promise<AppSettings>;
  updateSettings(updates: SettingsUpdateRequest): Promise<AppSettings>;

  // Webhook Methods - connectionId optional filter for scoping webhooks to connections
  createWebhook(webhook: Omit<Webhook, 'id' | 'createdAt' | 'updatedAt'>): Promise<Webhook>;
  getWebhook(id: string): Promise<Webhook | null>;
  getWebhooksByInstance(connectionId?: string): Promise<Webhook[]>;
  getWebhooksByEvent(event: WebhookEventType, connectionId?: string): Promise<Webhook[]>;
  updateWebhook(id: string, updates: Partial<Omit<Webhook, 'id' | 'createdAt' | 'updatedAt'>>): Promise<Webhook | null>;
  deleteWebhook(id: string): Promise<boolean>;

  // Webhook Delivery Methods - connectionId optional filter
  createDelivery(delivery: Omit<WebhookDelivery, 'id' | 'createdAt'>): Promise<WebhookDelivery>;
  getDelivery(id: string): Promise<WebhookDelivery | null>;
  getDeliveriesByWebhook(webhookId: string, limit?: number, offset?: number): Promise<WebhookDelivery[]>;
  updateDelivery(id: string, updates: Partial<Omit<WebhookDelivery, 'id' | 'webhookId' | 'createdAt'>>): Promise<boolean>;
  getRetriableDeliveries(limit?: number, connectionId?: string): Promise<WebhookDelivery[]>;
  pruneOldDeliveries(cutoffTimestamp: number, connectionId?: string): Promise<number>;

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

  // Connection Management Methods (not connection-scoped, they manage connections themselves)
  saveConnection(config: DatabaseConnectionConfig): Promise<void>;
  getConnections(): Promise<DatabaseConnectionConfig[]>;
  getConnection(id: string): Promise<DatabaseConnectionConfig | null>;
  deleteConnection(id: string): Promise<void>;
  updateConnection(id: string, updates: Partial<DatabaseConnectionConfig>): Promise<void>;

  // Agent Token Methods (cloud-only, optional — implementations may no-op)
  saveAgentToken(token: { id: string; name: string; tokenHash: string; createdAt: number; expiresAt: number; revokedAt: number | null; lastUsedAt: number | null }): Promise<void>;
  getAgentTokens(): Promise<Array<{ id: string; name: string; tokenHash: string; createdAt: number; expiresAt: number; revokedAt: number | null; lastUsedAt: number | null }>>;
  getAgentTokenByHash(hash: string): Promise<{ id: string; name: string; tokenHash: string; createdAt: number; expiresAt: number; revokedAt: number | null; lastUsedAt: number | null } | null>;
  revokeAgentToken(id: string): Promise<void>;
  updateAgentTokenLastUsed(id: string): Promise<void>;
}
