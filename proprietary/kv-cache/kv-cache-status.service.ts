import { Inject, Injectable } from '@nestjs/common';
import type { KvCacheEngine, KvCacheFootprintSnapshot, KvCacheStatus } from '@betterdb/shared';
import type { StoragePort, StoredKvCacheEngine } from '@app/common/interfaces/storage-port.interface';
import { KvCacheEngineRegistry } from './kv-cache-engine-registry';
import { KvCacheFootprintService } from './kv-cache-footprint.service';

export const FOOTPRINT_HISTORY_MAX_RANGE_MS = 31 * 24 * 60 * 60_000;
export const FOOTPRINT_HISTORY_LIMIT = 10_000;

export function toPublicEngine(engine: StoredKvCacheEngine): KvCacheEngine {
  const { scrapeAuthHeader, scrapeAuthEncrypted: _encrypted, ...rest } = engine;
  return { ...rest, hasScrapeAuth: scrapeAuthHeader !== null };
}

@Injectable()
export class KvCacheStatusService {
  constructor(
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    private readonly footprint: KvCacheFootprintService,
    private readonly engines: KvCacheEngineRegistry,
  ) {}

  async getStatus(connectionId: string): Promise<KvCacheStatus> {
    const [latest] = await this.storage.getKvCacheFootprintSnapshots({ connectionId, limit: 1 });
    return {
      hasLmcache: latest?.detected === true,
      latest: latest ?? null,
      sampleKey: this.footprint.getSampleKey(connectionId),
      engines: this.engines.list(connectionId).map(toPublicEngine),
    };
  }

  getFootprintHistory(connectionId: string, from: number, to: number): Promise<KvCacheFootprintSnapshot[]> {
    return this.storage.getKvCacheFootprintSnapshots({
      connectionId,
      from: Math.max(from, to - FOOTPRINT_HISTORY_MAX_RANGE_MS),
      to,
      limit: FOOTPRINT_HISTORY_LIMIT,
    });
  }
}
