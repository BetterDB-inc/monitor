import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { StoragePort, KeyPatternSnapshot } from '@app/common/interfaces/storage-port.interface';
import { MultiConnectionPoller, ConnectionContext } from '@app/common/services/multi-connection-poller';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import { LicenseService } from '@proprietary/license/license.service';
import { randomUUID } from 'crypto';

@Injectable()
export class KeyAnalyticsService extends MultiConnectionPoller implements OnModuleInit {
  protected readonly logger = new Logger(KeyAnalyticsService.name);
  private isRunning = new Map<string, boolean>();

  private readonly sampleSize: number;
  private readonly scanBatchSize: number;
  private readonly intervalMs: number;

  constructor(
    connectionRegistry: ConnectionRegistry,
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    private readonly license: LicenseService,
  ) {
    super(connectionRegistry);
    this.sampleSize = parseInt(process.env.KEY_ANALYTICS_SAMPLE_SIZE || '10000', 10);
    this.scanBatchSize = parseInt(process.env.KEY_ANALYTICS_SCAN_BATCH_SIZE || '1000', 10);
    this.intervalMs = parseInt(process.env.KEY_ANALYTICS_INTERVAL_MS || '300000', 10);
  }

  protected getIntervalMs(): number {
    return this.intervalMs;
  }

  async onModuleInit() {
    if (!this.license.hasFeature('keyAnalytics')) {
      this.logger.log('Key Analytics requires Pro license - service disabled');
      return;
    }

    this.logger.log(
      `Key Analytics service initialized (sample: ${this.sampleSize}, interval: ${this.intervalMs}ms)`,
    );

    this.start();
  }

  protected onConnectionRemoved(connectionId: string): void {
    this.isRunning.delete(connectionId);
  }

  protected async pollConnection(ctx: ConnectionContext): Promise<void> {
    if (this.isRunning.get(ctx.connectionId)) {
      this.logger.debug(`Key analytics collection already running for ${ctx.connectionName}, skipping`);
      return;
    }

    this.isRunning.set(ctx.connectionId, true);
    const startTime = Date.now();

    try {
      const client = ctx.client.getClient();
      const dbSize = await client.dbsize();

      if (dbSize === 0) {
        this.logger.log('No keys found in database, skipping analytics');
        return;
      }

      const patterns = new Map<
        string,
        {
          count: number;
          totalMemory: number;
          maxMemory: number;
          totalIdleTime: number;
          withTtl: number;
          withoutTtl: number;
          ttlValues: number[];
          accessFrequencies: number[];
        }
      >();

      let cursor = '0';
      let scanned = 0;

      do {
        const [newCursor, keys] = await client.scan(cursor, 'COUNT', this.scanBatchSize);
        cursor = newCursor;

        for (const key of keys) {
          if (scanned >= this.sampleSize) break;
          scanned++;

          const pattern = this.extractPattern(key);
          const stats = patterns.get(pattern) || {
            count: 0,
            totalMemory: 0,
            maxMemory: 0,
            totalIdleTime: 0,
            withTtl: 0,
            withoutTtl: 0,
            ttlValues: [],
            accessFrequencies: [],
          };

          try {
            const pipeline = client.pipeline();
            pipeline.memory('USAGE', key);
            pipeline.object('IDLETIME', key);
            pipeline.object('FREQ', key);
            pipeline.ttl(key);

            const results = (await pipeline.exec()) || [];
            const [memResult, idleResult, freqResult, ttlResult] = results;

            stats.count++;

            if (memResult && memResult[1] !== null) {
              const mem = memResult[1] as number;
              stats.totalMemory += mem;
              if (mem > stats.maxMemory) stats.maxMemory = mem;
            }

            if (idleResult && idleResult[1] !== null) {
              stats.totalIdleTime += idleResult[1] as number;
            }

            if (freqResult && freqResult[1] !== null) {
              stats.accessFrequencies.push(freqResult[1] as number);
            }

            const ttl = ttlResult?.[1] as number;
            if (ttl > 0) {
              stats.withTtl++;
              stats.ttlValues.push(ttl);
            } else {
              stats.withoutTtl++;
            }

            patterns.set(pattern, stats);
          } catch (err) {
            this.logger.debug(`Failed to inspect key ${key}: ${err}`);
          }
        }

        if (scanned >= this.sampleSize) break;
      } while (cursor !== '0');

      const samplingRatio = scanned / dbSize;
      const snapshots: KeyPatternSnapshot[] = [];

      for (const [pattern, stats] of patterns.entries()) {
        const avgMemory = stats.count > 0 ? Math.round(stats.totalMemory / stats.count) : 0;
        const avgIdleTime = stats.count > 0 ? Math.round(stats.totalIdleTime / stats.count) : 0;
        const avgFreq =
          stats.accessFrequencies.length > 0
            ? stats.accessFrequencies.reduce((a, b) => a + b, 0) / stats.accessFrequencies.length
            : undefined;

        const avgTtl =
          stats.ttlValues.length > 0
            ? Math.round(stats.ttlValues.reduce((a, b) => a + b, 0) / stats.ttlValues.length)
            : undefined;
        const minTtl = stats.ttlValues.length > 0 ? Math.min(...stats.ttlValues) : undefined;
        const maxTtl = stats.ttlValues.length > 0 ? Math.max(...stats.ttlValues) : undefined;

        const staleCount = avgIdleTime > 86400 ? Math.round((avgIdleTime / 86400) * stats.count) : 0;
        const expiringSoon = stats.ttlValues.filter((t) => t < 3600).length;
        const expiringSoonCount = Math.round((expiringSoon / (stats.ttlValues.length || 1)) * stats.withTtl);

        let hotCount: number | undefined;
        let coldCount: number | undefined;
        if (avgFreq !== undefined) {
          const coldThreshold = avgFreq / 2;
          hotCount = Math.round(
            (stats.accessFrequencies.filter((f) => f > avgFreq).length / stats.count) * stats.count,
          );
          coldCount = Math.round(
            (stats.accessFrequencies.filter((f) => f < coldThreshold).length / stats.count) * stats.count,
          );
        }

        snapshots.push({
          id: randomUUID(),
          timestamp: Date.now(),
          pattern,
          keyCount: Math.round(stats.count / samplingRatio),
          sampledKeyCount: stats.count,
          keysWithTtl: Math.round(stats.withTtl / samplingRatio),
          keysExpiringSoon: Math.round(expiringSoonCount / samplingRatio),
          totalMemoryBytes: Math.round(stats.totalMemory / samplingRatio),
          avgMemoryBytes: avgMemory,
          maxMemoryBytes: stats.maxMemory,
          avgAccessFrequency: avgFreq,
          hotKeyCount: hotCount,
          coldKeyCount: coldCount,
          avgIdleTimeSeconds: avgIdleTime,
          staleKeyCount: staleCount,
          avgTtlSeconds: avgTtl,
          minTtlSeconds: minTtl,
          maxTtlSeconds: maxTtl,
        });
      }

      await this.storage.saveKeyPatternSnapshots(snapshots, ctx.connectionId);

      const duration = Date.now() - startTime;
      this.logger.log(
        `Key Analytics (${ctx.connectionName}): sampled ${scanned}/${dbSize} keys (${(samplingRatio * 100).toFixed(1)}%), ` +
        `found ${patterns.size} patterns in ${duration}ms`,
      );
    } catch (error) {
      this.logger.error(`Error collecting key analytics for ${ctx.connectionName}:`, error);
      throw error;
    } finally {
      this.isRunning.set(ctx.connectionId, false);
    }
  }

  private extractPattern(key: string): string {
    const parts = key.split(/[:._-]/);
    const patternParts = parts.map((part) => {
      if (/^\d+$/.test(part)) return '*';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(part)) return '*';
      if (/^[0-9a-f]{24}$/i.test(part)) return '*';
      if (/^[0-9a-f]{32,}$/i.test(part)) return '*';
      return part;
    });
    return patternParts.join(':');
  }

  async getSummary(startTime?: number, endTime?: number, connectionId?: string) {
    return this.storage.getKeyAnalyticsSummary(startTime, endTime, connectionId);
  }

  async getPatternSnapshots(options?: {
    pattern?: string;
    startTime?: number;
    endTime?: number;
    limit?: number;
    connectionId?: string;
  }) {
    return this.storage.getKeyPatternSnapshots(options);
  }

  async getPatternTrends(pattern: string, startTime: number, endTime: number, connectionId?: string) {
    return this.storage.getKeyPatternTrends(pattern, startTime, endTime, connectionId);
  }

  async pruneOldSnapshots(cutoffTimestamp: number, connectionId?: string): Promise<number> {
    return this.storage.pruneOldKeyPatternSnapshots(cutoffTimestamp, connectionId);
  }

  /**
   * Manually trigger key analytics collection for all connected databases.
   * Returns a promise that resolves when collection is complete for all connections.
   */
  async triggerCollection(): Promise<void> {
    const connections = this.connectionRegistry.list();
    const connectedConnections = connections.filter((conn) => conn.isConnected);

    if (connectedConnections.length === 0) {
      this.logger.warn('No connected databases found for key analytics collection');
      return;
    }

    this.logger.log(`Manually triggering key analytics collection for ${connectedConnections.length} connection(s)`);

    const promises = connectedConnections.map(async (conn) => {
      try {
        const client = this.connectionRegistry.get(conn.id);
        await this.pollConnection({
          connectionId: conn.id,
          connectionName: conn.name,
          client,
          host: conn.host,
          port: conn.port,
        });
      } catch (error) {
        this.logger.warn(
          `Manual collection failed for ${conn.name}: ${error instanceof Error ? error.message : error}`,
        );
      }
    });

    await Promise.allSettled(promises);
  }
}
