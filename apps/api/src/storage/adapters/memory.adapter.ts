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
  UpdateProposalStatusInput,
  AppendProposalAuditInput,
} from '@betterdb/shared';
import { PROPOSAL_DEFAULT_EXPIRY_MS, variantPayloadSchemaFor } from '@betterdb/shared';

export class MemoryAdapter implements StoragePort {
  private aclEntries: StoredAclEntry[] = [];
  private clientSnapshots: StoredClientSnapshot[] = [];
  private anomalyEvents: StoredAnomalyEvent[] = [];
  private correlatedGroups: StoredCorrelatedGroup[] = [];
  private slowLogEntries: StoredSlowLogEntry[] = [];
  private commandLogEntries: StoredCommandLogEntry[] = [];
  private latencySnapshots: StoredLatencySnapshot[] = [];
  private latencyHistograms: StoredLatencyHistogram[] = [];
  private memorySnapshots: StoredMemorySnapshot[] = [];
  private vectorIndexSnapshots: VectorIndexSnapshot[] = [];
  private metricForecastSettings: Map<string, MetricForecastSettings> = new Map();
  private settings: AppSettings | null = null;
  private webhooks: Map<string, Webhook> = new Map();
  private deliveries: Map<string, WebhookDelivery> = new Map();
  private idCounter = 1;
  private ready: boolean = false;
  private readonly MAX_DELIVERIES_PER_WEBHOOK = 1000;

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
    if (event && !event.resolved) {
      event.resolved = true;
      event.resolvedAt = resolvedAt;
      event.durationMs = resolvedAt - event.timestamp;
      return true;
    }
    return false;
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

    this.settings = {
      ...this.settings,
      ...validUpdates,
      updatedAt: Date.now(),
    };
    return { ...this.settings };
  }

  async createWebhook(webhook: Omit<Webhook, 'id' | 'createdAt' | 'updatedAt'>): Promise<Webhook> {
    const id = randomUUID();
    const now = Date.now();
    const newWebhook: Webhook = {
      id,
      ...webhook,
      createdAt: now,
      updatedAt: now,
    };
    this.webhooks.set(id, newWebhook);
    return { ...newWebhook };
  }

  async getWebhook(id: string): Promise<Webhook | null> {
    const webhook = this.webhooks.get(id);
    return webhook ? { ...webhook } : null;
  }

  async getWebhooksByInstance(connectionId?: string): Promise<Webhook[]> {
    let webhooks = Array.from(this.webhooks.values());
    if (connectionId) {
      webhooks = webhooks.filter((w) => w.connectionId === connectionId || !w.connectionId);
    } else {
      // No connectionId provided - only return global webhooks (not scoped to any connection)
      webhooks = webhooks.filter((w) => !w.connectionId);
    }
    return webhooks.sort((a, b) => b.createdAt - a.createdAt).map((w) => ({ ...w }));
  }

  async getWebhooksByEvent(event: WebhookEventType, connectionId?: string): Promise<Webhook[]> {
    let webhooks = Array.from(this.webhooks.values()).filter(
      (w) => w.enabled && w.events.includes(event),
    );
    if (connectionId) {
      // Return webhooks scoped to this connection OR global webhooks (no connectionId)
      webhooks = webhooks.filter((w) => w.connectionId === connectionId || !w.connectionId);
    } else {
      // No connectionId provided - only return global webhooks (not scoped to any connection)
      webhooks = webhooks.filter((w) => !w.connectionId);
    }
    return webhooks.map((w) => ({ ...w }));
  }

  async updateWebhook(
    id: string,
    updates: Partial<Omit<Webhook, 'id' | 'createdAt' | 'updatedAt'>>,
  ): Promise<Webhook | null> {
    const webhook = this.webhooks.get(id);
    if (!webhook) return null;

    // Filter out undefined values to prevent overwriting existing fields
    const definedUpdates = Object.fromEntries(
      Object.entries(updates).filter(([_, value]) => value !== undefined),
    );

    const updated: Webhook = {
      ...webhook,
      ...definedUpdates,
      id,
      createdAt: webhook.createdAt,
      updatedAt: Date.now(),
    };
    this.webhooks.set(id, updated);
    return { ...updated };
  }

  async deleteWebhook(id: string): Promise<boolean> {
    const deleted = this.webhooks.delete(id);
    if (deleted) {
      const deliveriesToDelete = Array.from(this.deliveries.entries())
        .filter(([_, d]) => d.webhookId === id)
        .map(([id]) => id);
      deliveriesToDelete.forEach((deliveryId) => this.deliveries.delete(deliveryId));
    }
    return deleted;
  }

  async createDelivery(
    delivery: Omit<WebhookDelivery, 'id' | 'createdAt'>,
  ): Promise<WebhookDelivery> {
    const now = Date.now();
    const id = randomUUID();
    const newDelivery: WebhookDelivery = {
      id,
      ...delivery,
      createdAt: now,
    };
    this.deliveries.set(id, newDelivery);

    const webhookDeliveries = Array.from(this.deliveries.values())
      .filter((d) => d.webhookId === delivery.webhookId)
      .sort((a, b) => b.createdAt - a.createdAt);

    if (webhookDeliveries.length > this.MAX_DELIVERIES_PER_WEBHOOK) {
      const toDelete = webhookDeliveries.slice(this.MAX_DELIVERIES_PER_WEBHOOK);
      toDelete.forEach((d) => this.deliveries.delete(d.id));
    }

    return { ...newDelivery };
  }

  async getDelivery(id: string): Promise<WebhookDelivery | null> {
    const delivery = this.deliveries.get(id);
    return delivery ? { ...delivery } : null;
  }

  async getDeliveriesByWebhook(
    webhookId: string,
    limit: number = 50,
    offset: number = 0,
  ): Promise<WebhookDelivery[]> {
    return Array.from(this.deliveries.values())
      .filter((d) => d.webhookId === webhookId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(offset, offset + limit)
      .map((d) => ({ ...d }));
  }

  async updateDelivery(
    id: string,
    updates: Partial<Omit<WebhookDelivery, 'id' | 'webhookId' | 'createdAt'>>,
  ): Promise<boolean> {
    const delivery = this.deliveries.get(id);
    if (!delivery) return false;

    const updated: WebhookDelivery = {
      ...delivery,
      ...updates,
      id,
      webhookId: delivery.webhookId,
      createdAt: delivery.createdAt,
    };
    this.deliveries.set(id, updated);
    return true;
  }

  async getRetriableDeliveries(
    limit: number = 100,
    connectionId?: string,
  ): Promise<WebhookDelivery[]> {
    const now = Date.now();
    let deliveries = Array.from(this.deliveries.values()).filter(
      (d) => d.status === 'retrying' && d.nextRetryAt && d.nextRetryAt <= now,
    );
    if (connectionId) {
      deliveries = deliveries.filter((d) => d.connectionId === connectionId);
    }
    return deliveries
      .sort((a, b) => (a.nextRetryAt || 0) - (b.nextRetryAt || 0))
      .slice(0, limit)
      .map((d) => ({ ...d }));
  }

  async pruneOldDeliveries(cutoffTimestamp: number, connectionId?: string): Promise<number> {
    const before = this.deliveries.size;
    Array.from(this.deliveries.entries())
      .filter(
        ([_, d]) =>
          d.createdAt < cutoffTimestamp && (!connectionId || d.connectionId === connectionId),
      )
      .forEach(([id]) => this.deliveries.delete(id));
    return before - this.deliveries.size;
  }

  // Slow Log Methods
  async saveSlowLogEntries(entries: StoredSlowLogEntry[], connectionId: string): Promise<number> {
    let savedCount = 0;
    for (const entry of entries) {
      // Check for duplicates based on unique constraint (including connectionId)
      const exists = this.slowLogEntries.some(
        (e) =>
          e.id === entry.id &&
          e.sourceHost === entry.sourceHost &&
          e.sourcePort === entry.sourcePort &&
          e.connectionId === connectionId,
      );
      if (!exists) {
        this.slowLogEntries.push({ ...entry, connectionId });
        savedCount++;
      }
    }
    return savedCount;
  }

  async getSlowLogEntries(options: SlowLogQueryOptions = {}): Promise<StoredSlowLogEntry[]> {
    let filtered = [...this.slowLogEntries];

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
      // command is an array, check if the first element (command name) matches
      filtered = filtered.filter((e) => e.command[0]?.toLowerCase().includes(cmd));
    }
    if (options.clientName) {
      const name = options.clientName.toLowerCase();
      filtered = filtered.filter((e) => e.clientName.toLowerCase().includes(name));
    }
    if (options.minDuration) {
      filtered = filtered.filter((e) => e.duration >= options.minDuration!);
    }

    return filtered
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? 100));
  }

  async getLatestSlowLogId(connectionId?: string): Promise<number | null> {
    let entries = this.slowLogEntries;
    if (connectionId) {
      entries = entries.filter((e) => e.connectionId === connectionId);
    }
    if (entries.length === 0) return null;
    return Math.max(...entries.map((e) => e.id));
  }

  async pruneOldSlowLogEntries(cutoffTimestamp: number, connectionId?: string): Promise<number> {
    const before = this.slowLogEntries.length;
    if (connectionId) {
      this.slowLogEntries = this.slowLogEntries.filter(
        (e) => e.capturedAt >= cutoffTimestamp || e.connectionId !== connectionId,
      );
    } else {
      this.slowLogEntries = this.slowLogEntries.filter((e) => e.capturedAt >= cutoffTimestamp);
    }
    return before - this.slowLogEntries.length;
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

    return filtered
      .sort((a, b) => b.timestamp - a.timestamp)
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

  private cloneProposal(p: StoredCacheProposal): StoredCacheProposal {
    return structuredClone(p);
  }

  private cloneAudit(a: StoredCacheProposalAudit): StoredCacheProposalAudit {
    return structuredClone(a);
  }

  async createCacheProposal(input: CreateCacheProposalInput): Promise<StoredCacheProposal> {
    for (const existing of this.cacheProposals.values()) {
      if (
        existing.status === 'pending' &&
        existing.connection_id === input.connection_id &&
        existing.cache_name === input.cache_name &&
        existing.proposal_type === input.proposal_type
      ) {
        throw new Error(
          `UNIQUE constraint failed: cache_proposals.connection_id, cache_proposals.cache_name, cache_proposals.proposal_type (status='pending')`,
        );
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
        const updated = { ...proposal, status: 'expired' } as StoredCacheProposal;
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
}
