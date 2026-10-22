import { Inject, Injectable } from '@nestjs/common';
import type { KvCacheEngine, KvCacheFootprintSnapshot, KvCacheStatus } from '@betterdb/shared';
import type { StoragePort, StoredKvCacheEngine } from '@app/common/interfaces/storage-port.interface';
import { KvCacheFootprintService } from './kv-cache-footprint.service';

export const FOOTPRINT_HISTORY_MAX_RANGE_MS = 31 * 24 * 60 * 60_000;
export const FOOTPRINT_HISTORY_POINTS = 1000;

export function toPublicEngine(engine: StoredKvCacheEngine): KvCacheEngine {
  const { scrapeAuthHeader, scrapeAuthEncrypted: _encrypted, ...rest } = engine;
  return { ...rest, hasScrapeAuth: scrapeAuthHeader !== null };
}

@Injectable()
export class KvCacheStatusService {
  constructor(
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    private readonly footprint: KvCacheFootprintService,
  ) {}

  async getStatus(connectionId: string): Promise<KvCacheStatus> {
    const [[latest], engines] = await Promise.all([
      this.storage.getKvCacheFootprintSnapshots({ connectionId, limit: 1 }),
      this.storage.getKvCacheEngines(connectionId),
    ]);
    return {
      hasLmcache: latest?.detected === true,
      latest: latest ?? null,
      sampleKey: this.footprint.getSampleKey(connectionId),
      engines: engines.map(toPublicEngine),
    };
  }

  async getFootprintHistory(connectionId: string, from: number, to: number): Promise<KvCacheFootprintSnapshot[]> {
    const start = Math.max(from, to - FOOTPRINT_HISTORY_MAX_RANGE_MS);
    return this.storage.getKvCacheFootprintSnapshots({
      connectionId,
      from: start,
      to,
      bucketMs: Math.max(1, Math.ceil((to - start) / FOOTPRINT_HISTORY_POINTS)),
      limit: FOOTPRINT_HISTORY_POINTS + 1,
    });
  }
}
