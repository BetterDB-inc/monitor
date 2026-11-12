import { Injectable, Inject, OnModuleInit, Logger } from '@nestjs/common';
import { SlowLogEntry } from '../common/interfaces/database-port.interface';
import {
  StoragePort,
  StoredSlowLogEntry,
  SlowLogQueryOptions,
} from '../common/interfaces/storage-port.interface';
import { SettingsService } from '../settings/settings.service';
import { SlowLogPatternAnalysis } from '../common/types/metrics.types';
import { analyzeSlowLogPatterns } from '../metrics/slowlog-analyzer';
import {
  MultiConnectionPoller,
  ConnectionContext,
  describeLogSource,
  LogSourceTracker,
} from '../common/services/multi-connection-poller';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { isBetterDbClientName } from '../common/utils/own-clients';
import { RuntimeCapabilityTracker } from '../connections/runtime-capability-tracker.service';
import { LogGapTracker, SLOWLOG_CAPTURE } from '../common/services/log-gap-tracker';

function csvList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

@Injectable()
export class SlowLogAnalyticsService extends MultiConnectionPoller implements OnModuleInit {
  protected readonly logger = new Logger(SlowLogAnalyticsService.name);

  // Per-connection state tracking
  private lastSeenIds = new Map<string, number | null>();
  // New slowlog entries that anomaly detection should count. Own clients and
  // the configured prefixes/commands are stored, but they do not move this.
  // Entries logged but never read are estimated from the gap tracker's count.
  // Reset wherever lastSeenIds is deleted: a moved log source, or a removed
  // connection. Absent means this connection has not completed a poll yet.
  private externalEntryCounts = new Map<string, number>();
  private readonly ignoreOwnClients: boolean;
  private readonly ignoreClientPrefixes: readonly string[];
  private readonly ignoreCommands: ReadonlySet<string>;
  // Server process each connection's lastSeenId belongs to. Slowlog IDs are per
  // process, so when a connection lands on another one the tracker restarts
  // from that process's own last stored ID.
  private readonly logSources: LogSourceTracker;
  private readonly gaps = new LogGapTracker();

  // Per-connection cache for Prometheus metrics
  private cachedEntries = new Map<string, SlowLogEntry[]>();
  private cachedAnalysis = new Map<string, SlowLogPatternAnalysis | null>();
  private lastCacheUpdate = new Map<string, number>();

  // Poll every 30 seconds by default
  private readonly DEFAULT_POLL_INTERVAL_MS = 30000;

  constructor(
    connectionRegistry: ConnectionRegistry,
    @Inject('STORAGE_CLIENT') private storage: StoragePort,
    private settingsService: SettingsService,
    private readonly runtimeCapabilityTracker: RuntimeCapabilityTracker,
  ) {
    super(connectionRegistry);
    this.logSources = new LogSourceTracker((id) => this.storage.hasRunIdLogEntries(id));
    // Read once. A per-workspace setting can come later if someone asks for it.
    this.ignoreOwnClients = (process.env.ANOMALY_SLOWLOG_IGNORE_OWN_CLIENTS ?? 'true') !== 'false';
    this.ignoreClientPrefixes = csvList(process.env.ANOMALY_SLOWLOG_IGNORE_CLIENT_PREFIXES);
    this.ignoreCommands = new Set(
      csvList(process.env.ANOMALY_SLOWLOG_IGNORE_COMMANDS).map((command) => command.toLowerCase()),
    );
  }

  protected getIntervalMs(): number {
    return this.DEFAULT_POLL_INTERVAL_MS;
  }

  async onModuleInit(): Promise<void> {
    this.logger.log(`Starting slow log analytics polling (interval: ${this.getIntervalMs()}ms)`);
    this.start();
  }

  protected async pollConnection(ctx: ConnectionContext): Promise<void> {
    if (!this.runtimeCapabilityTracker.isAvailable(ctx.connectionId, 'canSlowLog')) {
      return;
    }

    try {
      const read = await this.logSources.read(ctx);
      if (!read) {
        this.logger.debug(`Slow log source for ${ctx.connectionName} is unknown; skipping this poll`);
        return;
      }
      const { source } = read;
      const moved = this.logSources.track(ctx.connectionId, read);
      if (moved.changed) {
        if (moved.previous !== undefined) {
          this.logger.log(
            `Slow log source for ${ctx.connectionName} moved from ${moved.previous} to ${describeLogSource(source)}`,
          );
        }
        this.lastSeenIds.delete(ctx.connectionId);
        this.gaps.sourceChanged(ctx.connectionId);
        this.externalEntryCounts.delete(ctx.connectionId);
      }

      // Initialize lastSeenId from storage if not already set
      if (!this.lastSeenIds.has(ctx.connectionId)) {
        const lastId = await this.storage.getLatestSlowLogId(ctx.connectionId, source);
        this.lastSeenIds.set(ctx.connectionId, lastId);
        this.logger.debug(`Initialized lastSeenId for ${ctx.connectionName}: ${lastId}`);
      }

      // Fetch slow log from Valkey/Redis (up to 128 entries)
      const entries = await ctx.client.getSlowLog(128);
      // A reconnect during the awaits above moves the socket to another
      // process; its entries must not be stored under this source.
      if (!(await this.logSources.unchanged(ctx, read))) {
        this.logger.debug(`Slow log source for ${ctx.connectionName} changed during the read; skipping this poll`);
        return;
      }
      const now = Date.now();
      const lastSeenId = this.lastSeenIds.get(ctx.connectionId) ?? null;

      // Update cache for Prometheus metrics
      this.cachedEntries.set(ctx.connectionId, entries);
      this.cachedAnalysis.set(ctx.connectionId, analyzeSlowLogPatterns(entries));
      this.lastCacheUpdate.set(ctx.connectionId, now);

      if (this.gaps.idsRestarted(ctx.connectionId, SLOWLOG_CAPTURE, entries, lastSeenId)) {
        const maxIdInBatch = Math.max(...entries.map(e => e.id));
        this.logger.warn(
          `Slowlog ID wraparound detected for ${ctx.connectionName} (lastSeenId: ${lastSeenId}, maxIdInBatch: ${maxIdInBatch}). Resetting tracker.`
        );
        this.lastSeenIds.set(ctx.connectionId, null);
      }

      // Filter out entries we've already seen
      const currentLastSeenId = this.lastSeenIds.get(ctx.connectionId) ?? null;
      const newEntries = currentLastSeenId !== null
        ? entries.filter(e => e.id > currentLastSeenId)
        : entries;

      if (newEntries.length === 0) {
        this.gaps.completePoll(ctx.connectionId, SLOWLOG_CAPTURE, entries, currentLastSeenId);
        if (!this.externalEntryCounts.has(ctx.connectionId)) {
          this.externalEntryCounts.set(ctx.connectionId, 0);
        }
        this.logger.debug(`No new slow log entries to save for ${ctx.connectionName}`);
        return;
      }

      // Transform to storage format
      const storedEntries: StoredSlowLogEntry[] = newEntries.map(e => ({
        id: e.id,
        timestamp: e.timestamp,
        duration: e.duration,
        command: e.command,
        clientAddress: e.clientAddress || '',
        clientName: e.clientName || '',
        capturedAt: now,
        sourceHost: source.host,
        sourcePort: source.port,
        sourceRunId: source.runId,
        connectionId: ctx.connectionId,
      }));

      const saved = await this.storage.saveSlowLogEntries(storedEntries, ctx.connectionId);
      const missed = this.gaps.completePoll(ctx.connectionId, SLOWLOG_CAPTURE, entries, currentLastSeenId);
      if (missed > 0) {
        this.logger.warn(
          `Slow log of ${ctx.connectionName}: ${missed} entries after id ${currentLastSeenId} were never read (dropped by the server, or more than 128 logged between two polls)`
        );
      }

      // Update lastSeenId to the highest ID we've seen
      const maxId = Math.max(...newEntries.map(e => e.id));
      const storedLastSeenId = this.lastSeenIds.get(ctx.connectionId);
      if (storedLastSeenId === null || storedLastSeenId === undefined || maxId > storedLastSeenId) {
        this.lastSeenIds.set(ctx.connectionId, maxId);
      }

      // The entries that were never read have no known client. They are
      // assumed to have the same mix as the ones read: a burst is then not
      // capped at the fetch size, and a burst of ignored entries still adds
      // nothing.
      const externalRead = newEntries.filter((entry) => !this.isIgnoredSlowlogEntry(entry)).length;
      const externalMissed = Math.round((missed * externalRead) / newEntries.length);
      // Published only after the save: a failed first poll must still be the
      // first poll when it is retried.
      const previous = this.externalEntryCounts.get(ctx.connectionId) ?? 0;
      this.externalEntryCounts.set(ctx.connectionId, previous + externalRead + externalMissed);

      this.logger.debug(`Saved ${saved} new slow log entries for ${ctx.connectionName} (lastSeenId: ${this.lastSeenIds.get(ctx.connectionId)})`);
    } catch (error) {
      if (this.runtimeCapabilityTracker.recordFailure(ctx.connectionId, 'canSlowLog', error instanceof Error ? error : String(error))) {
        this.logger.warn(`Slow log disabled for ${ctx.connectionName} due to blocked command`);
        return;
      }
      this.logger.error(`Error capturing slow log for ${ctx.connectionName}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }

  protected onConnectionRemoved(connectionId: string): void {
    this.lastSeenIds.delete(connectionId);
    this.externalEntryCounts.delete(connectionId);
    this.logSources.forget(connectionId);
    this.gaps.forget(connectionId);
    this.cachedEntries.delete(connectionId);
    this.cachedAnalysis.delete(connectionId);
    this.lastCacheUpdate.delete(connectionId);
    this.logger.debug(`Cleaned up state for removed connection ${connectionId}`);
  }

  // Public methods for querying stored slow log

  async getStoredSlowLog(options?: SlowLogQueryOptions): Promise<StoredSlowLogEntry[]> {
    return this.storage.getSlowLogEntries(options);
  }

  async pruneOldEntries(retentionDays: number = 7, connectionId?: string): Promise<number> {
    const cutoffTimestamp = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
    return this.storage.pruneOldSlowLogEntries(cutoffTimestamp, connectionId);
  }

  // Methods for Prometheus metrics (uses cached data from polling)

  getCachedEntries(connectionId?: string): SlowLogEntry[] {
    if (connectionId) {
      return this.cachedEntries.get(connectionId) || [];
    }
    // Return all cached entries combined if no connectionId
    const all: SlowLogEntry[] = [];
    for (const entries of this.cachedEntries.values()) {
      all.push(...entries);
    }
    return all;
  }

  getCachedAnalysis(connectionId?: string): SlowLogPatternAnalysis | null {
    if (connectionId) {
      return this.cachedAnalysis.get(connectionId) || null;
    }
    // If no connectionId, return analysis for the default connection
    const defaultId = this.connectionRegistry.getDefaultId();
    if (defaultId) {
      return this.cachedAnalysis.get(defaultId) || null;
    }
    return null;
  }

  getLastCacheUpdate(connectionId?: string): number {
    if (connectionId) {
      return this.lastCacheUpdate.get(connectionId) || 0;
    }
    // Return most recent update time if no connectionId
    let mostRecent = 0;
    for (const ts of this.lastCacheUpdate.values()) {
      if (ts > mostRecent) mostRecent = ts;
    }
    return mostRecent;
  }

  async getSlowLogLength(connectionId?: string): Promise<number> {
    const targetId = connectionId || this.connectionRegistry.getDefaultId() || '';
    if (!this.runtimeCapabilityTracker.isAvailable(targetId, 'canSlowLog')) {
      return 0;
    }
    const client = this.connectionRegistry.get(connectionId);
    return client.getSlowLogLength();
  }

  getLostEntries(connectionId: string): ReadonlyMap<string, number> {
    return this.gaps.lostEntries(connectionId);
  }

  getLastSeenId(connectionId?: string): number | null {
    if (connectionId) {
      return this.lastSeenIds.get(connectionId) ?? null;
    }
    // Return lastSeenId for default connection
    const defaultId = this.connectionRegistry.getDefaultId();
    if (defaultId) {
      return this.lastSeenIds.get(defaultId) ?? null;
    }
    return null;
  }

  /**
   * Cumulative count of new slowlog entries that anomaly detection counts.
   * Null until the first completed poll for this connection.
   */
  getExternalEntryCount(connectionId?: string): number | null {
    const id = connectionId || this.connectionRegistry.getDefaultId();
    if (!id || !this.externalEntryCounts.has(id)) return null;
    return this.externalEntryCounts.get(id) ?? null;
  }

  private isIgnoredSlowlogEntry(entry: SlowLogEntry): boolean {
    const name = entry.clientName ?? '';
    if (this.ignoreOwnClients && isBetterDbClientName(name)) return true;
    if (name && this.ignoreClientPrefixes.some((prefix) => name.startsWith(prefix))) return true;
    if (this.ignoreCommands.size === 0) return false;
    // `get` matches GET with any arguments; `cluster|slot-stats` matches only
    // that subcommand.
    const [cmd, sub] = (entry.command ?? []).slice(0, 2).map((part) => part.toLowerCase());
    if (!cmd) return false;
    return (
      this.ignoreCommands.has(cmd) ||
      (sub !== undefined && this.ignoreCommands.has(`${cmd}|${sub}`))
    );
  }
}
