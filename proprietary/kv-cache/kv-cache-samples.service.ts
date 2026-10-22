import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { KvCacheEngineSample, KvCacheSampleBucket, KvCacheSamplesResponse } from '@betterdb/shared';
import type { StoragePort } from '@app/common/interfaces/storage-port.interface';
import { addCounters, BUCKET_MS, CounterDeltaTracker, type CounterObservation } from './counter-deltas';

export const SAMPLES_FLUSH_MS = 15_000;
export const SAMPLES_MAX_RANGE_MS = 31 * 24 * 60 * 60_000;
export const SAMPLES_LIMIT = 50_000;
export const SAMPLES_CHART_POINTS = 1440;

function chartBucketMs(from: number, to: number): number {
  const span = Math.max(0, to - from);
  return Math.max(1, Math.ceil(span / SAMPLES_CHART_POINTS / BUCKET_MS)) * BUCKET_MS;
}

export function hitRate(requested: number, hit: number): number | null {
  if (!(requested > 0)) return null;
  return Math.round(Math.min(1, Math.max(0, hit / requested)) * 1e4) / 1e4;
}

export function mergeBuckets(samples: KvCacheEngineSample[]): KvCacheSampleBucket[] {
  const merged = new Map<string, KvCacheEngineSample>();
  for (const row of samples) {
    const key = JSON.stringify([row.engineId, row.modelName, row.timestamp]);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...row });
      continue;
    }
    addCounters(existing, row);
  }
  return [...merged.values()]
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((row) => ({ ...row, hitRate: hitRate(row.requestedTokens, row.hitTokens) }));
}

@Injectable()
export class KvCacheSamplesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KvCacheSamplesService.name);
  private readonly tracker = new CounterDeltaTracker();
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> = Promise.resolve();

  constructor(@Inject('STORAGE_CLIENT') private readonly storage: StoragePort) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.flush(), SAMPLES_FLUSH_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush(Date.now(), true);
  }

  observe(observation: CounterObservation, nowMs: number): boolean {
    return this.tracker.observe(observation, nowMs);
  }

  resetBaselines(engineId: string): void {
    this.tracker.forgetBaselines(engineId);
  }

  forgetEngine(engineId: string): void {
    this.tracker.forgetEngine(engineId);
  }

  idle(): Promise<void> {
    return this.flushing;
  }

  async deleteEngine(engineId: string): Promise<void> {
    this.forgetEngine(engineId);
    await this.flushing;
    await this.storage.deleteKvCacheEngineSamples(engineId);
  }

  flush(nowMs: number = Date.now(), includeOpen = false): Promise<void> {
    const rows = this.tracker.drain(nowMs, includeOpen);
    if (rows.length === 0) return this.flushing;
    const write = this.flushing.then(() => this.write(rows));
    this.flushing = write;
    return write;
  }

  private async write(rows: KvCacheEngineSample[]): Promise<void> {
    try {
      await this.storage.saveKvCacheEngineSamples(rows);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Could not save ${rows.length} KV cache samples: ${message}`);
    }
  }

  async getSamples(
    connectionId: string,
    query: { from: number; to: number; engineId?: string; model?: string },
  ): Promise<KvCacheSamplesResponse> {
    const filter = {
      connectionId,
      from: Math.max(query.from, query.to - SAMPLES_MAX_RANGE_MS),
      to: query.to,
      engineId: query.engineId,
      modelName: query.model,
    };
    const [rows, totals] = await Promise.all([
      this.storage.getKvCacheEngineSamples({ ...filter, limit: SAMPLES_LIMIT, bucketMs: chartBucketMs(filter.from, filter.to) }),
      this.storage.getKvCacheSampleTotals(filter),
    ]);
    return { buckets: mergeBuckets(rows), rangeHitRate: hitRate(totals.requestedTokens, totals.hitTokens) };
  }
}
