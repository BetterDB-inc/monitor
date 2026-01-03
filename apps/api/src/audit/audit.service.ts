import { Injectable, Inject, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabasePort } from '../common/interfaces/database-port.interface';
import { StoragePort, StoredAclEntry } from '../common/interfaces/storage-port.interface';
import { AclLogEntry } from '../common/types/metrics.types';

@Injectable()
export class AuditService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuditService.name);
  private pollInterval: NodeJS.Timeout | null = null;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private lastSeenTimestamp: number = 0;
  private readonly enabled: boolean;
  private readonly pollIntervalMs: number;
  private readonly retentionDays: number;
  private readonly sourceHost: string;
  private readonly sourcePort: number;

  constructor(
    @Inject('DATABASE_CLIENT')
    private readonly dbClient: DatabasePort,
    @Inject('STORAGE_CLIENT')
    private readonly storageClient: StoragePort,
    private readonly configService: ConfigService,
  ) {
    this.enabled = this.configService.get<boolean>('storage.audit.enabled', true);
    this.pollIntervalMs = this.configService.get<number>('storage.audit.pollIntervalMs', 60000);
    this.retentionDays = this.configService.get<number>('storage.audit.retentionDays', 30);
    this.sourceHost = this.configService.get<string>('database.host', 'localhost');
    this.sourcePort = this.configService.get<number>('database.port', 6379);
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.log('Audit trail is disabled');
      return;
    }

    if (!this.storageClient.isReady()) {
      this.logger.error('Storage client is not ready');
      return;
    }

    this.logger.log(
      `Starting audit trail polling (interval: ${this.pollIntervalMs}ms, retention: ${this.retentionDays} days)`,
    );

    // Initial poll
    await this.pollAclLog();

    // Set up recurring poll
    this.pollInterval = setInterval(() => {
      this.pollAclLog().catch((error) => {
        this.logger.error(`Failed to poll ACL log: ${error instanceof Error ? error.message : 'Unknown error'}`);
      });
    }, this.pollIntervalMs);

    this.cleanupInterval = setInterval(
      () => {
        this.cleanupOldEntries().catch((error) => {
          this.logger.error(
            `Failed to cleanup old entries: ${error instanceof Error ? error.message : 'Unknown error'}`,
          );
        });
      },
      24 * 60 * 60 * 1000,
    );

    // Run cleanup once on startup
    await this.cleanupOldEntries();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  private async pollAclLog(): Promise<void> {
    try {
      const capabilities = this.dbClient.getCapabilities();
      if (!capabilities.hasAclLog) {
        this.logger.warn('ACL LOG not supported by database, skipping poll');
        return;
      }

      // Get ACL log entries
      const aclEntries = await this.dbClient.getAclLog(100);

      if (aclEntries.length === 0) {
        return;
      }

      // Filter out entries we've already seen
      const newEntries = this.deduplicateEntries(aclEntries);

      if (newEntries.length === 0) {
        return;
      }

      // Enrich entries with metadata
      const capturedAt = Math.floor(Date.now() / 1000);
      const storedEntries: StoredAclEntry[] = newEntries.map((entry) => ({
        id: 0, // Will be assigned by database
        count: entry.count,
        reason: entry.reason,
        context: entry.context,
        object: entry.object,
        username: entry.username,
        ageSeconds: entry.ageSeconds,
        clientInfo: entry.clientInfo,
        timestampCreated: entry.timestampCreated,
        timestampLastUpdated: entry.timestampLastUpdated,
        capturedAt,
        sourceHost: this.sourceHost,
        sourcePort: this.sourcePort,
      }));

      // Save to storage
      const saved = await this.storageClient.saveAclEntries(storedEntries);
      this.logger.debug(`Saved ${saved} new ACL entries`);

      // Update last seen timestamp
      const latestTimestamp = Math.max(...newEntries.map((e) => e.timestampLastUpdated));
      this.lastSeenTimestamp = latestTimestamp;
    } catch (error) {
      this.logger.error(`Error polling ACL log: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }

  private deduplicateEntries(entries: AclLogEntry[]): AclLogEntry[] {
    // Filter entries that are newer than the last seen timestamp
    return entries.filter((entry) => entry.timestampLastUpdated > this.lastSeenTimestamp);
  }

  private async cleanupOldEntries(): Promise<void> {
    try {
      const cutoffTimestamp = Math.floor(Date.now() / 1000) - this.retentionDays * 24 * 60 * 60;
      const deleted = await this.storageClient.pruneOldEntries(cutoffTimestamp);

      if (deleted > 0) {
        this.logger.log(`Cleaned up ${deleted} entries older than ${this.retentionDays} days`);
      }
    } catch (error) {
      this.logger.error(`Error cleaning up old entries: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }
}
