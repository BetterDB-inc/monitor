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
} from '../../common/interfaces/storage-port.interface';

export class MemoryAdapter implements StoragePort {
  private aclEntries: StoredAclEntry[] = [];
  private clientSnapshots: StoredClientSnapshot[] = [];
  private anomalyEvents: StoredAnomalyEvent[] = [];
  private correlatedGroups: StoredCorrelatedGroup[] = [];
  private settings: AppSettings | null = null;
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

  async saveAclEntries(entries: StoredAclEntry[]): Promise<number> {
    for (const entry of entries) {
      // Check for duplicates based on unique constraint
      const existingIndex = this.aclEntries.findIndex(
        (e) =>
          e.timestampCreated === entry.timestampCreated &&
          e.username === entry.username &&
          e.object === entry.object &&
          e.reason === entry.reason &&
          e.sourceHost === entry.sourceHost &&
          e.sourcePort === entry.sourcePort,
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
        // Add new entry
        this.aclEntries.push({ ...entry, id: this.idCounter++ });
      }
    }
    return entries.length;
  }

  async getAclEntries(options: AuditQueryOptions = {}): Promise<StoredAclEntry[]> {
    let filtered = [...this.aclEntries];

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

  async getAuditStats(startTime?: number, endTime?: number): Promise<AuditStats> {
    let filtered = [...this.aclEntries];

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

  async pruneOldEntries(olderThanTimestamp: number): Promise<number> {
    const before = this.aclEntries.length;
    this.aclEntries = this.aclEntries.filter((e) => e.capturedAt >= olderThanTimestamp);
    return before - this.aclEntries.length;
  }

  async saveClientSnapshot(clients: StoredClientSnapshot[]): Promise<number> {
    for (const client of clients) {
      this.clientSnapshots.push({ ...client, id: this.idCounter++ });
    }
    return clients.length;
  }

  async getClientSnapshots(options: ClientSnapshotQueryOptions = {}): Promise<StoredClientSnapshot[]> {
    let filtered = [...this.clientSnapshots];

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
  ): Promise<ClientTimeSeriesPoint[]> {
    const filtered = this.clientSnapshots.filter(
      (c) => c.capturedAt >= startTime && c.capturedAt <= endTime,
    );

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

  async getClientAnalyticsStats(startTime?: number, endTime?: number): Promise<ClientAnalyticsStats> {
    let filtered = [...this.clientSnapshots];

    if (startTime) {
      filtered = filtered.filter((c) => c.capturedAt >= startTime);
    }

    if (endTime) {
      filtered = filtered.filter((c) => c.capturedAt <= endTime);
    }

    const latestTimestamp = filtered.length > 0 ? Math.max(...filtered.map((c) => c.capturedAt)) : 0;
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
        byTimestampForName.set(client.capturedAt, (byTimestampForName.get(client.capturedAt) || 0) + 1);
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
        byTimestampForUser.set(client.capturedAt, (byTimestampForUser.get(client.capturedAt) || 0) + 1);
      }
      const peakForUser = Math.max(...Array.from(byTimestampForUser.values()));

      connectionsByUser[user] = {
        current: currentCount,
        peak: peakForUser,
      };
    }

    // Connections by user and name
    const connectionsByUserAndName: Record<string, { user: string; name: string; current: number; peak: number; avgAge: number }> = {};
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
        byTimestampForCombined.set(client.capturedAt, (byTimestampForCombined.get(client.capturedAt) || 0) + 1);
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
  ): Promise<StoredClientSnapshot[]> {
    let filtered = [...this.clientSnapshots];

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

  async pruneOldClientSnapshots(olderThanTimestamp: number): Promise<number> {
    const before = this.clientSnapshots.length;
    this.clientSnapshots = this.clientSnapshots.filter((c) => c.capturedAt >= olderThanTimestamp);
    return before - this.clientSnapshots.length;
  }

  async saveAnomalyEvent(event: StoredAnomalyEvent): Promise<string> {
    this.anomalyEvents.push(event);
    return event.id;
  }

  async saveAnomalyEvents(events: StoredAnomalyEvent[]): Promise<number> {
    this.anomalyEvents.push(...events);
    return events.length;
  }

  async getAnomalyEvents(options: AnomalyQueryOptions = {}): Promise<StoredAnomalyEvent[]> {
    let filtered = [...this.anomalyEvents];

    if (options.startTime) filtered = filtered.filter(e => e.timestamp >= options.startTime!);
    if (options.endTime) filtered = filtered.filter(e => e.timestamp <= options.endTime!);
    if (options.severity) filtered = filtered.filter(e => e.severity === options.severity);
    if (options.metricType) filtered = filtered.filter(e => e.metricType === options.metricType);
    if (options.resolved !== undefined) filtered = filtered.filter(e => e.resolved === options.resolved);

    return filtered
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? 100));
  }

  async getAnomalyStats(startTime?: number, endTime?: number): Promise<AnomalyStats> {
    let filtered = [...this.anomalyEvents];
    if (startTime) filtered = filtered.filter(e => e.timestamp >= startTime);
    if (endTime) filtered = filtered.filter(e => e.timestamp <= endTime);

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
      unresolvedCount: filtered.filter(e => !e.resolved).length,
    };
  }

  async resolveAnomaly(id: string, resolvedAt: number): Promise<boolean> {
    const event = this.anomalyEvents.find(e => e.id === id);
    if (event && !event.resolved) {
      event.resolved = true;
      event.resolvedAt = resolvedAt;
      event.durationMs = resolvedAt - event.timestamp;
      return true;
    }
    return false;
  }

  async pruneOldAnomalyEvents(cutoffTimestamp: number): Promise<number> {
    const before = this.anomalyEvents.length;
    this.anomalyEvents = this.anomalyEvents.filter(e => e.timestamp >= cutoffTimestamp);
    return before - this.anomalyEvents.length;
  }

  async saveCorrelatedGroup(group: StoredCorrelatedGroup): Promise<string> {
    const existing = this.correlatedGroups.findIndex(g => g.correlationId === group.correlationId);
    if (existing >= 0) {
      this.correlatedGroups[existing] = group;
    } else {
      this.correlatedGroups.push(group);
    }
    return group.correlationId;
  }

  async getCorrelatedGroups(options: AnomalyQueryOptions = {}): Promise<StoredCorrelatedGroup[]> {
    let filtered = [...this.correlatedGroups];

    if (options.startTime) filtered = filtered.filter(g => g.timestamp >= options.startTime!);
    if (options.endTime) filtered = filtered.filter(g => g.timestamp <= options.endTime!);
    if (options.severity) filtered = filtered.filter(g => g.severity === options.severity);
    if (options.pattern) filtered = filtered.filter(g => g.pattern === options.pattern);

    return filtered
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? 50));
  }

  async pruneOldCorrelatedGroups(cutoffTimestamp: number): Promise<number> {
    const before = this.correlatedGroups.length;
    this.correlatedGroups = this.correlatedGroups.filter(g => g.timestamp >= cutoffTimestamp);
    return before - this.correlatedGroups.length;
  }

  async saveKeyPatternSnapshots(_snapshots: KeyPatternSnapshot[]): Promise<number> {
    throw new Error('Key analytics not supported in memory adapter');
  }

  async getKeyPatternSnapshots(_options?: KeyPatternQueryOptions): Promise<KeyPatternSnapshot[]> {
    throw new Error('Key analytics not supported in memory adapter');
  }

  async getKeyAnalyticsSummary(_startTime?: number, _endTime?: number): Promise<KeyAnalyticsSummary | null> {
    throw new Error('Key analytics not supported in memory adapter');
  }

  async getKeyPatternTrends(_pattern: string, _startTime: number, _endTime: number): Promise<Array<{
    timestamp: number;
    keyCount: number;
    memoryBytes: number;
    staleCount: number;
  }>> {
    throw new Error('Key analytics not supported in memory adapter');
  }

  async pruneOldKeyPatternSnapshots(_cutoffTimestamp: number): Promise<number> {
    throw new Error('Key analytics not supported in memory adapter');
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

    this.settings = {
      ...this.settings,
      ...validUpdates,
      updatedAt: Date.now(),
    };
    return { ...this.settings };
  }
}
