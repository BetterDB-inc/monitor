export interface RecallWeights {
  similarity: number;
  recency: number;
  importance: number;
}

export interface CompositeScoreParams {
  similarity: number; // 0..1, mapped from cosine distance
  ageSeconds: number;
  importance: number; // 0..1
  weights: RecallWeights;
  halfLifeSeconds: number;
}

/** True half-life decay: 1 at age 0, 0.5 at one halfLifeSeconds, approaching 0 beyond. */
export function recencyDecay(ageSeconds: number, halfLifeSeconds: number): number {
  return Math.exp((-Math.LN2 * ageSeconds) / halfLifeSeconds);
}

/**
 * Weighted blend of semantic similarity, recency, and importance.
 * Recency is a true half-life decay: 0.5 at one halfLifeSeconds.
 */
export function compositeScore(params: CompositeScoreParams): number {
  const recency = recencyDecay(params.ageSeconds, params.halfLifeSeconds);
  return (
    params.weights.similarity * params.similarity +
    params.weights.recency * recency +
    params.weights.importance * params.importance
  );
}

/** Map cosine distance (0..2, lower = closer) to a 0..1 similarity score. */
export function similarityFromDistance(distance: number): number {
  return 1 - distance / 2;
}
