import { Injectable, Inject, OnModuleInit, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  StoragePort,
  StoredLatencySnapshot,
  LatencySnapshotQueryOptions,
} from '../common/interfaces/storage-port.interface';
import { MultiConnectionPoller, ConnectionContext } from '../common/services/multi-connection-poller';
import { ConnectionRegistry } from '../connections/connection-registry.service';

@Injectable()
export class LatencyAnalyticsService extends MultiConnectionPoller implements OnModuleInit {
  protected readonly logger = new Logger(LatencyAnalyticsService.name);

  private readonly DEFAULT_POLL_INTERVAL_MS = 60000;

  // outer key: connectionId, inner key: eventName, value: latestEventTimestamp
  private lastSeenTimestamps = new Map<string, Map<string, number>>();

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

      // Lazily initialize the inner map for this connection
      if (!this.lastSeenTimestamps.has(ctx.connectionId)) {
        this.lastSeenTimestamps.set(ctx.connectionId, new Map());
      }
      const connTimestamps = this.lastSeenTimestamps.get(ctx.connectionId)!;

      // Filter to only events whose timestamp has changed since last poll
      const newEvents = events.filter(event =>
        event.timestamp > (connTimestamps.get(event.eventName) ?? -1)
      );

      if (newEvents.length === 0) {
        this.logger.debug(`No new latency events for ${ctx.connectionName}`);
        return;
      }

      const snapshots: StoredLatencySnapshot[] = newEvents.map(event => ({
        id: randomUUID(),
        timestamp: now,
        eventName: event.eventName,
        latestEventTimestamp: event.timestamp,
        maxLatency: event.latency,
        connectionId: ctx.connectionId,
      }));

      const saved = await this.storage.saveLatencySnapshots(snapshots, ctx.connectionId);

      // Update last-seen timestamps after successful save
      for (const event of newEvents) {
        connTimestamps.set(event.eventName, event.timestamp);
      }

      this.logger.debug(`Saved ${saved} latency snapshots for ${ctx.connectionName}`);
    } catch (error) {
      this.logger.error(`Error capturing latency for ${ctx.connectionName}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  protected onConnectionRemoved(connectionId: string): void {
    this.lastSeenTimestamps.delete(connectionId);
    this.logger.debug(`Cleaned up state for removed connection ${connectionId}`);
  }

  async getStoredSnapshots(options?: LatencySnapshotQueryOptions): Promise<StoredLatencySnapshot[]> {
    return this.storage.getLatencySnapshots(options);
  }

  async pruneOldEntries(retentionDays: number = 7, connectionId?: string): Promise<number> {
    const cutoffTimestamp = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
    return this.storage.pruneOldLatencySnapshots(cutoffTimestamp, connectionId);
  }
}
