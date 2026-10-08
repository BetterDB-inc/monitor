import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { KvCacheEngineSample, KvCacheSampleBucket, KvCacheSamplesResponse } from '@betterdb/shared';
import type { StoragePort } from '@app/common/interfaces/storage-port.interface';
import { CounterDeltaTracker, type CounterObservation } from './counter-deltas';

export const SAMPLES_FLUSH_MS = 15_000;
export const SAMPLES_MAX_RANGE_MS = 31 * 24 * 60 * 60_000;
export const SAMPLES_LIMIT = 50_000;

export function hitRate(requested: number, hit: number): number | null {
  return requested > 0 ? Math.round((hit / requested) * 1e4) / 1e4 : null;
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
    existing.requestedTokens += row.requestedTokens;
    existing.hitTokens += row.hitTokens;
    existing.lookupTokens += row.lookupTokens;
    existing.lookupHits += row.lookupHits;
    existing.remoteReadBytes += row.remoteReadBytes;
    existing.remoteWriteBytes += row.remoteWriteBytes;
    existing.remoteReadRequests += row.remoteReadRequests;
    existing.remoteWriteRequests += row.remoteWriteRequests;
    existing.remotePingErrors += row.remotePingErrors;
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

  forgetEngine(engineId: string): void {
    this.tracker.forgetEngine(engineId);
  }

  async flush(nowMs: number = Date.now(), includeOpen = false): Promise<void> {
    const rows = this.tracker.drain(nowMs, includeOpen);
    if (rows.length === 0) return;
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
    const rows = await this.storage.getKvCacheEngineSamples({
      connectionId,
      from: Math.max(query.from, query.to - SAMPLES_MAX_RANGE_MS),
      to: query.to,
      limit: SAMPLES_LIMIT,
      engineId: query.engineId,
      modelName: query.model,
    });
    const requested = rows.reduce((sum, row) => sum + row.requestedTokens, 0);
    const hit = rows.reduce((sum, row) => sum + row.hitTokens, 0);
    return { buckets: mergeBuckets(rows), rangeHitRate: hitRate(requested, hit) };
  }
}
