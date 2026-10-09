export type KvCacheLayout = 'two_key' | 'single_key' | 'mixed';
export type KvCacheEngineSource = 'scrape' | 'otlp';
export type KvCacheEvictionReason = 'unevictable' | 'evicting';

export interface KvCacheModelFootprint {
  model: string;
  dtype: string;
  chunksEst: number;
  bytesEst: number;
}

export interface KvCacheFootprintSnapshot {
  connectionId: string;
  timestamp: number;
  detected: boolean;
  layout: KvCacheLayout | null;
  scannedKeys: number;
  matchedKeys: number;
  sampledKeys: number;
  scanComplete: boolean;
  chunksEst: number;
  bytesEst: number;
  usedMemory: number;
  maxmemory: number;
  maxmemoryPolicy: string;
  lmcacheMemoryShare: number;
  noTtlRatio: number;
  orphanRatio: number | null;
  evictedKeysDelta: number | null;
  otherDbs: number[];
  perModel: KvCacheModelFootprint[];
}

export interface KvCacheEngine {
  id: string;
  connectionId: string;
  name: string;
  source: KvCacheEngineSource;
  scrapeUrl: string | null;
  hasScrapeAuth: boolean;
  otlpEngineId: string | null;
  enabled: boolean;
  createdAt: number;
  lastSeenAt: number | null;
  lastError: string | null;
}

export interface KvCacheEngineCreate {
  name: string;
  source: KvCacheEngineSource;
  scrapeUrl?: string;
  scrapeAuthHeader?: string;
  otlpEngineId?: string;
  enabled?: boolean;
}

export interface KvCacheEngineUpdate {
  name?: string;
  scrapeUrl?: string;
  scrapeAuthHeader?: string | null;
  enabled?: boolean;
}

export interface KvCacheSampleCounters {
  requestedTokens: number;
  hitTokens: number;
  lookupTokens: number;
  lookupHits: number;
  remoteReadBytes: number;
  remoteWriteBytes: number;
  remoteReadRequests: number;
  remoteWriteRequests: number;
  remotePingErrors: number;
}

export interface KvCacheEngineSample extends KvCacheSampleCounters {
  engineId: string;
  connectionId: string;
  modelName: string;
  timestamp: number;
}

export interface KvCacheSampleBucket extends KvCacheEngineSample {
  hitRate: number | null;
}

export interface KvCacheSamplesResponse {
  buckets: KvCacheSampleBucket[];
  rangeHitRate: number | null;
}

export interface KvCacheStatus {
  hasLmcache: boolean;
  latest: KvCacheFootprintSnapshot | null;
  sampleKey: string | null;
  engines: KvCacheEngine[];
}

export interface KvCacheSettings {
  connectionId: string;
  hitRateAlertEnabled: boolean;
  hitRateThreshold: number;
  evictionAlertEnabled: boolean;
  updatedAt: number;
}

export interface KvCacheSettingsUpdate {
  hitRateAlertEnabled?: boolean;
  hitRateThreshold?: number;
  evictionAlertEnabled?: boolean;
}

export interface KvCacheHitRateLowData {
  connectionId: string;
  engineId: string;
  engineName: string;
  model: string;
  hitRate: number;
  threshold: number;
  requestedTokens: number;
  windowMs: number;
  timestamp: number;
  instance?: { host: string; port: number };
}

export interface KvCacheEvictionRiskData {
  connectionId: string;
  reason: KvCacheEvictionReason;
  active: boolean;
  policy: string;
  usedMemory: number;
  maxmemory: number;
  lmcacheMemoryShare: number;
  noTtlRatio: number;
  evictedKeysDelta: number | null;
  timestamp: number;
  instance?: { host: string; port: number };
}

export const DEFAULT_KV_CACHE_HIT_RATE_THRESHOLD = 0.2;
export const MAX_KV_CACHE_HIT_RATE_THRESHOLD = 0.9;
export const KV_CACHE_HIT_RATE_WINDOW_MS = 15 * 60_000;
export const KV_CACHE_HIT_RATE_MIN_TOKENS = 10_000;
