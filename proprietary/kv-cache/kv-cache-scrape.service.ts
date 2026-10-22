import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Feature } from '@betterdb/shared';
import type { StoredKvCacheEngine } from '@app/common/interfaces/storage-port.interface';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import { LicenseService } from '@proprietary/licenses/license.service';
import { labelSeries } from './counter-deltas';
import { KvCacheEngineRegistry } from './kv-cache-engine-registry';
import { KvCacheEnginesService } from './kv-cache-engines.service';
import { resolvePositiveInt } from './kv-cache-footprint.service';
import { KvCacheSamplesService } from './kv-cache-samples.service';
import { fetchMetricsText, ScrapeError, UNDECRYPTABLE_AUTH } from './metrics-fetch';
import { NO_METRICS, parseLmcacheMetrics } from './prometheus-text';

const DEFAULT_INTERVAL_MS = 30000;
const MIN_INTERVAL_MS = 1000;
const MAX_INTERVAL_MS = 86_400_000;

@Injectable()
export class KvCacheScrapeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KvCacheScrapeService.name);
  private readonly intervalMs = resolvePositiveInt(
    process.env.KV_CACHE_SCRAPE_INTERVAL_MS,
    DEFAULT_INTERVAL_MS,
    MIN_INTERVAL_MS,
    (raw) =>
      this.logger.warn(
        `Ignoring KV_CACHE_SCRAPE_INTERVAL_MS='${raw}': expected an integer between ${MIN_INTERVAL_MS} and ${MAX_INTERVAL_MS}, using ${DEFAULT_INTERVAL_MS}`,
      ),
    MAX_INTERVAL_MS,
  );
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly registry: KvCacheEngineRegistry,
    private readonly samples: KvCacheSamplesService,
    private readonly engines: KvCacheEnginesService,
    private readonly license: LicenseService,
    private readonly connections: ConnectionRegistry,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now: number = Date.now()): Promise<void> {
    if (this.running || !this.license.hasFeature(Feature.KV_CACHE_MONITORING)) return;
    this.running = true;
    try {
      const targets = this.registry
        .list()
        .filter((e) => e.enabled && e.source === 'scrape' && e.scrapeUrl && this.connectionExists(e.connectionId));
      await Promise.allSettled(targets.map((engine) => this.scrape(engine, now)));
    } finally {
      this.running = false;
    }
  }

  private async scrape(engine: StoredKvCacheEngine, now: number): Promise<void> {
    try {
      const authHeader = this.engines.authHeaderFor(engine);
      if (engine.scrapeAuthHeader && authHeader === null) throw new ScrapeError(UNDECRYPTABLE_AUTH);
      const text = await fetchMetricsText(engine.scrapeUrl as string, authHeader);
      if (!this.stillCurrent(engine)) return;
      const parsed = parseLmcacheMetrics(text);
      for (const { metric, labels, value } of parsed) {
        this.samples.observe(
          {
            engineId: engine.id,
            connectionId: engine.connectionId,
            modelName: labels.model_name || 'unknown',
            series: labelSeries(labels),
            metric,
            value,
            cumulative: true,
          },
          now,
        );
      }
      this.registry.recordResult(engine.id, {
        lastSeenAt: now,
        lastError: parsed.length === 0 ? NO_METRICS : null,
      });
    } catch (error) {
      if (!this.stillCurrent(engine)) return;
      if (error instanceof ScrapeError) {
        this.registry.recordResult(engine.id, { lastError: error.message });
        return;
      }
      this.logger.debug(`Scrape of engine ${engine.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      this.registry.recordResult(engine.id, { lastError: 'scrape failed' });
    }
  }

  private stillCurrent(engine: StoredKvCacheEngine): boolean {
    const current = this.registry.get(engine.id);
    return !!current?.enabled && current.scrapeUrl === engine.scrapeUrl && this.connectionExists(engine.connectionId);
  }

  private connectionExists(connectionId: string): boolean {
    return this.connections.getConfig(connectionId) !== null;
  }
}
