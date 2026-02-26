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
import { MultiConnectionPoller, ConnectionContext } from '../common/services/multi-connection-poller';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { RuntimeCapabilityTracker } from '../connections/runtime-capability-tracker.service';

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
        const entries = await ctx.client.getCommandLog(128, type);
        const lastSeenId = connectionLastSeenIds.get(type) ?? null;

        // Update cache for Prometheus metrics
        connectionCachedEntries.set(type, entries);
        connectionCachedAnalysis.set(type, analyzeSlowLogPatterns(entries as any));
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

        // Filter out entries we've already seen
        const newEntries = currentLastSeenId !== null
          ? entries.filter(e => e.id > currentLastSeenId)
          : entries;

        if (newEntries.length === 0) {
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

        // Update lastSeenId to the highest ID we've seen
        const maxId = Math.max(...newEntries.map(e => e.id));
        if (currentLastSeenId === null || maxId > currentLastSeenId) {
          connectionLastSeenIds.set(type, maxId);
        }

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

  protected onConnectionRemoved(connectionId: string): void {
    this.lastSeenIds.delete(connectionId);
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
