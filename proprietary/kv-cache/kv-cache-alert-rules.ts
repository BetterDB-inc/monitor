import {
  KV_CACHE_HIT_RATE_MIN_TOKENS,
  type KvCacheEngineSample,
  type KvCacheEvictionReason,
  type KvCacheFootprintSnapshot,
  type KvCacheSettings,
} from '@betterdb/shared';
import { hitRate } from './kv-cache-samples.service';

export interface HitRateWindow {
  engineId: string;
  model: string;
  requestedTokens: number;
  hitTokens: number;
  hitRate: number | null;
}

export function windowHitRates(samples: KvCacheEngineSample[]): HitRateWindow[] {
  const windows = new Map<string, HitRateWindow>();
  for (const s of samples) {
    const id = `${s.engineId}|${s.modelName}`;
    const w = windows.get(id) ?? { engineId: s.engineId, model: s.modelName, requestedTokens: 0, hitTokens: 0, hitRate: null };
    w.requestedTokens += s.requestedTokens;
    w.hitTokens += s.hitTokens;
    windows.set(id, w);
  }
  return [...windows.values()]
    .map((w) => ({ ...w, hitRate: hitRate(w.requestedTokens, w.hitTokens) }))
    .sort((a, b) => a.engineId.localeCompare(b.engineId) || a.model.localeCompare(b.model));
}

export function shouldCheckHitRate(window: HitRateWindow, settings: KvCacheSettings): boolean {
  return settings.hitRateAlertEnabled && window.hitRate !== null && window.requestedTokens >= KV_CACHE_HIT_RATE_MIN_TOKENS;
}

export function evictionConditions(s: KvCacheFootprintSnapshot): Record<KvCacheEvictionReason, boolean> {
  return {
    unevictable: s.detected && s.maxmemoryPolicy.startsWith('volatile-') && s.noTtlRatio >= 0.9,
    evicting:
      s.detected &&
      (s.evictedKeysDelta ?? 0) > 0 &&
      s.maxmemory > 0 &&
      s.usedMemory / s.maxmemory >= 0.9 &&
      s.lmcacheMemoryShare >= 0.5,
  };
}
