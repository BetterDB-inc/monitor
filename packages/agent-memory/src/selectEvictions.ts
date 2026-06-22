import { recencyDecay, type RecallWeights } from './compositeScore';

export interface EvictionCandidate {
  key: string;
  importance: number;
  lastAccessedAt: number;
}

export interface SelectEvictionsOptions {
  now: number;
  halfLifeSeconds: number;
  weights: RecallWeights;
}

function evictionScore(candidate: EvictionCandidate, options: SelectEvictionsOptions): number {
  const { weights } = options;
  const denom = weights.importance + weights.recency;
  if (denom === 0) {
    return 0;
  }
  const ageSeconds = (options.now - candidate.lastAccessedAt) / 1000;
  const recency = recencyDecay(ageSeconds, options.halfLifeSeconds);
  return (weights.importance * candidate.importance + weights.recency * recency) / denom;
}

/**
 * Pick the keys to evict so that `maxItems` remain. Eviction blends importance
 * with last-access recency (the recall weights, minus similarity, renormalized);
 * lowest-scoring keys go first, ties broken toward the older last-access.
 */
export function selectEvictions(
  candidates: EvictionCandidate[],
  maxItems: number,
  options: SelectEvictionsOptions,
): string[] {
  const dropCount = candidates.length - Math.max(0, maxItems);
  if (dropCount <= 0) {
    return [];
  }
  const ranked = candidates
    .map((candidate) => ({
      key: candidate.key,
      score: evictionScore(candidate, options),
      lastAccessedAt: candidate.lastAccessedAt,
    }))
    .sort((a, b) =>
      a.score !== b.score ? a.score - b.score : a.lastAccessedAt - b.lastAccessedAt,
    );
  return ranked.slice(0, dropCount).map((entry) => entry.key);
}
