import { Inject, Injectable } from '@nestjs/common';
import { maskUrlCredentials, type KvCacheEngine, type KvCacheFootprintSnapshot, type KvCacheStatus } from '@betterdb/shared';
import type { StoragePort, StoredKvCacheEngine } from '@app/common/interfaces/storage-port.interface';
import { KvCacheEngineRegistry } from './kv-cache-engine-registry';
import { KvCacheFootprintService } from './kv-cache-footprint.service';

export const FOOTPRINT_HISTORY_MAX_RANGE_MS = 31 * 24 * 60 * 60_000;
export const FOOTPRINT_HISTORY_POINTS = 1000;

function maskQueryValues(url: string): string {
  const base = url.split('#')[0];
  const queryStart = base.indexOf('?');
  if (queryStart < 0) return base;
  const query = base
    .slice(queryStart + 1)
    .split('&')
    .map((part) => {
      const eq = part.indexOf('=');
      return eq < 0 || eq === part.length - 1 ? part : `${part.slice(0, eq)}=***`;
    })
    .join('&');
  return `${base.slice(0, queryStart)}?${query}`;
}

export function toPublicEngine(engine: StoredKvCacheEngine): KvCacheEngine {
  const { scrapeAuthHeader, scrapeAuthEncrypted: _encrypted, ...rest } = engine;
  return {
    ...rest,
    scrapeUrl: rest.scrapeUrl === null ? null : maskQueryValues(maskUrlCredentials(rest.scrapeUrl)),
    hasScrapeAuth: scrapeAuthHeader !== null,
  };
}

@Injectable()
export class KvCacheStatusService {
  constructor(
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    private readonly footprint: KvCacheFootprintService,
    private readonly engines: KvCacheEngineRegistry,
  ) {}

  async getStatus(connectionId: string): Promise<KvCacheStatus> {
    const recent = await this.storage.getKvCacheFootprintSnapshots({ connectionId, limit: 2 });
    const latest = recent[recent.length - 1];
    const attempt = this.footprint.getLastScanAttempt(connectionId);
    return {
      hasLmcache: latest?.detected === true,
      latest: latest ?? null,
      recent,
      footprintIntervalMs: this.footprint.getFootprintIntervalMs(),
      sampleKey: this.footprint.getSampleKey(connectionId),
      engines: this.engines.list(connectionId).map(toPublicEngine),
      lastScanAttemptAt: attempt?.at ?? null,
      lastScanError: attempt?.error ?? null,
      scanCooldownUntil: this.footprint.getScanCooldownUntil(connectionId),
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
