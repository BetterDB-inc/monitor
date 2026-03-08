import { Injectable, Inject, OnModuleInit, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  StoragePort,
  StoredMemorySnapshot,
  MemorySnapshotQueryOptions,
} from '../common/interfaces/storage-port.interface';
import { MultiConnectionPoller, ConnectionContext } from '../common/services/multi-connection-poller';
import { ConnectionRegistry } from '../connections/connection-registry.service';

@Injectable()
export class MemoryAnalyticsService extends MultiConnectionPoller implements OnModuleInit {
  protected readonly logger = new Logger(MemoryAnalyticsService.name);

  private readonly DEFAULT_POLL_INTERVAL_MS = 60000;

  constructor(
    connectionRegistry: ConnectionRegistry,
    @Inject('STORAGE_CLIENT') private storage: StoragePort,
  ) {
    super(connectionRegistry);
  }

  protected getIntervalMs(): number {
    return this.DEFAULT_POLL_INTERVAL_MS;
  }

  async onModuleInit(): Promise<void> {
    this.logger.log(`Starting memory analytics polling (interval: ${this.getIntervalMs()}ms)`);
    this.start();
  }

  protected async pollConnection(ctx: ConnectionContext): Promise<void> {
    try {
      const stats = await ctx.client.getMemoryStats() as Record<string, unknown>;
      const now = Date.now();

      const snapshot: StoredMemorySnapshot = {
        id: randomUUID(),
        timestamp: now,
        usedMemory: Number(stats['total.allocated'] ?? 0),
        usedMemoryRss: Number(stats['allocator.resident'] ?? 0),
        usedMemoryPeak: Number(stats['peak.allocated'] ?? 0),
        memFragmentationRatio: Number(stats['fragmentation'] ?? 0),
        maxmemory: Number(stats['maxmemory'] ?? 0),
        allocatorFragRatio: Number(stats['allocator-frag-ratio'] ?? 0),
        connectionId: ctx.connectionId,
      };

      const saved = await this.storage.saveMemorySnapshots([snapshot], ctx.connectionId);
      this.logger.debug(`Saved ${saved} memory snapshot for ${ctx.connectionName}`);
    } catch (error) {
      this.logger.error(`Error capturing memory stats for ${ctx.connectionName}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }

  async getStoredSnapshots(options?: MemorySnapshotQueryOptions): Promise<StoredMemorySnapshot[]> {
    return this.storage.getMemorySnapshots(options);
  }

  async pruneOldEntries(retentionDays: number = 7, connectionId?: string): Promise<number> {
    const cutoffTimestamp = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
    return this.storage.pruneOldMemorySnapshots(cutoffTimestamp, connectionId);
  }
}
