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
}

export interface AnomalyStats {
  totalEvents: number;
  bySeverity: Record<string, number>;
  byMetric: Record<string, number>;
  byPattern: Record<string, number>;
  unresolvedCount: number;
}

export interface StoragePort {
  initialize(): Promise<void>;
  close(): Promise<void>;
  isReady(): boolean;

  saveAclEntries(entries: StoredAclEntry[]): Promise<number>;
  getAclEntries(options?: AuditQueryOptions): Promise<StoredAclEntry[]>;
  getAuditStats(startTime?: number, endTime?: number): Promise<AuditStats>;
  pruneOldEntries(olderThanTimestamp: number): Promise<number>;

  saveClientSnapshot(clients: StoredClientSnapshot[]): Promise<number>;
  getClientSnapshots(options?: ClientSnapshotQueryOptions): Promise<StoredClientSnapshot[]>;
  getClientTimeSeries(startTime: number, endTime: number, bucketSizeMs?: number): Promise<ClientTimeSeriesPoint[]>;
  getClientAnalyticsStats(startTime?: number, endTime?: number): Promise<ClientAnalyticsStats>;
  getClientConnectionHistory(identifier: { name?: string; user?: string; addr?: string }, startTime?: number, endTime?: number): Promise<StoredClientSnapshot[]>;
  pruneOldClientSnapshots(olderThanTimestamp: number): Promise<number>;

  // Anomaly Methods
  saveAnomalyEvent(event: StoredAnomalyEvent): Promise<string>;
  saveAnomalyEvents(events: StoredAnomalyEvent[]): Promise<number>;
  getAnomalyEvents(options?: AnomalyQueryOptions): Promise<StoredAnomalyEvent[]>;
  getAnomalyStats(startTime?: number, endTime?: number): Promise<AnomalyStats>;
  resolveAnomaly(id: string, resolvedAt: number): Promise<boolean>;
  pruneOldAnomalyEvents(cutoffTimestamp: number): Promise<number>;

  saveCorrelatedGroup(group: StoredCorrelatedGroup): Promise<string>;
  getCorrelatedGroups(options?: AnomalyQueryOptions): Promise<StoredCorrelatedGroup[]>;
  pruneOldCorrelatedGroups(cutoffTimestamp: number): Promise<number>;

  // Key Analytics Methods
  saveKeyPatternSnapshots(snapshots: KeyPatternSnapshot[]): Promise<number>;
  getKeyPatternSnapshots(options?: KeyPatternQueryOptions): Promise<KeyPatternSnapshot[]>;
  getKeyAnalyticsSummary(startTime?: number, endTime?: number): Promise<KeyAnalyticsSummary | null>;
  getKeyPatternTrends(pattern: string, startTime: number, endTime: number): Promise<Array<{
    timestamp: number;
    keyCount: number;
    memoryBytes: number;
    staleCount: number;
  }>>;
  pruneOldKeyPatternSnapshots(cutoffTimestamp: number): Promise<number>;

  // Settings Methods
  getSettings(): Promise<AppSettings | null>;
  saveSettings(settings: AppSettings): Promise<AppSettings>;
  updateSettings(updates: SettingsUpdateRequest): Promise<AppSettings>;

  // Webhook Methods
  createWebhook(webhook: Omit<Webhook, 'id' | 'createdAt' | 'updatedAt'>): Promise<Webhook>;
  getWebhook(id: string): Promise<Webhook | null>;
  getWebhooksByInstance(): Promise<Webhook[]>;
  getWebhooksByEvent(event: WebhookEventType): Promise<Webhook[]>;
  updateWebhook(id: string, updates: Partial<Omit<Webhook, 'id' | 'createdAt' | 'updatedAt'>>): Promise<Webhook | null>;
  deleteWebhook(id: string): Promise<boolean>;

  // Webhook Delivery Methods
  createDelivery(delivery: Omit<WebhookDelivery, 'id' | 'createdAt'>): Promise<WebhookDelivery>;
  getDelivery(id: string): Promise<WebhookDelivery | null>;
  getDeliveriesByWebhook(webhookId: string, limit?: number): Promise<WebhookDelivery[]>;
  updateDelivery(id: string, updates: Partial<Omit<WebhookDelivery, 'id' | 'webhookId' | 'createdAt'>>): Promise<boolean>;
  getRetriableDeliveries(limit?: number): Promise<WebhookDelivery[]>;
  pruneOldDeliveries(cutoffTimestamp: number): Promise<number>;
}
