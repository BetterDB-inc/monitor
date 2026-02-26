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
import { MultiConnectionPoller, ConnectionContext } from '../common/services/multi-connection-poller';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { RuntimeCapabilityTracker } from '../connections/runtime-capability-tracker.service';

@Injectable()
export class SlowLogAnalyticsService extends MultiConnectionPoller implements OnModuleInit {
  protected readonly logger = new Logger(SlowLogAnalyticsService.name);

  // Per-connection state tracking
  private lastSeenIds = new Map<string, number | null>();

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
      // Initialize lastSeenId from storage if not already set
      if (!this.lastSeenIds.has(ctx.connectionId)) {
        const lastId = await this.storage.getLatestSlowLogId(ctx.connectionId);
        this.lastSeenIds.set(ctx.connectionId, lastId);
        this.logger.debug(`Initialized lastSeenId for ${ctx.connectionName}: ${lastId}`);
      }

      // Fetch slow log from Valkey/Redis (up to 128 entries)
      const entries = await ctx.client.getSlowLog(128);
      const now = Date.now();
      const lastSeenId = this.lastSeenIds.get(ctx.connectionId) ?? null;

      // Update cache for Prometheus metrics
      this.cachedEntries.set(ctx.connectionId, entries);
      this.cachedAnalysis.set(ctx.connectionId, analyzeSlowLogPatterns(entries));
      this.lastCacheUpdate.set(ctx.connectionId, now);

      // Detect ID wraparound (e.g., after SLOWLOG RESET)
      if (entries.length > 0 && lastSeenId !== null) {
        const maxIdInBatch = Math.max(...entries.map(e => e.id));
        if (maxIdInBatch < lastSeenId) {
          this.logger.warn(
            `Slowlog ID wraparound detected for ${ctx.connectionName} (lastSeenId: ${lastSeenId}, maxIdInBatch: ${maxIdInBatch}). Resetting tracker.`
          );
          this.lastSeenIds.set(ctx.connectionId, null);
        }
      }

      // Filter out entries we've already seen
      const currentLastSeenId = this.lastSeenIds.get(ctx.connectionId);
      const newEntries = currentLastSeenId !== null
        ? entries.filter(e => e.id > currentLastSeenId!)
        : entries;

      if (newEntries.length === 0) {
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
        sourceHost: ctx.host,
        sourcePort: ctx.port,
        connectionId: ctx.connectionId,
      }));

      const saved = await this.storage.saveSlowLogEntries(storedEntries, ctx.connectionId);

      // Update lastSeenId to the highest ID we've seen
      const maxId = Math.max(...newEntries.map(e => e.id));
      const storedLastSeenId = this.lastSeenIds.get(ctx.connectionId);
      if (storedLastSeenId === null || storedLastSeenId === undefined || maxId > storedLastSeenId) {
        this.lastSeenIds.set(ctx.connectionId, maxId);
      }

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
}
