import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { StoragePort, KeyPatternSnapshot, HotKeyEntry, HotKeyQueryOptions } from '@app/common/interfaces/storage-port.interface';
import { MultiConnectionPoller, ConnectionContext } from '@app/common/services/multi-connection-poller';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import { LicenseService } from '@proprietary/licenses/license.service';
import { Tier } from '@proprietary/licenses/types';
import { KeySizeDistribution, parseKeySizeDistribution } from '@betterdb/shared';
import { randomUUID } from 'crypto';

const HOT_KEYS_TOP_N = 50;
const LARGEST_KEYS_TOP_N = 50;

/** Retention in days per tier. null = keep indefinitely. */
const TIER_RETENTION_DAYS: Record<Tier, number | null> = {
  [Tier.community]: 7,
  [Tier.pro]: 30,
  [Tier.enterprise]: null,
};

@Injectable()
export class KeyAnalyticsService extends MultiConnectionPoller implements OnModuleInit {
  protected readonly logger = new Logger(KeyAnalyticsService.name);
  private isRunning = new Map<string, boolean>();
  private pruneHandle: NodeJS.Timeout | null = null;

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

    const pruneIntervalMs = 24 * 60 * 60 * 1000;
    this.pruneHandle = setInterval(() => this.pruneOldData(), pruneIntervalMs);
  }

  private async pruneOldData(): Promise<void> {
    try {
      const retentionDays = TIER_RETENTION_DAYS[this.license.getLicenseTier()];
      if (retentionDays === null) {
        this.logger.debug('Key Analytics prune skipped: unlimited retention (enterprise tier)');
        return;
      }
      const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
      const [deletedSnapshots, deletedHotKeys] = await Promise.all([
        this.storage.pruneOldKeyPatternSnapshots(cutoff),
        this.storage.pruneOldHotKeys(cutoff),
      ]);
      this.logger.log(
        `Key Analytics prune (${this.license.getLicenseTier()} tier, ${retentionDays}d retention): removed ${deletedSnapshots} pattern snapshots, ${deletedHotKeys} hot key entries older than ${new Date(cutoff).toISOString()}`,
      );
    } catch (err) {
      this.logger.error(`Key Analytics prune failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  protected onConnectionRemoved(connectionId: string): void {
    this.isRunning.delete(connectionId);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pruneHandle) {
      clearInterval(this.pruneHandle);
      this.pruneHandle = null;
    }
    await super.onModuleDestroy();
  }

  protected async pollConnection(ctx: ConnectionContext): Promise<void> {
    return this.collect(ctx, false);
  }

  private async collect(ctx: ConnectionContext, fullScan: boolean): Promise<void> {
    if (this.isRunning.get(ctx.connectionId)) {
      this.logger.debug(`Key analytics collection already running for ${ctx.connectionName}, skipping`);
      return;
    }

    this.isRunning.set(ctx.connectionId, true);
    const startTime = Date.now();

    try {
      const result = await ctx.client.collectKeyAnalytics({
        sampleSize: this.sampleSize,
        scanBatchSize: this.scanBatchSize,
        fullScan,
      });

      if (result.dbSize === 0) {
        this.logger.log('No keys found in database, skipping analytics');
        return;
      }

      // SCAN can return the same key more than once, so `scanned` may exceed
      // `dbSize` (always does on a full scan). Clamp to 1 so extrapolated
      // pattern totals are never scaled *down* below the observed counts.
      const samplingRatio = Math.min(1, result.scanned / result.dbSize);
      const snapshots: KeyPatternSnapshot[] = [];

      for (const stats of result.patterns) {
        const pattern = stats.pattern;
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

      // Collect hot keys from per-key pipeline data
      if (result.keyDetails && result.keyDetails.length > 0) {
        const capturedAt = Date.now();
        const lfuKeys: Array<typeof result.keyDetails[number]> = [];
        const idletimeKeys: Array<typeof result.keyDetails[number]> = [];

        for (const kd of result.keyDetails) {
          if (kd.freqScore !== null) {
            lfuKeys.push(kd);
          } else if (kd.idleSeconds !== null) {
            idletimeKeys.push(kd);
          }
        }

        // LFU: descending by freqScore
        lfuKeys.sort((a, b) => (b.freqScore ?? 0) - (a.freqScore ?? 0));
        // IDLETIME: ascending by idleSeconds (lower = more recently accessed)
        idletimeKeys.sort((a, b) => (a.idleSeconds ?? 0) - (b.idleSeconds ?? 0));

        // LFU keys rank above all IDLETIME keys
        const ranked = [...lfuKeys, ...idletimeKeys].slice(0, HOT_KEYS_TOP_N);

        const hotKeys: HotKeyEntry[] = ranked.map((kd, idx) => {
          const isLfu = kd.freqScore !== null;
          return {
            id: randomUUID(),
            keyName: kd.keyName,
            connectionId: ctx.connectionId,
            capturedAt,
            signalType: isLfu ? 'lfu' as const : 'idletime' as const,
            freqScore: isLfu ? (kd.freqScore ?? undefined) : undefined,
            idleSeconds: !isLfu ? (kd.idleSeconds ?? undefined) : undefined,
            memoryBytes: kd.memoryBytes ?? undefined,
            ttl: kd.ttl ?? undefined,
            rank: idx + 1,
          };
        });

        if (hotKeys.length > 0) {
          await this.storage.saveHotKeys(hotKeys, ctx.connectionId);
        }

        // Largest keys (valkey #1827): rank by cardinality (element count / byte length).
        const largestKeys: HotKeyEntry[] = result.keyDetails
          .filter((kd) => kd.cardinality !== null)
          .sort((a, b) => (b.cardinality ?? 0) - (a.cardinality ?? 0))
          .slice(0, LARGEST_KEYS_TOP_N)
          .map((kd, idx) => ({
            id: randomUUID(),
            keyName: kd.keyName,
            connectionId: ctx.connectionId,
            capturedAt,
            signalType: 'cardinality' as const,
            cardinality: kd.cardinality ?? undefined,
            keyType: kd.keyType ?? undefined,
            memoryBytes: kd.memoryBytes ?? undefined,
            ttl: kd.ttl ?? undefined,
            rank: idx + 1,
          }));

        if (largestKeys.length > 0) {
          await this.storage.saveHotKeys(largestKeys, ctx.connectionId);
        }
      }

      const duration = Date.now() - startTime;
      this.logger.log(
        `Key Analytics (${ctx.connectionName}): ${fullScan ? 'deep-scanned' : 'sampled'} ${result.scanned}/${result.dbSize} keys (${(samplingRatio * 100).toFixed(1)}%), ` +
        `found ${result.patterns.length} patterns in ${duration}ms`,
      );
    } catch (error) {
      this.logger.error(`Error collecting key analytics for ${ctx.connectionName}:`, error);
      throw error;
    } finally {
      this.isRunning.set(ctx.connectionId, false);
    }
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

  async getHotKeys(options?: HotKeyQueryOptions): Promise<HotKeyEntry[]> {
    return this.storage.getHotKeys(options);
  }

  /** Top-N largest keys by cardinality (element count / byte length). */
  async getLargestKeys(options?: HotKeyQueryOptions): Promise<HotKeyEntry[]> {
    return this.storage.getHotKeys({ ...options, signalTypes: ['cardinality'] });
  }

  async pruneOldSnapshots(cutoffTimestamp: number, connectionId?: string): Promise<number> {
    return this.storage.pruneOldKeyPatternSnapshots(cutoffTimestamp, connectionId);
  }

  /**
   * Manually trigger key analytics collection for all connected databases.
   * Returns a promise that resolves when collection is complete for all connections.
   */
  async triggerCollection(fullScan = false): Promise<void> {
    const connections = this.connectionRegistry.list();
    const connectedConnections = connections.filter((conn) => conn.isConnected);

    if (connectedConnections.length === 0) {
      this.logger.warn('No connected databases found for key analytics collection');
      return;
    }

    this.logger.log(
      `Manually triggering ${fullScan ? 'deep-scan ' : ''}key analytics collection for ${connectedConnections.length} connection(s)`,
    );

    const promises = connectedConnections.map(async (conn) => {
      try {
        const client = this.connectionRegistry.get(conn.id);
        await this.collect(
          {
            connectionId: conn.id,
            connectionName: conn.name,
            client,
            host: conn.host,
            port: conn.port,
          },
          fullScan,
        );
      } catch (error) {
        this.logger.warn(
          `Manual collection failed for ${conn.name}: ${error instanceof Error ? error.message : error}`,
        );
      }
    });

    await Promise.allSettled(promises);
  }

  /**
   * Whole-keyspace size distribution via `INFO keysizes` (server-maintained,
   * no key scanning). Returns `available: false` if the server lacks the section.
   */
  async getKeySizes(connectionId?: string): Promise<KeySizeDistribution> {
    let targetId = connectionId;
    if (!targetId) {
      const connected = this.connectionRegistry.list().filter((conn) => conn.isConnected);
      if (connected.length === 0) {
        return { databases: {}, available: false };
      }
      targetId = connected[0].id;
    }

    const client = this.connectionRegistry.get(targetId);
    if (!client) {
      return { databases: {}, available: false };
    }

    try {
      const raw = (await client.call('INFO', ['keysizes'])) as string;
      return parseKeySizeDistribution(raw ?? '');
    } catch {
      // Servers without the keysizes section may reject the argument outright
      // (e.g. an ERR reply) rather than returning an empty string. Treat any
      // failure as "section unavailable" so the tab shows its empty state.
      return { databases: {}, available: false };
    }
  }
}
