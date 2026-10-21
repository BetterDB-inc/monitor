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
import { RuntimeCapabilityTracker } from '../connections/runtime-capability-tracker.service';
import { ConfigService } from '@nestjs/config';
import { ClientAnalyticsRollupService } from './client-analytics-rollup.service';
import { QueryBudget } from './query-budget';
import { RAW_STATS_SPAN_MAX_MS } from './client-rollup-math';

/**
 * Query-string bounds arrive via parseInt, so a non-numeric value is NaN.
 * Treat any non-finite bound as absent: NaN must never reach the window
 * arithmetic or a storage query (PostgreSQL rejects it as a BIGINT). This
 * matches the adapters' old truthy checks, which silently dropped NaN.
 */
function finiteOrUndefined(value?: number): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

@Injectable()
export class ClientAnalyticsService extends MultiConnectionPoller implements OnModuleInit {
  protected readonly logger = new Logger(ClientAnalyticsService.name);
  private readonly budget: QueryBudget;

  constructor(
    connectionRegistry: ConnectionRegistry,
    @Inject('STORAGE_CLIENT') private storage: StoragePort,
    private prometheusService: PrometheusService,
    private settingsService: SettingsService,
    private readonly runtimeCapabilityTracker: RuntimeCapabilityTracker,
    private readonly rollupService: ClientAnalyticsRollupService,
    configService: ConfigService,
  ) {
    super(connectionRegistry);
    this.budget = QueryBudget.fromConfig(configService, this.logger);
  }

  protected getIntervalMs(): number {
    return this.settingsService.getCachedSettings().clientAnalyticsPollIntervalMs;
  }

  protected pollsSentinels(): boolean {
    return true;
  }

  async onModuleInit(): Promise<void> {
    this.start();
  }

  protected async pollConnection(ctx: ConnectionContext): Promise<void> {
    if (!this.runtimeCapabilityTracker.isAvailable(ctx.connectionId, 'canClientList')) {
      return;
    }

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
    } catch (error) {
      if (this.runtimeCapabilityTracker.recordFailure(ctx.connectionId, 'canClientList', error instanceof Error ? error : String(error))) {
        this.logger.warn(`Client list disabled for ${ctx.connectionName} due to blocked command`);
        return;
      }
      throw error;
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

  /**
   * Windowed stats without ever aggregating over the whole raw table:
   * - no bounds: the aggregator's in-memory latest window (or the same window
   *   merged from rollups when no single connection is asked for, memoised
   *   for one aggregate interval);
   * - a span up to RAW_STATS_SPAN_MAX_MS (6 hours) for one connection: a
   *   bounded raw query;
   * - a longer span, or any span without a connection: merged from rollup
   *   buckets. The raw fold takes "current" from the single newest batch
   *   across every connection, while rollups sum the newest batch of each
   *   connection still reporting (see mergeRollupsIntoStats); serving cross-connection requests from rollups only keeps the
   *   figures consistent across the 6-hour cut-off.
   * A missing endTime means now; a missing startTime means one window before endTime.
   * A non-finite bound (NaN from a non-numeric query parameter) counts as missing.
   */
  async getStats(startTime?: number, endTime?: number, connectionId?: string): Promise<ClientAnalyticsStats> {
    startTime = finiteOrUndefined(startTime);
    endTime = finiteOrUndefined(endTime);
    const windowMs = this.rollupService.getWindowMs();
    if (startTime === undefined && endTime === undefined) {
      if (connectionId) {
        const latest = this.rollupService.getLatestStats(connectionId);
        if (latest) return latest;
        // Before the first aggregator run: same window and retention-wide peak as
        // getLatestStats will report, so the peak does not change once that run lands.
        return this.rollupService.getWindowStatsWithRetentionPeak(connectionId);
      }
      return this.rollupService.getLatestStatsAllConnections();
    }
    const end = endTime ?? Date.now();
    const start = startTime ?? end - windowMs;
    if (connectionId && end - start <= RAW_STATS_SPAN_MAX_MS) {
      return this.budget.time('getClientAnalyticsStats', connectionId, () =>
        this.storage.getClientAnalyticsStats(start, end, connectionId),
      );
    }
    return this.rollupService.getStatsForRange(start, end, connectionId);
  }

  async getConnectionHistory(
    identifier: { name?: string; user?: string; addr?: string },
    startTime?: number,
    endTime?: number,
    connectionId?: string,
  ): Promise<StoredClientSnapshot[]> {
    startTime = finiteOrUndefined(startTime);
    endTime = finiteOrUndefined(endTime);
    // Never scan a connection's whole history: default to the stats window.
    const start = startTime ?? (endTime ?? Date.now()) - this.rollupService.getWindowMs();
    return this.storage.getClientConnectionHistory(identifier, start, endTime, connectionId);
  }

  async cleanup(olderThanTimestamp?: number, connectionId?: string): Promise<number> {
    // Default to 30 days ago if no timestamp provided
    const cutoff = olderThanTimestamp || Date.now() - (30 * 24 * 60 * 60 * 1000);
    return this.storage.pruneOldClientSnapshots(cutoff, connectionId);
  }
}
