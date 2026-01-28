import { Injectable, Inject, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabasePort } from '../common/interfaces/database-port.interface';
import {
  StoragePort,
  StoredClientSnapshot,
  ClientSnapshotQueryOptions,
  ClientTimeSeriesPoint,
  ClientAnalyticsStats,
} from '../common/interfaces/storage-port.interface';
import { PrometheusService } from '../prometheus/prometheus.service';
import { SettingsService } from '../settings/settings.service';

@Injectable()
export class ClientAnalyticsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ClientAnalyticsService.name);
  private pollInterval: NodeJS.Timeout | null = null;
  private isPolling = false;

  constructor(
    @Inject('DATABASE_CLIENT') private dbClient: DatabasePort,
    @Inject('STORAGE_CLIENT') private storage: StoragePort,
    private configService: ConfigService,
    private prometheusService: PrometheusService,
    private settingsService: SettingsService,
  ) {}

  private get pollIntervalMs(): number {
    return this.settingsService.getCachedSettings().clientAnalyticsPollIntervalMs;
  }

  async onModuleInit(): Promise<void> {
    this.logger.log(`Starting client analytics polling (interval: ${this.pollIntervalMs}ms)`);
    await this.startPolling();
  }

  onModuleDestroy(): void {
    this.stopPolling();
  }

  private async startPolling(): Promise<void> {
    await this.captureSnapshot();

    const scheduleNextPoll = () => {
      this.pollInterval = setTimeout(async () => {
        if (!this.isPolling) {
          try {
            await this.captureSnapshot();
          } catch (err) {
            this.logger.error('Client snapshot capture failed:', err);
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

  private async captureSnapshot(): Promise<void> {
    this.isPolling = true;
    const endTimer = this.prometheusService.startPollTimer('client-analytics');

    try {
      const clients = await this.dbClient.getClients();
      const now = Date.now();
      const dbConfig = this.configService.get('database');

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
        sourceHost: dbConfig.host,
        sourcePort: dbConfig.port,
      }));

      const saved = await this.storage.saveClientSnapshot(snapshots);
      this.logger.debug(`Saved ${saved} client snapshots`);
      this.prometheusService.incrementPollCounter();
    } finally {
      endTimer();
      this.isPolling = false;
    }
  }

  async getSnapshots(options?: ClientSnapshotQueryOptions): Promise<StoredClientSnapshot[]> {
    return this.storage.getClientSnapshots(options);
  }

  async getTimeSeries(startTime: number, endTime: number, bucketSizeMs?: number): Promise<ClientTimeSeriesPoint[]> {
    return this.storage.getClientTimeSeries(startTime, endTime, bucketSizeMs);
  }

  async getStats(startTime?: number, endTime?: number): Promise<ClientAnalyticsStats> {
    return this.storage.getClientAnalyticsStats(startTime, endTime);
  }

  async getConnectionHistory(
    identifier: { name?: string; user?: string; addr?: string },
    startTime?: number,
    endTime?: number,
  ): Promise<StoredClientSnapshot[]> {
    return this.storage.getClientConnectionHistory(identifier, startTime, endTime);
  }

  async cleanup(olderThanTimestamp?: number): Promise<number> {
    // Default to 30 days ago if no timestamp provided
    const cutoff = olderThanTimestamp || Date.now() - (30 * 24 * 60 * 60 * 1000);
    return this.storage.pruneOldClientSnapshots(cutoff);
  }
}
