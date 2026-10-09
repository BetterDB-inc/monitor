import type { DropReason, OtlpMetric } from './otlp-metrics-types';

export const KV_CACHE_OTLP_SINK = Symbol('KV_CACHE_OTLP_SINK');
export const LMCACHE_ENGINE_ATTRIBUTE = 'betterdb.lmcache.engine';

export interface KvCacheOtlpSinkResult {
  accepted: number;
  dropped: Partial<Record<DropReason, number>>;
}

export interface KvCacheOtlpSink {
  ingest(resourceAttributes: Record<string, string>, metrics: OtlpMetric[], nowMs: number): KvCacheOtlpSinkResult;
}

export function isKvCacheResource(resourceAttributes: Record<string, string>, metrics: OtlpMetric[]): boolean {
  if (resourceAttributes[LMCACHE_ENGINE_ATTRIBUTE] !== undefined) return true;
  return metrics.length > 0 && metrics.every((metric) => (metric.name ?? '').startsWith('lmcache:'));
}
