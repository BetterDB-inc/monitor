import { Injectable, Inject, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabasePort, SlowLogEntry } from '../common/interfaces/database-port.interface';
import {
  StoragePort,
  StoredSlowLogEntry,
  SlowLogQueryOptions,
} from '../common/interfaces/storage-port.interface';
import { SettingsService } from '../settings/settings.service';
import { SlowLogPatternAnalysis } from '../common/types/metrics.types';
import { analyzeSlowLogPatterns } from '../metrics/slowlog-analyzer';

@Injectable()
export class SlowLogAnalyticsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SlowLogAnalyticsService.name);
  private pollInterval: NodeJS.Timeout | null = null;
  private isPolling = false;
  private lastSeenId: number | null = null;

  // Cache of last fetched entries for Prometheus metrics (avoids duplicate Valkey calls)
  private cachedEntries: SlowLogEntry[] = [];
  private cachedAnalysis: SlowLogPatternAnalysis | null = null;
  private lastCacheUpdate: number = 0;

  // Poll every 30 seconds by default
  private readonly DEFAULT_POLL_INTERVAL_MS = 30000;

  constructor(
    @Inject('DATABASE_CLIENT') private dbClient: DatabasePort,
    @Inject('STORAGE_CLIENT') private storage: StoragePort,
    private configService: ConfigService,
    private settingsService: SettingsService,
  ) {}

  private get pollIntervalMs(): number {
    // Could add a setting for this, for now use default
    return this.DEFAULT_POLL_INTERVAL_MS;
  }

  async onModuleInit(): Promise<void> {
    // Get the latest stored slow log ID to avoid re-saving old entries
    this.lastSeenId = await this.storage.getLatestSlowLogId();
    this.logger.log(`Starting slow log analytics polling (interval: ${this.pollIntervalMs}ms, lastSeenId: ${this.lastSeenId})`);
    await this.startPolling();
  }

  onModuleDestroy(): void {
    this.stopPolling();
  }

  private async startPolling(): Promise<void> {
    await this.captureSlowLog();

    const scheduleNextPoll = () => {
      this.pollInterval = setTimeout(async () => {
        if (!this.isPolling) {
          try {
            await this.captureSlowLog();
          } catch (err) {
            this.logger.error('Slow log capture failed:', err);
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

  private async captureSlowLog(): Promise<void> {
    this.isPolling = true;

    try {
      // Fetch slow log from Valkey/Redis (up to 128 entries)
      const entries = await this.dbClient.getSlowLog(128);
      const now = Date.now();
      const dbConfig = this.configService.get('database');

      // Update cache for Prometheus metrics (single source of truth)
      this.cachedEntries = entries;
      this.cachedAnalysis = analyzeSlowLogPatterns(entries);
      this.lastCacheUpdate = now;

      // Detect ID wraparound (e.g., after SLOWLOG RESET)
      // If the max ID in the current batch is less than our lastSeenId,
      // the log was likely reset, so we should save all entries
      if (entries.length > 0 && this.lastSeenId !== null) {
        const maxIdInBatch = Math.max(...entries.map(e => e.id));
        if (maxIdInBatch < this.lastSeenId) {
          this.logger.warn(
            `Slowlog ID wraparound detected (lastSeenId: ${this.lastSeenId}, maxIdInBatch: ${maxIdInBatch}). Resetting tracker.`
          );
          this.lastSeenId = null;
        }
      }

      // Filter out entries we've already seen
      const newEntries = this.lastSeenId !== null
        ? entries.filter(e => e.id > this.lastSeenId!)
        : entries;

      if (newEntries.length === 0) {
        this.logger.debug('No new slow log entries to save');
        this.isPolling = false;
        return;
      }

      // Transform to storage format
      const storedEntries: StoredSlowLogEntry[] = newEntries.map(e => ({
        id: e.id,
        timestamp: e.timestamp,
        duration: e.duration,
        command: e.command,  // string[] with command name + args
        clientAddress: e.clientAddress || '',
        clientName: e.clientName || '',
        capturedAt: now,
        sourceHost: dbConfig.host,
        sourcePort: dbConfig.port,
      }));

      const saved = await this.storage.saveSlowLogEntries(storedEntries);

      // Update lastSeenId to the highest ID we've seen
      const maxId = Math.max(...newEntries.map(e => e.id));
      if (this.lastSeenId === null || maxId > this.lastSeenId) {
        this.lastSeenId = maxId;
      }

      this.logger.debug(`Saved ${saved} new slow log entries (lastSeenId: ${this.lastSeenId})`);
    } finally {
      this.isPolling = false;
    }
  }

  // Public methods for querying stored slow log

  async getStoredSlowLog(options?: SlowLogQueryOptions): Promise<StoredSlowLogEntry[]> {
    return this.storage.getSlowLogEntries(options);
  }

  async pruneOldEntries(retentionDays: number = 7): Promise<number> {
    const cutoffTimestamp = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
    return this.storage.pruneOldSlowLogEntries(cutoffTimestamp);
  }

  // Methods for Prometheus metrics (uses cached data from polling)

  getCachedEntries(): SlowLogEntry[] {
    return this.cachedEntries;
  }

  getCachedAnalysis(): SlowLogPatternAnalysis | null {
    return this.cachedAnalysis;
  }

  getLastCacheUpdate(): number {
    return this.lastCacheUpdate;
  }

  async getSlowLogLength(): Promise<number> {
    return this.dbClient.getSlowLogLength();
  }

  getLastSeenId(): number | null {
    return this.lastSeenId;
  }
}
