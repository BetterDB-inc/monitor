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

/**
 * Weighted blend of semantic similarity, recency, and importance.
 * Recency is a true half-life decay: 0.5 at one halfLifeSeconds.
 */
export function compositeScore(params: CompositeScoreParams): number {
  const recency = Math.exp((-Math.LN2 * params.ageSeconds) / params.halfLifeSeconds);
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
