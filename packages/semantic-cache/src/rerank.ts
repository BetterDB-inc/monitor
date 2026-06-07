/**
 * Built-in rerank factories for @betterdb/semantic-cache.
 */

/**
 * Tokenize: lowercase, split on whitespace, strip surrounding punctuation.
 * Deterministic and dependency-free.
 * IDF weighting would attach here at the token-weighting step.
 */
function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/\s+/)) {
    const tok = raw.replace(/^[.,!?;:"'()\[\]{}<>]+|[.,!?;:"'()\[\]{}<>]+$/g, '');
    if (tok) out.add(tok);
  }
  return out;
}

/**
 * Built-in keyword-overlap reranker.
 *
 * Blends cosine similarity with word overlap and returns the index of the
 * best candidate.
 *
 * @param compare
 *   `"prompt"`  – overlap of the incoming query against each candidate's stored
 *                 prompt. Equivalence signal. Catches entity mismatches
 *                 (e.g. "weather in Paris" vs "weather in Berlin"). Default.
 *   `"response"` – overlap of the incoming query against each candidate's cached
 *                 response. Relevance signal.
 *
 * @param cosineWeight
 *   Weight on cosine similarity in [0, 1]. Overlap weight is `1 - cosineWeight`.
 *   Default: 0.7 (overlap 0.3).
 *
 * Candidate objects carry: `similarity` (cosine distance, lower = more similar),
 * `response` (string), and `prompt` (string, stored prompt).
 */
export function createKeywordOverlapRerank(options?: {
  compare?: 'prompt' | 'response';
  cosineWeight?: number;
}): (query: string, candidates: Array<{ response: string; similarity: number; prompt: string }>) => Promise<number> {
  const compare = options?.compare ?? 'prompt';
  const cosineWeight = options?.cosineWeight ?? 0.7;
  if (cosineWeight < 0 || cosineWeight > 1) {
    throw new Error('cosineWeight must be in [0, 1]');
  }
  const overlapWeight = 1.0 - cosineWeight;

  return async (query: string, candidates: Array<{ response: string; similarity: number; prompt: string }>): Promise<number> => {
    const queryTokens = tokenize(query);
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < candidates.length; i++) {
      const text = candidates[i][compare] ?? '';
      const candTokens = tokenize(text);
      let overlap = 0;
      if (queryTokens.size > 0) {
        let intersection = 0;
        for (const t of queryTokens) {
          if (candTokens.has(t)) intersection++;
        }
        overlap = intersection / queryTokens.size;
      }
      const cosineSim = 1.0 - candidates[i].similarity;
      const score = cosineWeight * cosineSim + overlapWeight * overlap;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    return bestIdx;
  };
}
