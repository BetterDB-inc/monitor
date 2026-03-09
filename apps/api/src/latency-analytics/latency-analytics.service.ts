import { Injectable, Inject, OnModuleInit, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  StoragePort,
  StoredLatencySnapshot,
  StoredLatencyHistogram,
  LatencySnapshotQueryOptions,
} from '../common/interfaces/storage-port.interface';
import { MultiConnectionPoller, ConnectionContext } from '../common/services/multi-connection-poller';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { RuntimeCapabilityTracker } from '../connections/runtime-capability-tracker.service';

@Injectable()
export class LatencyAnalyticsService extends MultiConnectionPoller implements OnModuleInit {
  protected readonly logger = new Logger(LatencyAnalyticsService.name);

  private readonly DEFAULT_POLL_INTERVAL_MS = 60000;

  // outer key: connectionId, inner key: eventName, value: latestEventTimestamp
  private lastSeenTimestamps = new Map<string, Map<string, number>>();

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
    await this.hydrateLastSeenTimestamps();
    this.logger.log(`Starting latency analytics polling (interval: ${this.getIntervalMs()}ms)`);
    this.start();
  }

  private async hydrateLastSeenTimestamps(): Promise<void> {
    try {
      const snapshots = await this.storage.getLatencySnapshots({ limit: 10000 });
      for (const snapshot of snapshots) {
        const connId = snapshot.connectionId;
        if (!connId) continue;
        if (!this.lastSeenTimestamps.has(connId)) {
          this.lastSeenTimestamps.set(connId, new Map());
        }
        const connTimestamps = this.lastSeenTimestamps.get(connId)!;
        const current = connTimestamps.get(snapshot.eventName) ?? -1;
        if (snapshot.latestEventTimestamp > current) {
          connTimestamps.set(snapshot.eventName, snapshot.latestEventTimestamp);
        }
      }
      if (this.lastSeenTimestamps.size > 0) {
        this.logger.log(`Hydrated dedup state for ${this.lastSeenTimestamps.size} connection(s)`);
      }
    } catch (error) {
      this.logger.warn(`Failed to hydrate dedup state, starting fresh: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  protected async pollConnection(ctx: ConnectionContext): Promise<void> {
    if (!this.runtimeCapabilityTracker.isAvailable(ctx.connectionId, 'canLatency')) {
      return;
    }

    const now = Date.now();

    // Store histogram data (command-level latency distributions)
    try {
      const histogramData = await ctx.client.getLatencyHistogram();
      if (Object.keys(histogramData).length > 0) {
        const histogram: StoredLatencyHistogram = {
          id: randomUUID(),
          timestamp: now,
          data: histogramData,
          connectionId: ctx.connectionId,
        };
        await this.storage.saveLatencyHistogram(histogram, ctx.connectionId);
        this.logger.debug(`Saved latency histogram for ${ctx.connectionName}`);
      }
    } catch (error) {
      this.logger.error(`Error capturing latency histogram for ${ctx.connectionName}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    // Store system-level latency events
    try {
      const events = await ctx.client.getLatestLatencyEvents();

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
      const msg = error instanceof Error ? error.message : String(error);
      if (this.runtimeCapabilityTracker.recordFailure(ctx.connectionId, 'canLatency', error instanceof Error ? error : String(error))) {
        this.logger.warn(`Disabled latency polling for ${ctx.connectionName} after repeated failures`);
      } else {
        this.logger.error(`Error capturing latency events for ${ctx.connectionName}: ${msg}`);
      }
    }
  }

  protected onConnectionRemoved(connectionId: string): void {
    this.lastSeenTimestamps.delete(connectionId);
    this.logger.debug(`Cleaned up state for removed connection ${connectionId}`);
  }

  async getStoredSnapshots(options?: LatencySnapshotQueryOptions): Promise<StoredLatencySnapshot[]> {
    return this.storage.getLatencySnapshots(options);
  }

  async getStoredHistograms(options?: { connectionId?: string; startTime?: number; endTime?: number; limit?: number }): Promise<StoredLatencyHistogram[]> {
    return this.storage.getLatencyHistograms(options);
  }

  async pruneOldEntries(retentionDays: number = 7, connectionId?: string): Promise<number> {
    const cutoffTimestamp = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
    const [snapshots, histograms] = await Promise.all([
      this.storage.pruneOldLatencySnapshots(cutoffTimestamp, connectionId),
      this.storage.pruneOldLatencyHistograms(cutoffTimestamp, connectionId),
    ]);
    return snapshots + histograms;
  }
}
