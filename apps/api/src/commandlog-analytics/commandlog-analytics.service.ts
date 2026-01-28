import { Injectable, Inject, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabasePort, CommandLogEntry } from '../common/interfaces/database-port.interface';
import {
  StoragePort,
  StoredCommandLogEntry,
  CommandLogQueryOptions,
  CommandLogType,
} from '../common/interfaces/storage-port.interface';
import { SlowLogPatternAnalysis } from '../common/types/metrics.types';
import { analyzeSlowLogPatterns } from '../metrics/slowlog-analyzer';

@Injectable()
export class CommandLogAnalyticsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CommandLogAnalyticsService.name);
  private pollInterval: NodeJS.Timeout | null = null;
  private isPolling = false;
  private lastSeenIds: Map<CommandLogType, number | null> = new Map([
    ['slow', null],
    ['large-request', null],
    ['large-reply', null],
  ]);

  // Cache of last fetched entries per type for Prometheus metrics (avoids duplicate Valkey calls)
  private cachedEntries: Map<CommandLogType, CommandLogEntry[]> = new Map([
    ['slow', []],
    ['large-request', []],
    ['large-reply', []],
  ]);
  private cachedAnalysis: Map<CommandLogType, SlowLogPatternAnalysis | null> = new Map([
    ['slow', null],
    ['large-request', null],
    ['large-reply', null],
  ]);
  private lastCacheUpdate: number = 0;

  private readonly DEFAULT_POLL_INTERVAL_MS = 30000;
  private readonly LOG_TYPES: CommandLogType[] = ['slow', 'large-request', 'large-reply'];

  constructor(
    @Inject('DATABASE_CLIENT') private dbClient: DatabasePort,
    @Inject('STORAGE_CLIENT') private storage: StoragePort,
    private configService: ConfigService,
  ) {}

  private get pollIntervalMs(): number {
    return this.DEFAULT_POLL_INTERVAL_MS;
  }

  async onModuleInit(): Promise<void> {
    // Check if the database supports command log
    const capabilities = this.dbClient.getCapabilities();
    if (!capabilities.hasCommandLog) {
      this.logger.log('Command log not supported by this database, skipping analytics polling');
      return;
    }

    // Get the latest stored command log IDs to avoid re-saving old entries
    for (const type of this.LOG_TYPES) {
      const lastId = await this.storage.getLatestCommandLogId(type);
      this.lastSeenIds.set(type, lastId);
    }

    this.logger.log(`Starting command log analytics polling (interval: ${this.pollIntervalMs}ms)`);
    await this.startPolling();
  }

  onModuleDestroy(): void {
    this.stopPolling();
  }

  private async startPolling(): Promise<void> {
    await this.captureCommandLog();

    const scheduleNextPoll = () => {
      this.pollInterval = setTimeout(async () => {
        if (!this.isPolling) {
          try {
            await this.captureCommandLog();
          } catch (err) {
            this.logger.error('Command log capture failed:', err);
          }
        }
        scheduleNextPoll();
      }, this.pollIntervalMs);
    };
    scheduleNextPoll();
  }

  private stopPolling(): void {
    if (this.pollInterval) {
      clearTimeout(this.pollInterval);
      this.pollInterval = null;
    }
  }

  private async captureCommandLog(): Promise<void> {
    this.isPolling = true;

    try {
      const now = Date.now();
      const dbConfig = this.configService.get('database');

      for (const type of this.LOG_TYPES) {
        const entries = await this.dbClient.getCommandLog(128, type);
        const lastSeenId = this.lastSeenIds.get(type) ?? null;

        // Update cache for Prometheus metrics (single source of truth)
        this.cachedEntries.set(type, entries);
        this.cachedAnalysis.set(type, analyzeSlowLogPatterns(entries as any));
        this.lastCacheUpdate = now;

        // Detect ID wraparound (e.g., after COMMANDLOG RESET)
        // If the max ID in the current batch is less than our lastSeenId,
        // the log was likely reset, so we should save all entries
        if (entries.length > 0 && lastSeenId !== null) {
          const maxIdInBatch = Math.max(...entries.map(e => e.id));
          if (maxIdInBatch < lastSeenId) {
            this.logger.warn(
              `Commandlog ${type} ID wraparound detected (lastSeenId: ${lastSeenId}, maxIdInBatch: ${maxIdInBatch}). Resetting tracker.`
            );
            this.lastSeenIds.set(type, null);
          }
        }

        // Re-fetch lastSeenId after potential reset
        const currentLastSeenId = this.lastSeenIds.get(type) ?? null;

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
          sourceHost: dbConfig.host,
          sourcePort: dbConfig.port,
        }));

        const saved = await this.storage.saveCommandLogEntries(storedEntries);

        // Update lastSeenId to the highest ID we've seen
        const maxId = Math.max(...newEntries.map(e => e.id));
        if (currentLastSeenId === null || maxId > currentLastSeenId) {
          this.lastSeenIds.set(type, maxId);
        }

        this.logger.debug(`Saved ${saved} new ${type} command log entries`);
      }
    } finally {
      this.isPolling = false;
    }
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

    // Convert StoredCommandLogEntry to SlowLogEntry format for the analyzer
    const slowLogEntries = entries.map(e => ({
      id: e.id,
      timestamp: e.timestamp,
      duration: e.duration,
      command: e.command,
      clientAddress: e.clientAddress,
      clientName: e.clientName,
    }));

    return analyzeSlowLogPatterns(slowLogEntries);
  }

  async pruneOldEntries(retentionDays: number = 7): Promise<number> {
    const cutoffTimestamp = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
    return this.storage.pruneOldCommandLogEntries(cutoffTimestamp);
  }

  // Methods for Prometheus metrics (uses cached data from polling)

  getCachedEntries(type: CommandLogType): CommandLogEntry[] {
    return this.cachedEntries.get(type) || [];
  }

  getCachedAnalysis(type: CommandLogType): SlowLogPatternAnalysis | null {
    return this.cachedAnalysis.get(type) || null;
  }

  getLastCacheUpdate(): number {
    return this.lastCacheUpdate;
  }

  hasCommandLogSupport(): boolean {
    return this.dbClient.getCapabilities().hasCommandLog;
  }
}
