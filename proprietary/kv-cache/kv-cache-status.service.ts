import { Inject, Injectable } from '@nestjs/common';
import type { KvCacheEngine, KvCacheFootprintSnapshot, KvCacheStatus } from '@betterdb/shared';
import type { StoragePort, StoredKvCacheEngine } from '@app/common/interfaces/storage-port.interface';
import { KvCacheEngineRegistry } from './kv-cache-engine-registry';
import { KvCacheFootprintService } from './kv-cache-footprint.service';

export const FOOTPRINT_HISTORY_MAX_RANGE_MS = 31 * 24 * 60 * 60_000;
export const FOOTPRINT_HISTORY_POINTS = 1000;

function maskScrapeUrl(url: string | null): string | null {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password && !parsed.search && !parsed.hash) return url;
    parsed.username = '';
    parsed.password = '';
    parsed.hash = '';
    for (const name of new Set(parsed.searchParams.keys())) {
      parsed.searchParams.set(name, parsed.searchParams.get(name) ? '***' : '');
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

export function toPublicEngine(engine: StoredKvCacheEngine): KvCacheEngine {
  const { scrapeAuthHeader, scrapeAuthEncrypted: _encrypted, ...rest } = engine;
  return { ...rest, scrapeUrl: maskScrapeUrl(rest.scrapeUrl), hasScrapeAuth: scrapeAuthHeader !== null };
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
