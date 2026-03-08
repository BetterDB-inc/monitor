import { Injectable, Inject, OnModuleInit, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  StoragePort,
  StoredLatencySnapshot,
  LatencySnapshotQueryOptions,
} from '../common/interfaces/storage-port.interface';
import { MultiConnectionPoller, ConnectionContext } from '../common/services/multi-connection-poller';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { RuntimeCapabilityTracker } from '../connections/runtime-capability-tracker.service';

@Injectable()
export class LatencyAnalyticsService extends MultiConnectionPoller implements OnModuleInit {
  protected readonly logger = new Logger(LatencyAnalyticsService.name);

  private readonly DEFAULT_POLL_INTERVAL_MS = 60000;

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
    this.logger.log(`Starting latency analytics polling (interval: ${this.getIntervalMs()}ms)`);
    this.start();
  }

  protected async pollConnection(ctx: ConnectionContext): Promise<void> {
    try {
      const events = await ctx.client.getLatestLatencyEvents();
      const now = Date.now();

      if (events.length === 0) {
        this.logger.debug(`No latency events for ${ctx.connectionName}`);
        return;
      }

      const snapshots: StoredLatencySnapshot[] = events.map(event => ({
        id: randomUUID(),
        timestamp: now,
        eventName: event.eventName,
        latestEventTimestamp: event.timestamp,
        maxLatency: event.latency,
        connectionId: ctx.connectionId,
      }));

      const saved = await this.storage.saveLatencySnapshots(snapshots, ctx.connectionId);
      this.logger.debug(`Saved ${saved} latency snapshots for ${ctx.connectionName}`);
    } catch (error) {
      this.logger.error(`Error capturing latency for ${ctx.connectionName}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }

  async getStoredSnapshots(options?: LatencySnapshotQueryOptions): Promise<StoredLatencySnapshot[]> {
    return this.storage.getLatencySnapshots(options);
  }

  async pruneOldEntries(retentionDays: number = 7, connectionId?: string): Promise<number> {
    const cutoffTimestamp = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
    return this.storage.pruneOldLatencySnapshots(cutoffTimestamp, connectionId);
  }
}
