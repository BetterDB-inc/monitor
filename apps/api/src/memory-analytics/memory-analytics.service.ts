import { Injectable, Inject, OnModuleInit, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  StoragePort,
  StoredMemorySnapshot,
  MemorySnapshotQueryOptions,
} from '../common/interfaces/storage-port.interface';
import { MemoryStats } from '../common/types/metrics.types';
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
      const stats: MemoryStats = await ctx.client.getMemoryStats();
      const now = Date.now();

      const snapshot: StoredMemorySnapshot = {
        id: randomUUID(),
        timestamp: now,
        usedMemory: stats.totalAllocated,
        usedMemoryRss: Number(stats.usedMemoryRss ?? 0),
        usedMemoryPeak: stats.peakAllocated,
        memFragmentationRatio: Number(stats.memFragmentationRatio ?? 0),
        maxmemory: Number(stats.maxmemory ?? 0),
        allocatorFragRatio: Number(stats.allocatorFragRatio ?? 0),
        connectionId: ctx.connectionId,
      };

      const saved = await this.storage.saveMemorySnapshots([snapshot], ctx.connectionId);
      this.logger.debug(`Saved ${saved} memory snapshot for ${ctx.connectionName}`);
    } catch (error) {
      this.logger.error(`Error capturing memory stats for ${ctx.connectionName}: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
