import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Feature } from '@betterdb/shared';
import type { StoredKvCacheEngine } from '@app/common/interfaces/storage-port.interface';
import { LicenseService } from '@proprietary/licenses/license.service';
import { KvCacheEngineRegistry } from './kv-cache-engine-registry';
import { KvCacheEnginesService } from './kv-cache-engines.service';
import { KvCacheSamplesService } from './kv-cache-samples.service';
import { fetchMetricsText, ScrapeError } from './metrics-fetch';
import { parseLmcacheMetrics } from './prometheus-text';

const DEFAULT_INTERVAL_MS = 30000;
const MIN_INTERVAL_MS = 1000;

function resolveIntervalMs(): number {
  const parsed = parseInt(process.env.KV_CACHE_SCRAPE_INTERVAL_MS || String(DEFAULT_INTERVAL_MS), 10);
  return !Number.isFinite(parsed) || parsed < MIN_INTERVAL_MS ? DEFAULT_INTERVAL_MS : parsed;
}

@Injectable()
export class KvCacheScrapeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KvCacheScrapeService.name);
  private readonly intervalMs = resolveIntervalMs();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly registry: KvCacheEngineRegistry,
    private readonly samples: KvCacheSamplesService,
    private readonly engines: KvCacheEnginesService,
    private readonly license: LicenseService,
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
      const targets = this.registry.list().filter((e) => e.enabled && e.source === 'scrape' && e.scrapeUrl);
      await Promise.allSettled(targets.map((engine) => this.scrape(engine, now)));
    } finally {
      this.running = false;
    }
  }

  private async scrape(engine: StoredKvCacheEngine, now: number): Promise<void> {
    try {
      const text = await fetchMetricsText(engine.scrapeUrl as string, this.engines.authHeaderFor(engine));
      const parsed = parseLmcacheMetrics(text);
      for (const { metric, labels, value } of parsed) {
        this.samples.observe(
          {
            engineId: engine.id,
            connectionId: engine.connectionId,
            modelName: labels.model_name || 'unknown',
            series: `${labels.worker_id ?? ''}|${labels.role ?? ''}`,
            metric,
            value,
            cumulative: true,
          },
          now,
        );
      }
      this.registry.recordResult(engine.id, {
        lastSeenAt: now,
        lastError: parsed.length === 0 ? 'no lmcache metrics found' : null,
      });
    } catch (error) {
      if (error instanceof ScrapeError) {
        this.registry.recordResult(engine.id, { lastError: error.message });
        return;
      }
      this.logger.debug(`Scrape of engine ${engine.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      this.registry.recordResult(engine.id, { lastError: 'scrape failed' });
    }
  }
}
