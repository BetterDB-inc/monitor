import { Injectable, Inject, OnModuleInit, Logger } from '@nestjs/common';
import {
  StoragePort,
  StoredClientSnapshot,
  ClientSnapshotQueryOptions,
  ClientTimeSeriesPoint,
  ClientAnalyticsStats,
} from '../common/interfaces/storage-port.interface';
import { PrometheusService } from '../prometheus/prometheus.service';
import { SettingsService } from '../settings/settings.service';
import { MultiConnectionPoller, ConnectionContext } from '../common/services/multi-connection-poller';
import { ConnectionRegistry } from '../connections/connection-registry.service';

@Injectable()
export class ClientAnalyticsService extends MultiConnectionPoller implements OnModuleInit {
  protected readonly logger = new Logger(ClientAnalyticsService.name);

  constructor(
    connectionRegistry: ConnectionRegistry,
    @Inject('STORAGE_CLIENT') private storage: StoragePort,
    private prometheusService: PrometheusService,
    private settingsService: SettingsService,
  ) {
    super(connectionRegistry);
  }

  protected getIntervalMs(): number {
    return this.settingsService.getCachedSettings().clientAnalyticsPollIntervalMs;
  }

  async onModuleInit(): Promise<void> {
    this.start();
  }

  protected async pollConnection(ctx: ConnectionContext): Promise<void> {
    const endTimer = this.prometheusService.startPollTimer('client-analytics', ctx.connectionId);

    try {
      const clients = await ctx.client.getClients();
      const now = Date.now();

      const snapshots: StoredClientSnapshot[] = clients.map((c) => ({
        id: 0,
        clientId: c.id,
        addr: c.addr,
        name: c.name || '',
        user: c.user || 'default',
        db: c.db,
        cmd: c.cmd || '',
        age: c.age,
        idle: c.idle,
        flags: c.flags || '',
        sub: c.sub,
        psub: c.psub,
        qbuf: c.qbuf,
        qbufFree: c.qbufFree,
        obl: c.obl,
        oll: c.oll,
        omem: c.omem,
        capturedAt: now,
        sourceHost: ctx.host,
        sourcePort: ctx.port,
        connectionId: ctx.connectionId,
      }));

      const saved = await this.storage.saveClientSnapshot(snapshots, ctx.connectionId);
      this.logger.debug(`Saved ${saved} client snapshots for ${ctx.connectionName}`);
      this.prometheusService.incrementPollCounter(ctx.connectionId);
    } finally {
      endTimer();
    }
  }

  async getSnapshots(options?: ClientSnapshotQueryOptions): Promise<StoredClientSnapshot[]> {
    return this.storage.getClientSnapshots(options);
  }

  async getTimeSeries(startTime: number, endTime: number, bucketSizeMs?: number, connectionId?: string): Promise<ClientTimeSeriesPoint[]> {
    return this.storage.getClientTimeSeries(startTime, endTime, bucketSizeMs, connectionId);
  }

  async getStats(startTime?: number, endTime?: number, connectionId?: string): Promise<ClientAnalyticsStats> {
    return this.storage.getClientAnalyticsStats(startTime, endTime, connectionId);
  }

  async getConnectionHistory(
    identifier: { name?: string; user?: string; addr?: string },
    startTime?: number,
    endTime?: number,
    connectionId?: string,
  ): Promise<StoredClientSnapshot[]> {
    return this.storage.getClientConnectionHistory(identifier, startTime, endTime, connectionId);
  }

  async cleanup(olderThanTimestamp?: number, connectionId?: string): Promise<number> {
    // Default to 30 days ago if no timestamp provided
    const cutoff = olderThanTimestamp || Date.now() - (30 * 24 * 60 * 60 * 1000);
    return this.storage.pruneOldClientSnapshots(cutoff, connectionId);
  }
}
