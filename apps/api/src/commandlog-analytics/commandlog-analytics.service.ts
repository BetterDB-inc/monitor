import { Injectable, Inject, OnModuleInit, Logger } from '@nestjs/common';
import { CommandLogEntry } from '../common/interfaces/database-port.interface';
import {
  StoragePort,
  StoredCommandLogEntry,
  CommandLogQueryOptions,
  CommandLogType,
  toSlowLogEntry,
} from '../common/interfaces/storage-port.interface';
import { SlowLogPatternAnalysis } from '../common/types/metrics.types';
import { analyzeSlowLogPatterns } from '../metrics/slowlog-analyzer';
import { analyzeScanSkew, ScanSkewReport } from './scan-skew-analyzer';
import { MultiConnectionPoller, ConnectionContext } from '../common/services/multi-connection-poller';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { RuntimeCapabilityTracker } from '../connections/runtime-capability-tracker.service';
import { LOG_CATCH_UP_MAX_FETCH, LOG_POLL_BATCH, planCatchUpFetch } from '../log-capture/capture-gap';
import { recordCaptureGap } from '../log-capture/capture-gap-recorder';

@Injectable()
export class CommandLogAnalyticsService extends MultiConnectionPoller implements OnModuleInit {
  protected readonly logger = new Logger(CommandLogAnalyticsService.name);

  private readonly DEFAULT_POLL_INTERVAL_MS = 30000;
  private readonly LOG_TYPES: CommandLogType[] = ['slow', 'large-request', 'large-reply'];

  // Nested Maps: connectionId -> (type -> lastSeenId)
  private lastSeenIds = new Map<string, Map<CommandLogType, number | null>>();

  // Nested Maps: connectionId -> (type -> entries)
  private cachedEntries = new Map<string, Map<CommandLogType, CommandLogEntry[]>>();
  private cachedAnalysis = new Map<string, Map<CommandLogType, SlowLogPatternAnalysis | null>>();
  private lastCacheUpdate = new Map<string, number>();

  // connectionId -> (type -> end of the last successful poll). A missing entry
  // means this process has not completed a poll yet (classifies capture gaps).
  private lastPollAt = new Map<string, Map<CommandLogType, number>>();

  constructor(
    connectionRegistry: ConnectionRegistry,
    @Inject('STORAGE_CLIENT') private storage: StoragePort,
    private readonly runtimeCapabilityTracker: RuntimeCapabilityTracker,
  ) {
    super(connectionRegistry);
  }

  protected getIntervalMs(): number {
    return this.DEFAULT_POLL_INTERVAL_MS;
  }

  async onModuleInit(): Promise<void> {
    this.logger.log(`Starting command log analytics polling (interval: ${this.getIntervalMs()}ms)`);
    this.start();
  }

  private initConnectionState(connectionId: string): void {
    if (!this.lastSeenIds.has(connectionId)) {
      this.lastSeenIds.set(connectionId, new Map([
        ['slow', null],
        ['large-request', null],
        ['large-reply', null],
      ]));
    }
    if (!this.cachedEntries.has(connectionId)) {
      this.cachedEntries.set(connectionId, new Map([
        ['slow', []],
        ['large-request', []],
        ['large-reply', []],
      ]));
    }
    if (!this.cachedAnalysis.has(connectionId)) {
      this.cachedAnalysis.set(connectionId, new Map([
        ['slow', null],
        ['large-request', null],
        ['large-reply', null],
      ]));
    }
  }

  protected async pollConnection(ctx: ConnectionContext): Promise<void> {
    // Check if the database supports command log
    const capabilities = ctx.client.getCapabilities();
    if (!capabilities.hasCommandLog) {
      this.logger.debug(`Command log not supported by ${ctx.connectionName}, skipping poll`);
      return;
    }

    if (!this.runtimeCapabilityTracker.isAvailable(ctx.connectionId, 'canCommandLog')) {
      return;
    }

    // Initialize per-connection state if needed
    this.initConnectionState(ctx.connectionId);

    // Load lastSeenIds from storage on first poll for this connection
    const connectionLastSeenIds = this.lastSeenIds.get(ctx.connectionId)!;
    for (const type of this.LOG_TYPES) {
      if (connectionLastSeenIds.get(type) === null) {
        const lastId = await this.storage.getLatestCommandLogId(type, ctx.connectionId);
        connectionLastSeenIds.set(type, lastId);
      }
    }

    const now = Date.now();
    const connectionCachedEntries = this.cachedEntries.get(ctx.connectionId)!;
    const connectionCachedAnalysis = this.cachedAnalysis.get(ctx.connectionId)!;

    for (const type of this.LOG_TYPES) {
      try {
        const batch = await ctx.client.getCommandLog(LOG_POLL_BATCH, type);
        let entries = batch;
        const lastSeenId = connectionLastSeenIds.get(type) ?? null;

        // Update cache for Prometheus metrics (always the regular batch, so the
        // pattern metrics keep their 128-entry window even after a catch-up read)
        connectionCachedEntries.set(type, batch);
        connectionCachedAnalysis.set(type, analyzeSlowLogPatterns(batch));
        this.lastCacheUpdate.set(ctx.connectionId, now);

        // Detect ID wraparound (e.g., after COMMANDLOG RESET)
        if (entries.length > 0 && lastSeenId !== null) {
          const maxIdInBatch = Math.max(...entries.map(e => e.id));
          if (maxIdInBatch < lastSeenId) {
            this.logger.warn(
              `Commandlog ${type} ID wraparound detected for ${ctx.connectionName} (lastSeenId: ${lastSeenId}, maxIdInBatch: ${maxIdInBatch}). Resetting tracker.`
            );
            connectionLastSeenIds.set(type, null);
          }
        }

        // Re-fetch lastSeenId after potential reset
        const currentLastSeenId = connectionLastSeenIds.get(type) ?? null;
        const pollTimes = this.pollTimesFor(ctx.connectionId);

        // The regular batch only holds the newest 128 entries. When more than
        // that arrived since the last poll, read back to the last seen id (up
        // to LOG_CATCH_UP_MAX_FETCH) instead of silently skipping the rest.
        let requested = LOG_POLL_BATCH;
        const catchUp = planCatchUpFetch({
          lastSeenId: currentLastSeenId,
          batch,
          batchLimit: LOG_POLL_BATCH,
          maxFetch: LOG_CATCH_UP_MAX_FETCH,
        });
        if (catchUp !== null) {
          requested = catchUp;
          entries = await ctx.client.getCommandLog(catchUp, type);
        }

        // Filter out entries we've already seen
        const newEntries = currentLastSeenId !== null
          ? entries.filter(e => e.id > currentLastSeenId)
          : entries;

        if (newEntries.length === 0) {
          pollTimes.set(type, now);
          continue;
        }

        // Transform to storage format
        const storedEntries: StoredCommandLogEntry[] = newEntries.map(e => ({
          id: e.id,
          timestamp: e.timestamp,
          duration: e.duration,
          command: e.command,
          clientAddress: e.clientAddress || '',
          clientName: e.clientName || '',
          type: type,
          capturedAt: now,
          sourceHost: ctx.host,
          sourcePort: ctx.port,
          connectionId: ctx.connectionId,
        }));

        const saved = await this.storage.saveCommandLogEntries(storedEntries, ctx.connectionId);

        await recordCaptureGap(this.storage, this.logger, {
          connectionId: ctx.connectionId,
          connectionName: ctx.connectionName,
          logType: `commandlog-${type}`,
          lastSeenId: currentLastSeenId,
          entries,
          requested,
          previousPollAt: pollTimes.get(type) ?? null,
          intervalMs: this.getIntervalMs(),
          now,
        });

        // Update lastSeenId to the highest ID we've seen
        const maxId = Math.max(...newEntries.map(e => e.id));
        if (currentLastSeenId === null || maxId > currentLastSeenId) {
          connectionLastSeenIds.set(type, maxId);
        }
        pollTimes.set(type, now);

        this.logger.debug(`Saved ${saved} new ${type} command log entries for ${ctx.connectionName}`);
      } catch (error) {
        if (this.runtimeCapabilityTracker.recordFailure(ctx.connectionId, 'canCommandLog', error instanceof Error ? error : String(error))) {
          this.logger.warn(`Command log disabled for ${ctx.connectionName} due to blocked command`);
          return;
        }
        this.logger.error(`Error capturing ${type} command log for ${ctx.connectionName}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }
  }

  private pollTimesFor(connectionId: string): Map<CommandLogType, number> {
    let pollTimes = this.lastPollAt.get(connectionId);
    if (pollTimes === undefined) {
      pollTimes = new Map();
      this.lastPollAt.set(connectionId, pollTimes);
    }
    return pollTimes;
  }

  protected onConnectionRemoved(connectionId: string): void {
    this.lastSeenIds.delete(connectionId);
    this.lastPollAt.delete(connectionId);
    this.cachedEntries.delete(connectionId);
    this.cachedAnalysis.delete(connectionId);
    this.lastCacheUpdate.delete(connectionId);
    this.logger.debug(`Cleaned up state for removed connection ${connectionId}`);
  }

  // Public methods for querying stored command log

  async getStoredCommandLog(options?: CommandLogQueryOptions): Promise<StoredCommandLogEntry[]> {
    return this.storage.getCommandLogEntries(options);
  }

  async getStoredCommandLogPatternAnalysis(options?: CommandLogQueryOptions): Promise<SlowLogPatternAnalysis> {
    // Fetch stored entries with the given filters
    const entries = await this.storage.getCommandLogEntries({
      ...options,
      limit: options?.limit || 500, // Higher limit for pattern analysis
    });

    return analyzeSlowLogPatterns(entries.map(toSlowLogEntry));
  }

  /**
   * SCAN large-reply / hash-skew advisory (valkey#3955) over stored
   * large-reply entries. The type filter is forced: the analysis is only
   * meaningful against the large-reply log, whose magnitude column is bytes.
   */
  async getScanSkewAnalysis(options?: CommandLogQueryOptions): Promise<ScanSkewReport> {
    const entries = await this.storage.getCommandLogEntries({
      ...options,
      type: 'large-reply',
      command: 'SCAN',
      limit: options?.limit || 500,
    });
    return analyzeScanSkew(entries);
  }

  async pruneOldEntries(retentionDays: number = 7, connectionId?: string): Promise<number> {
    const cutoffTimestamp = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
    return this.storage.pruneOldCommandLogEntries(cutoffTimestamp, connectionId);
  }

  // Methods for Prometheus metrics (uses cached data from polling)

  getCachedEntries(type: CommandLogType, connectionId?: string): CommandLogEntry[] {
    const targetId = connectionId || this.connectionRegistry.getDefaultId();
    if (!targetId) return [];
    return this.cachedEntries.get(targetId)?.get(type) || [];
  }

  getCachedAnalysis(type: CommandLogType, connectionId?: string): SlowLogPatternAnalysis | null {
    const targetId = connectionId || this.connectionRegistry.getDefaultId();
    if (!targetId) return null;
    return this.cachedAnalysis.get(targetId)?.get(type) || null;
  }

  getLastCacheUpdate(connectionId?: string): number {
    const targetId = connectionId || this.connectionRegistry.getDefaultId();
    if (!targetId) return 0;
    return this.lastCacheUpdate.get(targetId) || 0;
  }

  hasCommandLogSupport(connectionId?: string): boolean {
    try {
      const client = this.connectionRegistry.get(connectionId);
      return client.getCapabilities().hasCommandLog;
    } catch {
      return false;
    }
  }
}
