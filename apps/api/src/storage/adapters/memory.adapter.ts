import { randomUUID } from 'crypto';
import {
  StoragePort,
  StoredAclEntry,
  AuditQueryOptions,
  AuditStats,
  StoredClientSnapshot,
  ClientSnapshotQueryOptions,
  ClientTimeSeriesPoint,
  ClientAnalyticsStats,
  StoredAnomalyEvent,
  StoredBulkDeleteAudit,
  BulkDeleteAuditQueryOptions,
  StoredCorrelatedGroup,
  AnomalyQueryOptions,
  AnomalyStats,
  KeyPatternSnapshot,
  KeyPatternQueryOptions,
  KeyAnalyticsSummary,
  AppSettings,
  SettingsUpdateRequest,
  Webhook,
  WebhookDelivery,
  WebhookEventType,
  StoredSlowLogEntry,
  SlowLogQueryOptions,
  StoredCommandLogEntry,
  CommandLogQueryOptions,
  CommandLogType,
  StoredLatencySnapshot,
  LatencySnapshotQueryOptions,
  StoredMemorySnapshot,
  MemorySnapshotQueryOptions,
  StoredLatencyHistogram,
  HotKeyEntry,
  HotKeyQueryOptions,
  DatabaseConnectionConfig,
  StoredCommandStatsSample,
  CommandStatsHistoryQueryOptions,
  StoredLatencyStatsSample,
  LatencyStatsHistoryQueryOptions,
  StoredAiCacheSample,
  AiCacheHistoryQueryOptions,
  StoredOtelSpan,
  OtelTraceSummary,
  OtelTraceQueryOptions,
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
} from '../../common/interfaces/storage-port.interface';
import type {
  VectorIndexSnapshot,
  VectorIndexSnapshotQueryOptions,
  MetricForecastSettings,
  MetricKind,
  StoredCacheProposal,
  StoredCacheProposalAudit,
  CreateCacheProposalInput,
  ListCacheProposalsOptions,
  StoredMemoryProposal,
  StoredMemoryProposalAudit,
  CreateMemoryProposalInput,
  ListMemoryProposalsOptions,
  UpdateMemoryProposalStatusInput,
  AppendMemoryProposalAuditInput,
  UpdateProposalStatusInput,
  AppendProposalAuditInput,
} from '@betterdb/shared';
import {
  PROPOSAL_DEFAULT_EXPIRY_MS,
  variantPayloadSchemaFor,
  MEMORY_PROPOSAL_DEFAULT_EXPIRY_MS,
} from '@betterdb/shared';
import { WebhookMemoryRepository } from './repositories/webhook.memory.repository';
import { SlowLogMemoryRepository } from './repositories/slowlog.memory.repository';

const NULL_SUB_DISCRIMINATOR = '__betterdb_null__';

function pendingProposalSubDiscriminator(
  p: { proposal_type: string; proposal_payload: unknown },
): string | null {
  const payload = p.proposal_payload as Record<string, unknown> | null | undefined;
  if (p.proposal_type === 'threshold_adjust') {
    const category = payload?.category;
    return typeof category === 'string' ? category : NULL_SUB_DISCRIMINATOR;
  }
  if (p.proposal_type === 'tool_ttl_adjust') {
    const toolName = payload?.tool_name;
    return typeof toolName === 'string' ? toolName : NULL_SUB_DISCRIMINATOR;
  }
  return null;
}

function memoryProposalTargetDiscriminator(payload: unknown): string {
  const p = payload as Record<string, unknown> | null | undefined;
  if (p?.target_kind === 'id') {
    return `id:${String(p.memory_id)}`;
  }
  const scope = (p?.scope ?? {}) as Record<string, unknown>;
  const tags = Array.isArray(p?.tags) ? [...(p.tags as string[])].sort() : [];
  return `scope:${JSON.stringify(scope)}|tags:${tags.join(',')}`;
}

export class MemoryAdapter implements StoragePort {
  private aclEntries: StoredAclEntry[] = [];
  private clientSnapshots: StoredClientSnapshot[] = [];
  private anomalyEvents: StoredAnomalyEvent[] = [];
  private bulkDeleteAudits: StoredBulkDeleteAudit[] = [];
  private correlatedGroups: StoredCorrelatedGroup[] = [];
  private commandLogEntries: StoredCommandLogEntry[] = [];
  private latencySnapshots: StoredLatencySnapshot[] = [];
  private latencyHistograms: StoredLatencyHistogram[] = [];
  private memorySnapshots: StoredMemorySnapshot[] = [];
  private vectorIndexSnapshots: VectorIndexSnapshot[] = [];
  private metricForecastSettings: Map<string, MetricForecastSettings> = new Map();
  private settings: AppSettings | null = null;
  private readonly MAX_DELIVERIES_PER_WEBHOOK = 1000;
  private readonly webhookRepo = new WebhookMemoryRepository(this.MAX_DELIVERIES_PER_WEBHOOK);
  private readonly slowlogRepo = new SlowLogMemoryRepository();
  private idCounter = 1;
  private ready: boolean = false;

  async initialize(): Promise<void> {
    this.ready = true;
  }

  async close(): Promise<void> {
    this.aclEntries = [];
    this.clientSnapshots = [];
    this.ready = false;
  }

  isReady(): boolean {
    return this.ready;
  }

  async saveAclEntries(entries: StoredAclEntry[], connectionId: string): Promise<number> {
    for (const entry of entries) {
      // Check for duplicates based on unique constraint (including connectionId)
      const existingIndex = this.aclEntries.findIndex(
        (e) =>
          e.timestampCreated === entry.timestampCreated &&
          e.username === entry.username &&
          e.object === entry.object &&
          e.reason === entry.reason &&
          e.sourceHost === entry.sourceHost &&
          e.sourcePort === entry.sourcePort &&
          e.connectionId === connectionId,
      );

      if (existingIndex >= 0) {
        // Update existing entry
        this.aclEntries[existingIndex] = {
          ...this.aclEntries[existingIndex],
          count: entry.count,
          ageSeconds: entry.ageSeconds,
          timestampLastUpdated: entry.timestampLastUpdated,
          capturedAt: entry.capturedAt,
        };
      } else {
        // Add new entry with connectionId
        this.aclEntries.push({ ...entry, id: this.idCounter++, connectionId });
      }
    }
    return entries.length;
  }

  async getAclEntries(options: AuditQueryOptions = {}): Promise<StoredAclEntry[]> {
    let filtered = [...this.aclEntries];

    if (options.connectionId) {
      filtered = filtered.filter((e) => e.connectionId === options.connectionId);
    }

    if (options.username) {
      filtered = filtered.filter((e) => e.username === options.username);
    }

    if (options.reason) {
      filtered = filtered.filter((e) => e.reason === options.reason);
    }

    if (options.startTime) {
      filtered = filtered.filter((e) => e.capturedAt >= options.startTime!);
    }

    if (options.endTime) {
      filtered = filtered.filter((e) => e.capturedAt <= options.endTime!);
    }

    // Sort by captured_at DESC, id DESC
    filtered.sort((a, b) => {
      if (b.capturedAt !== a.capturedAt) {
        return b.capturedAt - a.capturedAt;
      }
      return (b.id || 0) - (a.id || 0);
    });

    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    return filtered.slice(offset, offset + limit);
  }

  async getAuditStats(
    startTime?: number,
    endTime?: number,
    connectionId?: string,
  ): Promise<AuditStats> {
    let filtered = [...this.aclEntries];

    if (connectionId) {
      filtered = filtered.filter((e) => e.connectionId === connectionId);
    }

    if (startTime) {
      filtered = filtered.filter((e) => e.capturedAt >= startTime);
    }

    if (endTime) {
      filtered = filtered.filter((e) => e.capturedAt <= endTime);
    }

    const entriesByReason: Record<string, number> = {};
    const entriesByUser: Record<string, number> = {};
    const uniqueUsers = new Set<string>();

    for (const entry of filtered) {
      entriesByReason[entry.reason] = (entriesByReason[entry.reason] || 0) + 1;
      entriesByUser[entry.username] = (entriesByUser[entry.username] || 0) + 1;
      uniqueUsers.add(entry.username);
    }

    let timeRange = null;
    if (filtered.length > 0) {
      const timestamps = filtered.map((e) => e.capturedAt).sort((a, b) => a - b);
      timeRange = {
        earliest: timestamps[0],
        latest: timestamps[timestamps.length - 1],
      };
    }

    return {
      totalEntries: filtered.length,
      uniqueUsers: uniqueUsers.size,
      entriesByReason,
      entriesByUser,
      timeRange,
    };
  }

  async pruneOldEntries(olderThanTimestamp: number, connectionId?: string): Promise<number> {
    const before = this.aclEntries.length;
    if (connectionId) {
      this.aclEntries = this.aclEntries.filter(
        (e) => e.capturedAt >= olderThanTimestamp || e.connectionId !== connectionId,
      );
    } else {
      this.aclEntries = this.aclEntries.filter((e) => e.capturedAt >= olderThanTimestamp);
    }
    return before - this.aclEntries.length;
  }

  async saveClientSnapshot(clients: StoredClientSnapshot[], connectionId: string): Promise<number> {
    for (const client of clients) {
      this.clientSnapshots.push({ ...client, id: this.idCounter++, connectionId });
    }
    return clients.length;
  }

  async getClientSnapshots(
    options: ClientSnapshotQueryOptions = {},
  ): Promise<StoredClientSnapshot[]> {
    let filtered = [...this.clientSnapshots];

    if (options.connectionId) {
      filtered = filtered.filter((c) => c.connectionId === options.connectionId);
    }

    if (options.clientName) {
      filtered = filtered.filter((c) => c.name === options.clientName);
    }

    if (options.user) {
      filtered = filtered.filter((c) => c.user === options.user);
    }

    if (options.addr) {
      if (options.addr.includes('%')) {
        const pattern = options.addr.replace(/%/g, '.*');
        const regex = new RegExp(pattern);
        filtered = filtered.filter((c) => regex.test(c.addr));
      } else {
        filtered = filtered.filter((c) => c.addr === options.addr);
      }
    }

    if (options.startTime) {
      filtered = filtered.filter((c) => c.capturedAt >= options.startTime!);
    }

    if (options.endTime) {
      filtered = filtered.filter((c) => c.capturedAt <= options.endTime!);
    }

    // Sort by captured_at DESC, id DESC
    filtered.sort((a, b) => {
      if (b.capturedAt !== a.capturedAt) {
        return b.capturedAt - a.capturedAt;
      }
      return (b.id || 0) - (a.id || 0);
    });

    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    return filtered.slice(offset, offset + limit);
  }

  async getClientTimeSeries(
    startTime: number,
    endTime: number,
    bucketSizeMs: number = 60000,
    connectionId?: string,
  ): Promise<ClientTimeSeriesPoint[]> {
    let filtered = this.clientSnapshots.filter(
      (c) => c.capturedAt >= startTime && c.capturedAt <= endTime,
    );
    if (connectionId) {
      filtered = filtered.filter((c) => c.connectionId === connectionId);
    }

    const pointsMap = new Map<number, ClientTimeSeriesPoint>();

    for (const client of filtered) {
      const bucketTime = Math.floor(client.capturedAt / bucketSizeMs) * bucketSizeMs;

      if (!pointsMap.has(bucketTime)) {
        pointsMap.set(bucketTime, {
          timestamp: bucketTime,
          totalConnections: 0,
          byName: {},
          byUser: {},
          byAddr: {},
        });
      }

      const point = pointsMap.get(bucketTime)!;
      point.totalConnections += 1;

      if (client.name) {
        point.byName[client.name] = (point.byName[client.name] || 0) + 1;
      }
      if (client.user) {
        point.byUser[client.user] = (point.byUser[client.user] || 0) + 1;
      }
      const ip = client.addr.split(':')[0];
      point.byAddr[ip] = (point.byAddr[ip] || 0) + 1;
    }

    return Array.from(pointsMap.values()).sort((a, b) => a.timestamp - b.timestamp);
  }

  async getClientAnalyticsStats(
    startTime?: number,
    endTime?: number,
    connectionId?: string,
  ): Promise<ClientAnalyticsStats> {
    let filtered = [...this.clientSnapshots];

    if (connectionId) {
      filtered = filtered.filter((c) => c.connectionId === connectionId);
    }

    if (startTime) {
      filtered = filtered.filter((c) => c.capturedAt >= startTime);
    }

    if (endTime) {
      filtered = filtered.filter((c) => c.capturedAt <= endTime);
    }

    const latestTimestamp =
      filtered.length > 0 ? Math.max(...filtered.map((c) => c.capturedAt)) : 0;
    const currentClients = filtered.filter((c) => c.capturedAt === latestTimestamp);

    // Group by captured_at to find peak
    const byTimestamp = new Map<number, number>();
    for (const client of filtered) {
      byTimestamp.set(client.capturedAt, (byTimestamp.get(client.capturedAt) || 0) + 1);
    }

    let peakConnections = 0;
    let peakTimestamp = 0;
    for (const [timestamp, count] of byTimestamp.entries()) {
      if (count > peakConnections) {
        peakConnections = count;
        peakTimestamp = timestamp;
      }
    }

    const uniqueNames = new Set(filtered.map((c) => c.name).filter((n) => n));
    const uniqueUsers = new Set(filtered.map((c) => c.user).filter((u) => u));
    const uniqueIps = new Set(filtered.map((c) => c.addr.split(':')[0]));

    // Connections by name
    const connectionsByName: Record<string, { current: number; peak: number; avgAge: number }> = {};
    const byName = new Map<string, StoredClientSnapshot[]>();
    for (const client of filtered) {
      if (client.name) {
        if (!byName.has(client.name)) {
          byName.set(client.name, []);
        }
        byName.get(client.name)!.push(client);
      }
    }

    for (const [name, clients] of byName.entries()) {
      const currentCount = currentClients.filter((c) => c.name === name).length;
      const byTimestampForName = new Map<number, number>();
      for (const client of clients) {
        byTimestampForName.set(
          client.capturedAt,
          (byTimestampForName.get(client.capturedAt) || 0) + 1,
        );
      }
      const peakForName = Math.max(...Array.from(byTimestampForName.values()));
      const avgAge = clients.reduce((sum, c) => sum + c.age, 0) / clients.length;

      connectionsByName[name] = {
        current: currentCount,
        peak: peakForName,
        avgAge,
      };
    }

    // Connections by user
    const connectionsByUser: Record<string, { current: number; peak: number }> = {};
    const byUser = new Map<string, StoredClientSnapshot[]>();
    for (const client of filtered) {
      if (client.user) {
        if (!byUser.has(client.user)) {
          byUser.set(client.user, []);
        }
        byUser.get(client.user)!.push(client);
      }
    }

    for (const [user, clients] of byUser.entries()) {
      const currentCount = currentClients.filter((c) => c.user === user).length;
      const byTimestampForUser = new Map<number, number>();
      for (const client of clients) {
        byTimestampForUser.set(
          client.capturedAt,
          (byTimestampForUser.get(client.capturedAt) || 0) + 1,
        );
      }
      const peakForUser = Math.max(...Array.from(byTimestampForUser.values()));

      connectionsByUser[user] = {
        current: currentCount,
        peak: peakForUser,
      };
    }

    // Connections by user and name
    const connectionsByUserAndName: Record<
      string,
      { user: string; name: string; current: number; peak: number; avgAge: number }
    > = {};
    const byUserAndName = new Map<string, StoredClientSnapshot[]>();
    for (const client of filtered) {
      if (client.user && client.name) {
        const key = `${client.user}:${client.name}`;
        if (!byUserAndName.has(key)) {
          byUserAndName.set(key, []);
        }
        byUserAndName.get(key)!.push(client);
      }
    }

    for (const [key, clients] of byUserAndName.entries()) {
      const [user, name] = key.split(':');
      const currentCount = currentClients.filter((c) => c.user === user && c.name === name).length;
      const byTimestampForCombined = new Map<number, number>();
      for (const client of clients) {
        byTimestampForCombined.set(
          client.capturedAt,
          (byTimestampForCombined.get(client.capturedAt) || 0) + 1,
        );
      }
      const peakForCombined = Math.max(...Array.from(byTimestampForCombined.values()));
      const avgAge = clients.reduce((sum, c) => sum + c.age, 0) / clients.length;

      connectionsByUserAndName[key] = {
        user,
        name,
        current: currentCount,
        peak: peakForCombined,
        avgAge,
      };
    }

    let timeRange = null;
    if (filtered.length > 0) {
      const timestamps = filtered.map((c) => c.capturedAt).sort((a, b) => a - b);
      timeRange = {
        earliest: timestamps[0],
        latest: timestamps[timestamps.length - 1],
      };
    }

    return {
      currentConnections: currentClients.length,
      peakConnections,
      peakTimestamp,
      uniqueClientNames: uniqueNames.size,
      uniqueUsers: uniqueUsers.size,
      uniqueIps: uniqueIps.size,
      connectionsByName,
      connectionsByUser,
      connectionsByUserAndName,
      timeRange,
    };
  }

  async getClientConnectionHistory(
    identifier: { name?: string; user?: string; addr?: string },
    startTime?: number,
    endTime?: number,
    connectionId?: string,
  ): Promise<StoredClientSnapshot[]> {
    let filtered = [...this.clientSnapshots];

    if (connectionId) {
      filtered = filtered.filter((c) => c.connectionId === connectionId);
    }

    if (identifier.name) {
      filtered = filtered.filter((c) => c.name === identifier.name);
    }

    if (identifier.user) {
      filtered = filtered.filter((c) => c.user === identifier.user);
    }

    if (identifier.addr) {
      filtered = filtered.filter((c) => c.addr === identifier.addr);
    }

    if (startTime) {
      filtered = filtered.filter((c) => c.capturedAt >= startTime);
    }

    if (endTime) {
      filtered = filtered.filter((c) => c.capturedAt <= endTime);
    }

    // Sort by captured_at ASC
    return filtered.sort((a, b) => a.capturedAt - b.capturedAt);
  }

  async pruneOldClientSnapshots(
    olderThanTimestamp: number,
    connectionId?: string,
  ): Promise<number> {
    const before = this.clientSnapshots.length;
    if (connectionId) {
      this.clientSnapshots = this.clientSnapshots.filter(
        (c) => c.capturedAt >= olderThanTimestamp || c.connectionId !== connectionId,
      );
    } else {
      this.clientSnapshots = this.clientSnapshots.filter((c) => c.capturedAt >= olderThanTimestamp);
    }
    return before - this.clientSnapshots.length;
  }

  async saveAnomalyEvent(event: StoredAnomalyEvent, connectionId: string): Promise<string> {
    this.anomalyEvents.push({ ...event, connectionId });
    return event.id;
  }

  async saveBulkDeleteAudit(record: StoredBulkDeleteAudit): Promise<string> {
    // Upsert by id so a running record can be finalized in place.
    const idx = this.bulkDeleteAudits.findIndex((r) => r.id === record.id);
    if (idx >= 0) this.bulkDeleteAudits[idx] = { ...record };
    else this.bulkDeleteAudits.push({ ...record });
    return record.id;
  }

  async getBulkDeleteAudits(
    options: BulkDeleteAuditQueryOptions = {},
  ): Promise<StoredBulkDeleteAudit[]> {
    let filtered = [...this.bulkDeleteAudits];
    if (options.connectionId)
      filtered = filtered.filter((r) => r.connectionId === options.connectionId);
    if (options.startTime) filtered = filtered.filter((r) => r.timestamp >= options.startTime!);
    if (options.endTime) filtered = filtered.filter((r) => r.timestamp <= options.endTime!);
    return filtered
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, options.limit ?? 100);
  }

  async markInterruptedBulkDeleteRuns(error: string, completedAt: number): Promise<number> {
    let updated = 0;
    for (const record of this.bulkDeleteAudits) {
      if (record.status === 'running') {
        record.status = 'failed';
        record.error = error;
        record.completedAt = completedAt;
        updated += 1;
      }
    }
    return updated;
  }

  async saveAnomalyEvents(events: StoredAnomalyEvent[], connectionId: string): Promise<number> {
    for (const event of events) {
      this.anomalyEvents.push({ ...event, connectionId });
    }
    return events.length;
  }

  async getAnomalyEvents(options: AnomalyQueryOptions = {}): Promise<StoredAnomalyEvent[]> {
    let filtered = [...this.anomalyEvents];

    if (options.connectionId)
      filtered = filtered.filter((e) => e.connectionId === options.connectionId);
    if (options.startTime) filtered = filtered.filter((e) => e.timestamp >= options.startTime!);
    if (options.endTime) filtered = filtered.filter((e) => e.timestamp <= options.endTime!);
    if (options.severity) filtered = filtered.filter((e) => e.severity === options.severity);
    if (options.metricType) filtered = filtered.filter((e) => e.metricType === options.metricType);
    if (options.resolved !== undefined)
      filtered = filtered.filter((e) => e.resolved === options.resolved);

    return filtered
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? 100));
  }

  async getAnomalyStats(
    startTime?: number,
    endTime?: number,
    connectionId?: string,
  ): Promise<AnomalyStats> {
    let filtered = [...this.anomalyEvents];
    if (connectionId) filtered = filtered.filter((e) => e.connectionId === connectionId);
    if (startTime) filtered = filtered.filter((e) => e.timestamp >= startTime);
    if (endTime) filtered = filtered.filter((e) => e.timestamp <= endTime);

    const bySeverity: Record<string, number> = {};
    const byMetric: Record<string, number> = {};

    for (const e of filtered) {
      bySeverity[e.severity] = (bySeverity[e.severity] ?? 0) + 1;
      byMetric[e.metricType] = (byMetric[e.metricType] ?? 0) + 1;
    }

    return {
      totalEvents: filtered.length,
      bySeverity,
      byMetric,
      byPattern: {},
      unresolvedCount: filtered.filter((e) => !e.resolved).length,
    };
  }

  async resolveAnomaly(id: string, resolvedAt: number): Promise<boolean> {
    const event = this.anomalyEvents.find((e) => e.id === id);
    if (!event) return false; // no such anomaly
    if (!event.resolved) {
      event.resolved = true;
      event.resolvedAt = resolvedAt;
      event.durationMs = resolvedAt - event.timestamp;
    }
    // Idempotent: report success whether we just resolved it or it was already resolved.
    return true;
  }

  async pruneOldAnomalyEvents(cutoffTimestamp: number, connectionId?: string): Promise<number> {
    const before = this.anomalyEvents.length;
    if (connectionId) {
      this.anomalyEvents = this.anomalyEvents.filter(
        (e) => e.timestamp >= cutoffTimestamp || e.connectionId !== connectionId,
      );
    } else {
      this.anomalyEvents = this.anomalyEvents.filter((e) => e.timestamp >= cutoffTimestamp);
    }
    return before - this.anomalyEvents.length;
  }

  async saveCorrelatedGroup(group: StoredCorrelatedGroup, connectionId: string): Promise<string> {
    const existing = this.correlatedGroups.findIndex(
      (g) => g.correlationId === group.correlationId && g.connectionId === connectionId,
    );
    if (existing >= 0) {
      this.correlatedGroups[existing] = { ...group, connectionId };
    } else {
      this.correlatedGroups.push({ ...group, connectionId });
    }
    return group.correlationId;
  }

  async getCorrelatedGroups(options: AnomalyQueryOptions = {}): Promise<StoredCorrelatedGroup[]> {
    let filtered = [...this.correlatedGroups];

    if (options.connectionId)
      filtered = filtered.filter((g) => g.connectionId === options.connectionId);
    if (options.startTime) filtered = filtered.filter((g) => g.timestamp >= options.startTime!);
    if (options.endTime) filtered = filtered.filter((g) => g.timestamp <= options.endTime!);
    if (options.severity) filtered = filtered.filter((g) => g.severity === options.severity);
    if (options.pattern) filtered = filtered.filter((g) => g.pattern === options.pattern);

    return filtered
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? 50));
  }

  async pruneOldCorrelatedGroups(cutoffTimestamp: number, connectionId?: string): Promise<number> {
    const before = this.correlatedGroups.length;
    if (connectionId) {
      this.correlatedGroups = this.correlatedGroups.filter(
        (g) => g.timestamp >= cutoffTimestamp || g.connectionId !== connectionId,
      );
    } else {
      this.correlatedGroups = this.correlatedGroups.filter((g) => g.timestamp >= cutoffTimestamp);
    }
    return before - this.correlatedGroups.length;
  }

  async saveKeyPatternSnapshots(
    _snapshots: KeyPatternSnapshot[],
    _connectionId: string,
  ): Promise<number> {
    throw new Error('Key analytics not supported in memory adapter');
  }

  async getKeyPatternSnapshots(_options?: KeyPatternQueryOptions): Promise<KeyPatternSnapshot[]> {
    throw new Error('Key analytics not supported in memory adapter');
  }

  async getKeyAnalyticsSummary(
    _startTime?: number,
    _endTime?: number,
    _connectionId?: string,
  ): Promise<KeyAnalyticsSummary | null> {
    throw new Error('Key analytics not supported in memory adapter');
  }

  async getKeyPatternTrends(
    _pattern: string,
    _startTime: number,
    _endTime: number,
    _connectionId?: string,
  ): Promise<
    Array<{
      timestamp: number;
      keyCount: number;
      memoryBytes: number;
      staleCount: number;
    }>
  > {
    throw new Error('Key analytics not supported in memory adapter');
  }

  async pruneOldKeyPatternSnapshots(
    _cutoffTimestamp: number,
    _connectionId?: string,
  ): Promise<number> {
    throw new Error('Key analytics not supported in memory adapter');
  }

  async saveHotKeys(_entries: HotKeyEntry[], _connectionId: string): Promise<number> {
    throw new Error('Hot key stats not supported in memory adapter');
  }

  async getHotKeys(_options?: HotKeyQueryOptions): Promise<HotKeyEntry[]> {
    throw new Error('Hot key stats not supported in memory adapter');
  }

  async pruneOldHotKeys(_cutoffTimestamp: number, _connectionId?: string): Promise<number> {
    throw new Error('Hot key stats not supported in memory adapter');
  }

  async getSettings(): Promise<AppSettings | null> {
    return this.settings ? { ...this.settings } : null;
  }

  async saveSettings(settings: AppSettings): Promise<AppSettings> {
    const now = Date.now();
    this.settings = {
      ...settings,
      id: 1,
      updatedAt: now,
      createdAt: this.settings?.createdAt ?? now,
    };
    return { ...this.settings };
  }

  async updateSettings(updates: SettingsUpdateRequest): Promise<AppSettings> {
    if (!this.settings) {
      throw new Error('Settings not found. Initialize settings first.');
    }

    // Only update valid settings fields, ignore any extra fields
    const validUpdates: Partial<AppSettings> = {};
    if (updates.auditPollIntervalMs !== undefined) {
      validUpdates.auditPollIntervalMs = updates.auditPollIntervalMs;
    }
    if (updates.clientAnalyticsPollIntervalMs !== undefined) {
      validUpdates.clientAnalyticsPollIntervalMs = updates.clientAnalyticsPollIntervalMs;
    }
    if (updates.anomalyPollIntervalMs !== undefined) {
      validUpdates.anomalyPollIntervalMs = updates.anomalyPollIntervalMs;
    }
    if (updates.anomalyCacheTtlMs !== undefined) {
      validUpdates.anomalyCacheTtlMs = updates.anomalyCacheTtlMs;
    }
    if (updates.anomalyPrometheusIntervalMs !== undefined) {
      validUpdates.anomalyPrometheusIntervalMs = updates.anomalyPrometheusIntervalMs;
    }
    if (updates.metricForecastingEnabled !== undefined) {
      validUpdates.metricForecastingEnabled = updates.metricForecastingEnabled;
    }
    if (updates.metricForecastingDefaultRollingWindowMs !== undefined) {
      validUpdates.metricForecastingDefaultRollingWindowMs =
        updates.metricForecastingDefaultRollingWindowMs;
    }
    if (updates.metricForecastingDefaultAlertThresholdMs !== undefined) {
      validUpdates.metricForecastingDefaultAlertThresholdMs =
        updates.metricForecastingDefaultAlertThresholdMs;
    }
    if (updates.inferenceSlaConfig !== undefined) {
      validUpdates.inferenceSlaConfig = updates.inferenceSlaConfig;
    }

    this.settings = {
      ...this.settings,
      ...validUpdates,
      updatedAt: Date.now(),
    };
    return { ...this.settings };
  }

  async createWebhook(webhook: Omit<Webhook, 'id' | 'createdAt' | 'updatedAt'>): Promise<Webhook> {
    return this.webhookRepo.createWebhook(webhook);
  }

  async getWebhook(id: string): Promise<Webhook | null> {
    return this.webhookRepo.getWebhook(id);
  }

  async getWebhooksByInstance(connectionId?: string): Promise<Webhook[]> {
    return this.webhookRepo.getWebhooksByInstance(connectionId);
  }

  async getWebhooksByEvent(event: WebhookEventType, connectionId?: string): Promise<Webhook[]> {
    return this.webhookRepo.getWebhooksByEvent(event, connectionId);
  }

  async updateWebhook(
    id: string,
    updates: Partial<Omit<Webhook, 'id' | 'createdAt' | 'updatedAt'>>,
  ): Promise<Webhook | null> {
    return this.webhookRepo.updateWebhook(id, updates);
  }

  async deleteWebhook(id: string): Promise<boolean> {
    return this.webhookRepo.deleteWebhook(id);
  }

  async createDelivery(
    delivery: Omit<WebhookDelivery, 'id' | 'createdAt'>,
  ): Promise<WebhookDelivery> {
    return this.webhookRepo.createDelivery(delivery);
  }

  async getDelivery(id: string): Promise<WebhookDelivery | null> {
    return this.webhookRepo.getDelivery(id);
  }

  async getDeliveriesByWebhook(
    webhookId: string,
    limit: number = 50,
    offset: number = 0,
  ): Promise<WebhookDelivery[]> {
    return this.webhookRepo.getDeliveriesByWebhook(webhookId, limit, offset);
  }

  async updateDelivery(
    id: string,
    updates: Partial<Omit<WebhookDelivery, 'id' | 'webhookId' | 'createdAt'>>,
  ): Promise<boolean> {
    return this.webhookRepo.updateDelivery(id, updates);
  }

  async getRetriableDeliveries(
    limit: number = 100,
    connectionId?: string,
  ): Promise<WebhookDelivery[]> {
    return this.webhookRepo.getRetriableDeliveries(limit, connectionId);
  }

  async pruneOldDeliveries(cutoffTimestamp: number, connectionId?: string): Promise<number> {
    return this.webhookRepo.pruneOldDeliveries(cutoffTimestamp, connectionId);
  }

  // Slow Log Methods
  async saveSlowLogEntries(entries: StoredSlowLogEntry[], connectionId: string): Promise<number> {
    return this.slowlogRepo.saveSlowLogEntries(entries, connectionId);
  }

  async getSlowLogEntries(options: SlowLogQueryOptions = {}): Promise<StoredSlowLogEntry[]> {
    return this.slowlogRepo.getSlowLogEntries(options);
  }

  async getLatestSlowLogId(connectionId?: string): Promise<number | null> {
    return this.slowlogRepo.getLatestSlowLogId(connectionId);
  }

  async pruneOldSlowLogEntries(cutoffTimestamp: number, connectionId?: string): Promise<number> {
    return this.slowlogRepo.pruneOldSlowLogEntries(cutoffTimestamp, connectionId);
  }

  // Command Log Methods
  async saveCommandLogEntries(
    entries: StoredCommandLogEntry[],
    connectionId: string,
  ): Promise<number> {
    let savedCount = 0;
    for (const entry of entries) {
      const exists = this.commandLogEntries.some(
        (e) =>
          e.id === entry.id &&
          e.type === entry.type &&
          e.sourceHost === entry.sourceHost &&
          e.sourcePort === entry.sourcePort &&
          e.connectionId === connectionId,
      );
      if (!exists) {
        this.commandLogEntries.push({ ...entry, connectionId });
        savedCount++;
      }
    }
    return savedCount;
  }

  async getCommandLogEntries(
    options: CommandLogQueryOptions = {},
  ): Promise<StoredCommandLogEntry[]> {
    let filtered = [...this.commandLogEntries];

    if (options.connectionId) {
      filtered = filtered.filter((e) => e.connectionId === options.connectionId);
    }
    if (options.startTime) {
      filtered = filtered.filter((e) => e.timestamp >= options.startTime!);
    }
    if (options.endTime) {
      filtered = filtered.filter((e) => e.timestamp <= options.endTime!);
    }
    if (options.command) {
      const cmd = options.command.toLowerCase();
      filtered = filtered.filter((e) => e.command[0]?.toLowerCase().includes(cmd));
    }
    if (options.clientName) {
      const name = options.clientName.toLowerCase();
      filtered = filtered.filter((e) => e.clientName.toLowerCase().includes(name));
    }
    if (options.type) {
      filtered = filtered.filter((e) => e.type === options.type);
    }
    if (options.minDuration) {
      filtered = filtered.filter((e) => e.duration >= options.minDuration!);
    }

    const compare =
      options.sortBy === 'magnitude'
        ? (a: StoredCommandLogEntry, b: StoredCommandLogEntry) => b.duration - a.duration || b.timestamp - a.timestamp
        : (a: StoredCommandLogEntry, b: StoredCommandLogEntry) => b.timestamp - a.timestamp;

    return filtered
      .sort(compare)
      .slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? 100));
  }

  async getLatestCommandLogId(type: CommandLogType, connectionId?: string): Promise<number | null> {
    let entriesOfType = this.commandLogEntries.filter((e) => e.type === type);
    if (connectionId) {
      entriesOfType = entriesOfType.filter((e) => e.connectionId === connectionId);
    }
    if (entriesOfType.length === 0) return null;
    return Math.max(...entriesOfType.map((e) => e.id));
  }

  async pruneOldCommandLogEntries(cutoffTimestamp: number, connectionId?: string): Promise<number> {
    const before = this.commandLogEntries.length;
    if (connectionId) {
      this.commandLogEntries = this.commandLogEntries.filter(
        (e) => e.capturedAt >= cutoffTimestamp || e.connectionId !== connectionId,
      );
    } else {
      this.commandLogEntries = this.commandLogEntries.filter(
        (e) => e.capturedAt >= cutoffTimestamp,
      );
    }
    return before - this.commandLogEntries.length;
  }

  // Latency Snapshot Methods
  async saveLatencySnapshots(
    snapshots: StoredLatencySnapshot[],
    connectionId: string,
  ): Promise<number> {
    for (const snapshot of snapshots) {
      this.latencySnapshots.push({ ...snapshot, connectionId });
    }
    return snapshots.length;
  }

  async getLatencySnapshots(
    options: LatencySnapshotQueryOptions = {},
  ): Promise<StoredLatencySnapshot[]> {
    let filtered = [...this.latencySnapshots];

    if (options.connectionId) {
      filtered = filtered.filter((e) => e.connectionId === options.connectionId);
    }
    if (options.startTime) {
      filtered = filtered.filter((e) => e.timestamp >= options.startTime!);
    }
    if (options.endTime) {
      filtered = filtered.filter((e) => e.timestamp <= options.endTime!);
    }

    return filtered
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? 100));
  }

  async pruneOldLatencySnapshots(cutoffTimestamp: number, connectionId?: string): Promise<number> {
    const before = this.latencySnapshots.length;
    if (connectionId) {
      this.latencySnapshots = this.latencySnapshots.filter(
        (e) => e.timestamp >= cutoffTimestamp || e.connectionId !== connectionId,
      );
    } else {
      this.latencySnapshots = this.latencySnapshots.filter((e) => e.timestamp >= cutoffTimestamp);
    }
    return before - this.latencySnapshots.length;
  }

  // Latency Histogram Methods
  async saveLatencyHistogram(
    histogram: StoredLatencyHistogram,
    connectionId: string,
  ): Promise<number> {
    this.latencyHistograms.push({ ...histogram, connectionId });
    return 1;
  }

  async getLatencyHistograms(
    options: { connectionId?: string; startTime?: number; endTime?: number; limit?: number } = {},
  ): Promise<StoredLatencyHistogram[]> {
    let filtered = [...this.latencyHistograms];
    if (options.connectionId)
      filtered = filtered.filter((e) => e.connectionId === options.connectionId);
    if (options.startTime) filtered = filtered.filter((e) => e.timestamp >= options.startTime!);
    if (options.endTime) filtered = filtered.filter((e) => e.timestamp <= options.endTime!);
    return filtered.sort((a, b) => b.timestamp - a.timestamp).slice(0, options.limit ?? 1);
  }

  async pruneOldLatencyHistograms(cutoffTimestamp: number, connectionId?: string): Promise<number> {
    const before = this.latencyHistograms.length;
    if (connectionId) {
      this.latencyHistograms = this.latencyHistograms.filter(
        (e) => e.timestamp >= cutoffTimestamp || e.connectionId !== connectionId,
      );
    } else {
      this.latencyHistograms = this.latencyHistograms.filter((e) => e.timestamp >= cutoffTimestamp);
    }
    return before - this.latencyHistograms.length;
  }

  // Memory Snapshot Methods
  async saveMemorySnapshots(
    snapshots: StoredMemorySnapshot[],
    connectionId: string,
  ): Promise<number> {
    for (const snapshot of snapshots) {
      this.memorySnapshots.push({ ...snapshot, connectionId });
    }
    return snapshots.length;
  }

  async getMemorySnapshots(
    options: MemorySnapshotQueryOptions = {},
  ): Promise<StoredMemorySnapshot[]> {
    let filtered = [...this.memorySnapshots];

    if (options.connectionId) {
      filtered = filtered.filter((e) => e.connectionId === options.connectionId);
    }
    if (options.startTime) {
      filtered = filtered.filter((e) => e.timestamp >= options.startTime!);
    }
    if (options.endTime) {
      filtered = filtered.filter((e) => e.timestamp <= options.endTime!);
    }

    return filtered
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? 100));
  }

  async pruneOldMemorySnapshots(cutoffTimestamp: number, connectionId?: string): Promise<number> {
    const before = this.memorySnapshots.length;
    if (connectionId) {
      this.memorySnapshots = this.memorySnapshots.filter(
        (e) => e.timestamp >= cutoffTimestamp || e.connectionId !== connectionId,
      );
    } else {
      this.memorySnapshots = this.memorySnapshots.filter((e) => e.timestamp >= cutoffTimestamp);
    }
    return before - this.memorySnapshots.length;
  }

  // Command Stats Sample Methods
  private commandStatsSamples: StoredCommandStatsSample[] = [];

  async saveCommandStatsSamples(
    samples: Omit<StoredCommandStatsSample, 'id' | 'connectionId'>[],
    connectionId: string,
  ): Promise<number> {
    for (const s of samples) {
      this.commandStatsSamples.push({
        id: randomUUID(),
        connectionId,
        ...s,
      });
    }
    return samples.length;
  }

  async getCommandStatsHistory(
    options: CommandStatsHistoryQueryOptions,
  ): Promise<StoredCommandStatsSample[]> {
    return this.commandStatsSamples
      .filter(
        (s) =>
          s.connectionId === options.connectionId &&
          s.command === options.command &&
          s.capturedAt >= options.startTime &&
          s.capturedAt <= options.endTime,
      )
      .sort((a, b) => a.capturedAt - b.capturedAt)
      .slice(0, options.limit ?? 10_000);
  }

  async pruneOldCommandStatsSamples(
    cutoffTimestamp: number,
    connectionId?: string,
  ): Promise<number> {
    const before = this.commandStatsSamples.length;
    if (connectionId) {
      this.commandStatsSamples = this.commandStatsSamples.filter(
        (s) => s.capturedAt >= cutoffTimestamp || s.connectionId !== connectionId,
      );
    } else {
      this.commandStatsSamples = this.commandStatsSamples.filter(
        (s) => s.capturedAt >= cutoffTimestamp,
      );
    }
    return before - this.commandStatsSamples.length;
  }

  // Latency Stats Sample Methods (INFO latencystats)
  private latencyStatsSamples: StoredLatencyStatsSample[] = [];

  async saveLatencyStatsSamples(
    samples: Omit<StoredLatencyStatsSample, 'id' | 'connectionId'>[],
    connectionId: string,
  ): Promise<number> {
    for (const s of samples) {
      this.latencyStatsSamples.push({
        id: randomUUID(),
        connectionId,
        ...s,
      });
    }
    return samples.length;
  }

  async getLatencyStatsHistory(
    options: LatencyStatsHistoryQueryOptions,
  ): Promise<StoredLatencyStatsSample[]> {
    // Keep the most-recent `limit` samples PER COMMAND (not a single global cap across all
    // commands, which would starve per-command baselines on busy instances), returned ascending —
    // the regression guard needs the newest samples for freshness/version/consecutive logic.
    const limit = options.limit ?? 10_000;
    // A limit of 0 (or negative) means no rows — mirror SQL `LIMIT 0`. Guard here because
    // `slice(-0)` is `slice(0)`, which would return every row instead of none.
    if (limit <= 0) return [];
    const filtered = this.latencyStatsSamples.filter(
      (s) =>
        s.connectionId === options.connectionId &&
        (!options.command || s.command === options.command) &&
        s.capturedAt >= options.startTime &&
        s.capturedAt <= options.endTime,
    );
    const byCommand = new Map<string, StoredLatencyStatsSample[]>();
    for (const s of filtered) {
      const arr = byCommand.get(s.command) ?? [];
      arr.push(s);
      byCommand.set(s.command, arr);
    }
    const kept: StoredLatencyStatsSample[] = [];
    for (const arr of byCommand.values()) {
      arr.sort((a, b) => a.capturedAt - b.capturedAt);
      kept.push(...arr.slice(-limit));
    }
    return kept.sort((a, b) => a.capturedAt - b.capturedAt);
  }

  async pruneOldLatencyStatsSamples(
    cutoffTimestamp: number,
    connectionId?: string,
  ): Promise<number> {
    const before = this.latencyStatsSamples.length;
    if (connectionId) {
      this.latencyStatsSamples = this.latencyStatsSamples.filter(
        (s) => s.capturedAt >= cutoffTimestamp || s.connectionId !== connectionId,
      );
    } else {
      this.latencyStatsSamples = this.latencyStatsSamples.filter(
        (s) => s.capturedAt >= cutoffTimestamp,
      );
    }
    return before - this.latencyStatsSamples.length;
  }

  // AI Cache/Memory Sample Methods
  private aiCacheSamples: StoredAiCacheSample[] = [];

  async saveAiCacheSamples(
    samples: Omit<StoredAiCacheSample, 'id' | 'connectionId'>[],
    connectionId: string,
  ): Promise<number> {
    for (const s of samples) {
      this.aiCacheSamples.push({
        id: randomUUID(),
        connectionId,
        ...s,
      });
    }
    return samples.length;
  }

  async getAiCacheHistory(
    options: AiCacheHistoryQueryOptions,
  ): Promise<StoredAiCacheSample[]> {
    // Keep the most-recent `limit` samples PER INSTANCE (not a single global cap), ascending.
    const limit = options.limit ?? 10_000;
    if (limit <= 0) return [];
    const filtered = this.aiCacheSamples.filter(
      (s) =>
        (!options.connectionId || s.connectionId === options.connectionId) &&
        (!options.instanceField || s.instanceField === options.instanceField) &&
        (!options.kind || s.kind === options.kind) &&
        (options.startTime === undefined || s.timestamp >= options.startTime) &&
        (options.endTime === undefined || s.timestamp <= options.endTime),
    );
    const byInstance = new Map<string, StoredAiCacheSample[]>();
    for (const s of filtered) {
      const arr = byInstance.get(s.instanceField) ?? [];
      arr.push(s);
      byInstance.set(s.instanceField, arr);
    }
    const kept: StoredAiCacheSample[] = [];
    for (const arr of byInstance.values()) {
      arr.sort((a, b) => a.timestamp - b.timestamp);
      kept.push(...arr.slice(-limit));
    }
    return kept.sort((a, b) => a.timestamp - b.timestamp);
  }

  async pruneOldAiCacheSamples(
    cutoffTimestamp: number,
    connectionId?: string,
  ): Promise<number> {
    const before = this.aiCacheSamples.length;
    if (connectionId) {
      this.aiCacheSamples = this.aiCacheSamples.filter(
        (s) => s.timestamp >= cutoffTimestamp || s.connectionId !== connectionId,
      );
    } else {
      this.aiCacheSamples = this.aiCacheSamples.filter(
        (s) => s.timestamp >= cutoffTimestamp,
      );
    }
    return before - this.aiCacheSamples.length;
  }

  // OTLP Trace Methods
  private otelSpans: StoredOtelSpan[] = [];

  async saveOtelSpans(spans: StoredOtelSpan[]): Promise<number> {
    for (const s of spans) {
      const idx = this.otelSpans.findIndex(
        (e) => e.traceId === s.traceId && e.spanId === s.spanId,
      );
      if (idx >= 0) this.otelSpans[idx] = s;
      else this.otelSpans.push(s);
    }
    return spans.length;
  }

  async getOtelTraces(options: OtelTraceQueryOptions): Promise<OtelTraceSummary[]> {
    // Group ALL spans by trace first, then filter whole traces by their
    // trace-level start / service — so a boundary trace still gets a complete
    // summary (span count, root, duration) rather than a partial one.
    const byTrace = new Map<string, StoredOtelSpan[]>();
    for (const s of this.otelSpans) {
      byTrace.set(s.traceId, [...(byTrace.get(s.traceId) ?? []), s]);
    }
    const summaries: OtelTraceSummary[] = [];
    for (const [traceId, spans] of byTrace) {
      const minStart = Math.min(...spans.map((s) => s.startTimeMs));
      if (options.startTime !== undefined && minStart < options.startTime) continue;
      if (options.endTime !== undefined && minStart > options.endTime) continue;
      if (options.service && !spans.some((s) => s.serviceName === options.service)) continue;

      const root = spans.find((s) => s.parentSpanId === null) ?? null;
      const durationNs = root
        ? root.durationNs
        : (Math.max(...spans.map((s) => s.startTimeMs + s.durationNs / 1_000_000)) - minStart) *
          1_000_000;
      summaries.push({
        traceId,
        rootName: root?.name ?? null,
        serviceName: root?.serviceName ?? spans.find((s) => s.serviceName)?.serviceName ?? null,
        startTimeMs: minStart,
        durationNs: Math.round(durationNs),
        spanCount: spans.length,
        betterdbSpanCount: spans.filter((s) => s.scopeName.startsWith('@betterdb/')).length,
        hasError: spans.some((s) => s.statusCode === 2),
      });
    }
    summaries.sort((a, b) => b.startTimeMs - a.startTimeMs);
    return summaries.slice(0, options.limit ?? 100);
  }

  async getOtelTraceSpans(traceId: string): Promise<StoredOtelSpan[]> {
    return this.otelSpans
      .filter((s) => s.traceId === traceId)
      .sort(
        (a, b) =>
          a.startTimeMs - b.startTimeMs ||
          a.startTimeUnixNano.localeCompare(b.startTimeUnixNano),
      );
  }

  async pruneOldOtelSpans(cutoffTimestamp: number): Promise<number> {
    // Prune whole traces (by trace-level start), not individual spans, so a long
    // trace never loses its root/early spans while later ones survive.
    const minStartByTrace = new Map<string, number>();
    for (const s of this.otelSpans) {
      const cur = minStartByTrace.get(s.traceId);
      if (cur === undefined || s.startTimeMs < cur) minStartByTrace.set(s.traceId, s.startTimeMs);
    }
    const before = this.otelSpans.length;
    this.otelSpans = this.otelSpans.filter(
      (s) => (minStartByTrace.get(s.traceId) ?? s.startTimeMs) >= cutoffTimestamp,
    );
    return before - this.otelSpans.length;
  }

  // Vector Index Snapshot Methods
  async saveVectorIndexSnapshots(
    snapshots: VectorIndexSnapshot[],
    connectionId: string,
  ): Promise<number> {
    for (const snapshot of snapshots) {
      this.vectorIndexSnapshots.push({ ...snapshot, connectionId });
    }
    return snapshots.length;
  }

  async getVectorIndexSnapshots(
    options: VectorIndexSnapshotQueryOptions = {},
  ): Promise<VectorIndexSnapshot[]> {
    let filtered = [...this.vectorIndexSnapshots];

    if (options.connectionId) {
      filtered = filtered.filter((e) => e.connectionId === options.connectionId);
    }
    if (options.indexName) {
      filtered = filtered.filter((e) => e.indexName === options.indexName);
    }
    if (options.startTime) {
      filtered = filtered.filter((e) => e.timestamp >= options.startTime!);
    }
    if (options.endTime) {
      filtered = filtered.filter((e) => e.timestamp <= options.endTime!);
    }

    return filtered.sort((a, b) => b.timestamp - a.timestamp).slice(0, options.limit ?? 200);
  }

  async pruneOldVectorIndexSnapshots(
    cutoffTimestamp: number,
    connectionId?: string,
  ): Promise<number> {
    const before = this.vectorIndexSnapshots.length;
    if (connectionId) {
      this.vectorIndexSnapshots = this.vectorIndexSnapshots.filter(
        (e) => e.timestamp >= cutoffTimestamp || e.connectionId !== connectionId,
      );
    } else {
      this.vectorIndexSnapshots = this.vectorIndexSnapshots.filter(
        (e) => e.timestamp >= cutoffTimestamp,
      );
    }
    return before - this.vectorIndexSnapshots.length;
  }

  // Connection Management Methods (in-memory storage)
  private connections: Map<string, DatabaseConnectionConfig> = new Map();

  async saveConnection(config: DatabaseConnectionConfig): Promise<void> {
    this.connections.set(config.id, config);
  }

  async getConnections(): Promise<DatabaseConnectionConfig[]> {
    return Array.from(this.connections.values()).sort((a, b) => a.createdAt - b.createdAt);
  }

  async getConnection(id: string): Promise<DatabaseConnectionConfig | null> {
    return this.connections.get(id) || null;
  }

  async deleteConnection(id: string): Promise<void> {
    this.connections.delete(id);
  }

  async updateConnection(id: string, updates: Partial<DatabaseConnectionConfig>): Promise<void> {
    const config = this.connections.get(id);
    if (config) {
      this.connections.set(id, { ...config, ...updates, updatedAt: Date.now() });
    }
  }

  // Agent Token Methods (no-op for non-cloud deployments)

  private agentTokens = new Map<
    string,
    {
      id: string;
      name: string;
      type: 'agent' | 'mcp';
      tokenHash: string;
      createdAt: number;
      expiresAt: number;
      revokedAt: number | null;
      lastUsedAt: number | null;
    }
  >();

  async saveAgentToken(token: {
    id: string;
    name: string;
    type: 'agent' | 'mcp';
    tokenHash: string;
    createdAt: number;
    expiresAt: number;
    revokedAt: number | null;
    lastUsedAt: number | null;
  }): Promise<void> {
    this.agentTokens.set(token.id, token);
  }

  async getAgentTokens(type?: 'agent' | 'mcp'): Promise<
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
  > {
    let tokens = Array.from(this.agentTokens.values());
    if (type) tokens = tokens.filter((t) => t.type === type);
    return tokens.sort((a, b) => b.createdAt - a.createdAt);
  }

  async getAgentTokenByHash(hash: string): Promise<{
    id: string;
    name: string;
    type: 'agent' | 'mcp';
    tokenHash: string;
    createdAt: number;
    expiresAt: number;
    revokedAt: number | null;
    lastUsedAt: number | null;
  } | null> {
    for (const token of this.agentTokens.values()) {
      if (token.tokenHash === hash) return token;
    }
    return null;
  }

  async revokeAgentToken(id: string): Promise<void> {
    const token = this.agentTokens.get(id);
    if (token) {
      token.revokedAt = Date.now();
    }
  }

  async updateAgentTokenLastUsed(id: string): Promise<void> {
    const token = this.agentTokens.get(id);
    if (token) {
      token.lastUsedAt = Date.now();
    }
  }

  // Metric Forecasting Settings

  private metricForecastKey(connectionId: string, metricKind: MetricKind): string {
    return `${connectionId}:${metricKind}`;
  }

  async getMetricForecastSettings(
    connectionId: string,
    metricKind: MetricKind,
  ): Promise<MetricForecastSettings | null> {
    return (
      this.metricForecastSettings.get(this.metricForecastKey(connectionId, metricKind)) ?? null
    );
  }

  async saveMetricForecastSettings(
    settings: MetricForecastSettings,
  ): Promise<MetricForecastSettings> {
    this.metricForecastSettings.set(
      this.metricForecastKey(settings.connectionId, settings.metricKind),
      settings,
    );
    return { ...settings };
  }

  async deleteMetricForecastSettings(
    connectionId: string,
    metricKind: MetricKind,
  ): Promise<boolean> {
    return this.metricForecastSettings.delete(this.metricForecastKey(connectionId, metricKind));
  }

  async getActiveMetricForecastSettings(): Promise<MetricForecastSettings[]> {
    return [...this.metricForecastSettings.values()].filter((s) => s.enabled);
  }

  private cacheProposals: Map<string, StoredCacheProposal> = new Map();
  private cacheProposalAudit: Map<string, StoredCacheProposalAudit> = new Map();
  private memoryProposals: Map<string, StoredMemoryProposal> = new Map();
  private memoryProposalAudit: Map<string, StoredMemoryProposalAudit> = new Map();
  private captureSessions: Map<string, StoredCaptureSession> = new Map();
  private captureChunks: StoredCaptureChunk[] = [];
  private captureTriggers: Map<string, StoredCaptureTrigger> = new Map();
  private scheduledCaptures: Map<string, StoredScheduledCapture> = new Map();


  private cloneProposal(p: StoredCacheProposal): StoredCacheProposal {
    return structuredClone(p);
  }

  private cloneAudit(a: StoredCacheProposalAudit): StoredCacheProposalAudit {
    return structuredClone(a);
  }

  async createCacheProposal(input: CreateCacheProposalInput): Promise<StoredCacheProposal> {
    const subDiscriminator = pendingProposalSubDiscriminator(input);
    if (subDiscriminator !== null) {
      for (const existing of this.cacheProposals.values()) {
        if (
          existing.status === 'pending' &&
          existing.connection_id === input.connection_id &&
          existing.cache_name === input.cache_name &&
          existing.proposal_type === input.proposal_type &&
          pendingProposalSubDiscriminator(existing) === subDiscriminator
        ) {
          throw new Error(
            `UNIQUE constraint failed: cache_proposals (connection_id, cache_name, proposal_type, sub_discriminator) where status='pending'`,
          );
        }
      }
    }
    const proposedAt = input.proposed_at ?? Date.now();
    const expiresAt = input.expires_at ?? proposedAt + PROPOSAL_DEFAULT_EXPIRY_MS;
    const proposal: StoredCacheProposal = structuredClone({
      ...input,
      reasoning: input.reasoning ?? null,
      status: 'pending',
      proposed_by: input.proposed_by ?? null,
      proposed_at: proposedAt,
      reviewed_by: null,
      reviewed_at: null,
      applied_at: null,
      applied_result: null,
      expires_at: expiresAt,
    });
    this.cacheProposals.set(proposal.id, proposal);
    return this.cloneProposal(proposal);
  }

  async getCacheProposal(id: string): Promise<StoredCacheProposal | null> {
    const found = this.cacheProposals.get(id);
    return found ? this.cloneProposal(found) : null;
  }

  async listCacheProposals(options: ListCacheProposalsOptions): Promise<StoredCacheProposal[]> {
    if (Array.isArray(options.status) && options.status.length === 0) {
      return [];
    }

    let filtered = [...this.cacheProposals.values()].filter(
      (p) => p.connection_id === options.connection_id,
    );

    if (options.status !== undefined) {
      const statuses = Array.isArray(options.status) ? options.status : [options.status];
      filtered = filtered.filter((p) => statuses.includes(p.status));
    }
    if (options.cache_name) {
      filtered = filtered.filter((p) => p.cache_name === options.cache_name);
    }
    if (options.cache_type) {
      filtered = filtered.filter((p) => p.cache_type === options.cache_type);
    }
    if (options.proposal_type) {
      filtered = filtered.filter((p) => p.proposal_type === options.proposal_type);
    }

    filtered.sort((a, b) => b.proposed_at - a.proposed_at);
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;
    return filtered.slice(offset, offset + limit).map((p) => this.cloneProposal(p));
  }

  async updateCacheProposalStatus(
    input: UpdateProposalStatusInput,
  ): Promise<StoredCacheProposal | null> {
    const existing = this.cacheProposals.get(input.id);
    if (!existing) {
      return null;
    }
    if (input.expected_status !== undefined) {
      const allowed = Array.isArray(input.expected_status)
        ? input.expected_status
        : [input.expected_status];
      if (allowed.length === 0 || !allowed.includes(existing.status)) {
        return null;
      }
    }
    if (input.proposal_payload !== undefined) {
      const variantSchema = variantPayloadSchemaFor(existing.cache_type, existing.proposal_type);
      variantSchema.parse(input.proposal_payload);
    }
    const updated = structuredClone(existing);
    updated.status = input.status;
    if (input.reviewed_by !== undefined) {
      updated.reviewed_by = input.reviewed_by;
    }
    if (input.reviewed_at !== undefined) {
      updated.reviewed_at = input.reviewed_at;
    }
    if (input.applied_at !== undefined) {
      updated.applied_at = input.applied_at;
    }
    if (input.applied_result !== undefined) {
      updated.applied_result =
        input.applied_result === null ? null : structuredClone(input.applied_result);
    }
    if (input.proposal_payload !== undefined) {
      (updated as { proposal_payload: typeof input.proposal_payload }).proposal_payload =
        structuredClone(input.proposal_payload);
    }
    this.cacheProposals.set(input.id, updated);
    return this.cloneProposal(updated);
  }

  async expireCacheProposalsBefore(now: number): Promise<StoredCacheProposal[]> {
    const expired: StoredCacheProposal[] = [];
    for (const proposal of this.cacheProposals.values()) {
      if (proposal.status === 'pending' && proposal.expires_at <= now) {
        const updated = structuredClone({ ...proposal, status: 'expired' }) as StoredCacheProposal;
        this.cacheProposals.set(proposal.id, updated);
        expired.push(this.cloneProposal(updated));
      }
    }
    return expired;
  }

  async appendCacheProposalAudit(
    input: AppendProposalAuditInput,
  ): Promise<StoredCacheProposalAudit> {
    const audit: StoredCacheProposalAudit = structuredClone({
      id: input.id,
      proposal_id: input.proposal_id,
      event_type: input.event_type,
      event_payload: input.event_payload ?? null,
      event_at: input.event_at ?? Date.now(),
      actor: input.actor ?? null,
      actor_source: input.actor_source,
    });
    this.cacheProposalAudit.set(audit.id, audit);
    return this.cloneAudit(audit);
  }

  async getCacheProposalAudit(proposalId: string): Promise<StoredCacheProposalAudit[]> {
    return [...this.cacheProposalAudit.values()]
      .filter((a) => a.proposal_id === proposalId)
      .sort((a, b) => a.event_at - b.event_at)
      .map((a) => this.cloneAudit(a));
  }

  async createMemoryProposal(input: CreateMemoryProposalInput): Promise<StoredMemoryProposal> {
    const discriminator = memoryProposalTargetDiscriminator(input.proposal_payload);
    for (const existing of this.memoryProposals.values()) {
      if (
        existing.status === 'pending' &&
        existing.connection_id === input.connection_id &&
        existing.store_name === input.store_name &&
        memoryProposalTargetDiscriminator(existing.proposal_payload) === discriminator
      ) {
        throw new Error(
          `UNIQUE constraint failed: memory_proposals (connection_id, store_name, target) where status='pending'`,
        );
      }
    }
    const proposedAt = input.proposed_at ?? Date.now();
    const expiresAt = input.expires_at ?? proposedAt + MEMORY_PROPOSAL_DEFAULT_EXPIRY_MS;
    const proposal: StoredMemoryProposal = structuredClone({
      ...input,
      reasoning: input.reasoning ?? null,
      status: 'pending',
      proposed_by: input.proposed_by ?? null,
      proposed_at: proposedAt,
      reviewed_by: null,
      reviewed_at: null,
      applied_at: null,
      applied_result: null,
      expires_at: expiresAt,
    });
    this.memoryProposals.set(proposal.id, proposal);
    return structuredClone(proposal);
  }

  async getMemoryProposal(id: string): Promise<StoredMemoryProposal | null> {
    const found = this.memoryProposals.get(id);
    return found ? structuredClone(found) : null;
  }

  async listMemoryProposals(options: ListMemoryProposalsOptions): Promise<StoredMemoryProposal[]> {
    if (Array.isArray(options.status) && options.status.length === 0) {
      return [];
    }
    let filtered = [...this.memoryProposals.values()].filter(
      (p) => p.connection_id === options.connection_id,
    );
    if (options.status !== undefined) {
      const statuses = Array.isArray(options.status) ? options.status : [options.status];
      filtered = filtered.filter((p) => statuses.includes(p.status));
    }
    if (options.store_name) {
      filtered = filtered.filter((p) => p.store_name === options.store_name);
    }
    filtered.sort((a, b) => b.proposed_at - a.proposed_at);
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;
    return filtered.slice(offset, offset + limit).map((p) => structuredClone(p));
  }

  async updateMemoryProposalStatus(
    input: UpdateMemoryProposalStatusInput,
  ): Promise<StoredMemoryProposal | null> {
    const existing = this.memoryProposals.get(input.id);
    if (!existing) {
      return null;
    }
    if (input.expected_status !== undefined) {
      const allowed = Array.isArray(input.expected_status)
        ? input.expected_status
        : [input.expected_status];
      if (allowed.length === 0 || !allowed.includes(existing.status)) {
        return null;
      }
    }
    const updated = structuredClone(existing);
    updated.status = input.status;
    if (input.reviewed_by !== undefined) {
      updated.reviewed_by = input.reviewed_by;
    }
    if (input.reviewed_at !== undefined) {
      updated.reviewed_at = input.reviewed_at;
    }
    if (input.applied_at !== undefined) {
      updated.applied_at = input.applied_at;
    }
    if (input.applied_result !== undefined) {
      updated.applied_result =
        input.applied_result === null ? null : structuredClone(input.applied_result);
    }
    if (input.proposal_payload !== undefined) {
      updated.proposal_payload = structuredClone(input.proposal_payload);
    }
    this.memoryProposals.set(input.id, updated);
    return structuredClone(updated);
  }

  async appendMemoryProposalAudit(
    input: AppendMemoryProposalAuditInput,
  ): Promise<StoredMemoryProposalAudit> {
    const audit: StoredMemoryProposalAudit = structuredClone({
      id: input.id,
      proposal_id: input.proposal_id,
      event_type: input.event_type,
      event_payload: input.event_payload ?? null,
      event_at: input.event_at ?? Date.now(),
      actor: input.actor ?? null,
      actor_source: input.actor_source,
    });
    this.memoryProposalAudit.set(audit.id, audit);
    return structuredClone(audit);
  }

  async getMemoryProposalAudit(proposalId: string): Promise<StoredMemoryProposalAudit[]> {
    return [...this.memoryProposalAudit.values()]
      .filter((a) => a.proposal_id === proposalId)
      .sort((a, b) => a.event_at - b.event_at)
      .map((a) => structuredClone(a));
  }

  async expireMemoryProposalsBefore(now: number): Promise<StoredMemoryProposal[]> {
    const expired: StoredMemoryProposal[] = [];
    for (const proposal of this.memoryProposals.values()) {
      if (proposal.status === 'pending' && proposal.expires_at <= now) {
        const updated = structuredClone({ ...proposal, status: 'expired' as const });
        this.memoryProposals.set(proposal.id, updated);
        expired.push(structuredClone(updated));
      }
    }
    return expired;
  }

  async failStaleApplyingMemoryProposalsBefore(now: number): Promise<StoredMemoryProposal[]> {
    const failed: StoredMemoryProposal[] = [];
    for (const proposal of this.memoryProposals.values()) {
      if (
        proposal.status === 'applying' &&
        proposal.reviewed_at !== null &&
        proposal.reviewed_at <= now
      ) {
        const updated = structuredClone({
          ...proposal,
          status: 'failed' as const,
          applied_at: now,
          applied_result: {
            success: false,
            error: 'stale_apply',
            details: { reviewed_at: proposal.reviewed_at },
          },
        });
        this.memoryProposals.set(proposal.id, updated);
        failed.push(structuredClone(updated));
      }
    }
    return failed;
  }

  async saveCaptureSession(
    session: StoredCaptureSession,
    connectionId: string,
  ): Promise<string> {
    this.captureSessions.set(session.id, { ...session, connectionId });
    return session.id;
  }

  async getCaptureSession(id: string): Promise<StoredCaptureSession | null> {
    const session = this.captureSessions.get(id);
    return session ? { ...session } : null;
  }

  async updateCaptureSession(id: string, patch: CaptureSessionPatch): Promise<boolean> {
    const session = this.captureSessions.get(id);
    if (!session) return false;
    if (patch.status !== undefined) session.status = patch.status;
    if (patch.endedAt !== undefined) session.endedAt = patch.endedAt;
    if (patch.durationMs !== undefined) session.durationMs = patch.durationMs;
    if (patch.byteCount !== undefined) session.byteCount = patch.byteCount;
    if (patch.lineCount !== undefined) session.lineCount = patch.lineCount;
    if (patch.terminationReason !== undefined) session.terminationReason = patch.terminationReason;
    if (patch.nodeSegments !== undefined) session.nodeSegments = patch.nodeSegments;
    return true;
  }

  async saveCaptureChunk(chunk: StoredCaptureChunk): Promise<number> {
    this.captureChunks.push({ ...chunk, bytes: Buffer.from(chunk.bytes) });
    return 1;
  }

  async getCaptureChunks(sessionId: string): Promise<StoredCaptureChunk[]> {
    return this.captureChunks
      .filter((c) => c.sessionId === sessionId)
      .sort((a, b) => a.chunkIndex - b.chunkIndex)
      .map((c) => ({ ...c, bytes: Buffer.from(c.bytes) }));
  }

  async getCaptureSessions(
    options: CaptureSessionQueryOptions = {},
  ): Promise<StoredCaptureSession[]> {
    let sessions = [...this.captureSessions.values()];

    if (options.connectionId) {
      sessions = sessions.filter((s) => s.connectionId === options.connectionId);
    }
    if (options.status) {
      sessions = sessions.filter((s) => s.status === options.status);
    }
    if (options.source) {
      sessions = sessions.filter((s) => s.source === options.source);
    }
    if (options.startedAfter !== undefined) {
      sessions = sessions.filter((s) => s.startedAt >= options.startedAfter!);
    }
    if (options.startedBefore !== undefined) {
      sessions = sessions.filter((s) => s.startedAt <= options.startedBefore!);
    }

    sessions.sort((a, b) => b.startedAt - a.startedAt);

    const offset = options.offset ?? 0;
    const limit = options.limit ?? 100;
    return sessions.slice(offset, offset + limit).map((s) => ({ ...s }));
  }

  async saveCaptureTrigger(trigger: StoredCaptureTrigger): Promise<string> {
    this.captureTriggers.set(trigger.id, { ...trigger });
    return trigger.id;
  }

  async updateCaptureTrigger(id: string, patch: CaptureTriggerPatch): Promise<boolean> {
    const existing = this.captureTriggers.get(id);
    if (!existing) {
      return false;
    }
    this.captureTriggers.set(id, { ...existing, ...patch });
    return true;
  }

  async getCaptureTrigger(id: string): Promise<StoredCaptureTrigger | null> {
    const trigger = this.captureTriggers.get(id);
    return trigger ? { ...trigger } : null;
  }

  async getCaptureTriggers(
    options: CaptureTriggerQueryOptions = {},
  ): Promise<StoredCaptureTrigger[]> {
    let triggers = [...this.captureTriggers.values()];
    if (options.connectionId) {
      triggers = triggers.filter((t) => t.connectionId === options.connectionId);
    }
    if (options.status) {
      triggers = triggers.filter((t) => t.status === options.status);
    }
    triggers.sort((a, b) => b.createdAt - a.createdAt);
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 100;
    return triggers.slice(offset, offset + limit).map((t) => ({ ...t }));
  }

  async saveScheduledCapture(schedule: StoredScheduledCapture): Promise<string> {
    this.scheduledCaptures.set(schedule.id, { ...schedule });
    return schedule.id;
  }

  async updateScheduledCapture(id: string, patch: ScheduledCapturePatch): Promise<boolean> {
    const existing = this.scheduledCaptures.get(id);
    if (!existing) {
      return false;
    }
    this.scheduledCaptures.set(id, { ...existing, ...patch });
    return true;
  }

  async deleteScheduledCapture(id: string): Promise<boolean> {
    return this.scheduledCaptures.delete(id);
  }

  async getScheduledCapture(id: string): Promise<StoredScheduledCapture | null> {
    const schedule = this.scheduledCaptures.get(id);
    return schedule ? { ...schedule } : null;
  }

  async getScheduledCaptures(
    options: ScheduledCaptureQueryOptions = {},
  ): Promise<StoredScheduledCapture[]> {
    let schedules = [...this.scheduledCaptures.values()];
    if (options.connectionId) {
      schedules = schedules.filter((s) => s.connectionId === options.connectionId);
    }
    if (options.status) {
      schedules = schedules.filter((s) => s.status === options.status);
    }
    schedules.sort((a, b) => b.createdAt - a.createdAt);
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 100;
    return schedules.slice(offset, offset + limit).map((s) => ({ ...s }));
  }

  async pruneOldCaptureSessions(cutoffTimestamp: number): Promise<number> {
    let pruned = 0;
    for (const [id, session] of this.captureSessions) {
      if (
        session.endedAt !== undefined &&
        session.endedAt < cutoffTimestamp &&
        session.status !== 'running'
      ) {
        this.captureSessions.delete(id);
        pruned++;
      }
    }
    return pruned;
  }

  async pruneOldCaptureChunks(cutoffTimestamp: number): Promise<number> {
    const initial = this.captureChunks.length;
    this.captureChunks = this.captureChunks.filter((c) => c.lastTs >= cutoffTimestamp);
    return initial - this.captureChunks.length;
  }

  async pruneOldCaptureTriggers(cutoffTimestamp: number): Promise<number> {
    const terminal = new Set(['fired', 'skipped', 'expired', 'cancelled']);
    let pruned = 0;
    for (const [id, trigger] of this.captureTriggers) {
      if (trigger.createdAt < cutoffTimestamp && terminal.has(trigger.status)) {
        this.captureTriggers.delete(id);
        pruned++;
      }
    }
    return pruned;
  }

  async pruneOldScheduledCaptures(cutoffTimestamp: number): Promise<number> {
    let pruned = 0;
    for (const [id, schedule] of this.scheduledCaptures) {
      if (schedule.createdAt < cutoffTimestamp && schedule.status === 'disabled') {
        this.scheduledCaptures.delete(id);
        pruned++;
      }
    }
    return pruned;
  }
}
