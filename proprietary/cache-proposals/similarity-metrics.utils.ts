import type { TuningMetricsSnapshot } from './cache-readonly.types';

const DEFAULT_UNCERTAINTY_BAND = 0.05;

export interface SimilarityWindowResult {
  metrics: TuningMetricsSnapshot;
  hitCount: number;
  missCount: number;
}

/**
 * Read the similarity window ZSET for a given cache prefix and compute
 * hit-rate metrics.  Shared by the apply dispatcher (pre-adjustment snapshot)
 * and the outcome evaluator (post-adjustment comparison).
 *
 * @param sinceMs  When > 0, only entries scored after this timestamp are
 *                 included (ZRANGEBYSCORE).  Pass 0 to read the full window.
 */
export async function computeMetricsFromSimilarityWindow(
  client: any,
  prefix: string,
  threshold: number,
  sinceMs: number = 0,
): Promise<SimilarityWindowResult | null> {
  let raw: Array<string | number>;
  try {
    if (sinceMs > 0) {
      raw = (await client.zrangebyscore(
        `${prefix}:__similarity_window`, String(sinceMs), '+inf', 'WITHSCORES',
      )) as Array<string | number>;
    } else {
      raw = (await client.zrange(
        `${prefix}:__similarity_window`, '0', '-1', 'WITHSCORES',
      )) as Array<string | number>;
    }
  } catch {
    return null;
  }

  let uncertaintyBand = DEFAULT_UNCERTAINTY_BAND;
  try {
    const configRaw = await client.hget(`${prefix}:__config`, 'uncertainty_band');
    if (configRaw) {
      const parsed = Number(configRaw);
      if (Number.isFinite(parsed)) uncertaintyBand = parsed;
    }
  } catch { /* use default */ }

  const hits: number[] = [];
  const misses: number[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    const member = raw[i];
    if (typeof member !== 'string') continue;
    try {
      const entry = JSON.parse(member) as { score?: number; result?: string };
      const score = typeof entry.score === 'number' ? entry.score : NaN;
      if (!Number.isFinite(score)) continue;
      if (entry.result === 'hit') hits.push(score);
      else if (entry.result === 'miss') misses.push(score);
    } catch { /* skip */ }
  }

  const total = hits.length + misses.length;
  if (total === 0) return null;

  const hitRate = hits.length / total;
  const uncertainHitRate = hits.length === 0 ? 0
    : hits.filter((s) => s >= threshold - uncertaintyBand).length / hits.length;
  const midpoint = threshold / 2;
  const distantHitRate = hits.length === 0 ? 0
    : hits.filter((s) => s > midpoint).length / hits.length;
  const nearMissRate = misses.length === 0 ? 0
    : misses.filter((s) => s > threshold && s <= threshold + uncertaintyBand).length / misses.length;

  return {
    metrics: { hit_rate: hitRate, uncertain_hit_rate: uncertainHitRate, distant_hit_rate: distantHitRate, near_miss_rate: nearMissRate },
    hitCount: hits.length,
    missCount: misses.length,
  };
}
