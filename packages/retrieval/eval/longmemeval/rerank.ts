import type { QueryHit, RerankFn } from '../../src/index';

// Mirrors the semantic-cache hybrid scorer (packages/semantic-cache/src/rerank.ts):
// blend dense cosine similarity with lexical keyword overlap so exact-term
// matches the embedding under-ranks get pulled up. Dense recall finds the
// topically-near chunks; the overlap term rewards literal token hits (names,
// dates, IDs) the question shares with the chunk.
const COSINE_WEIGHT = 0.7;
const OVERLAP_WEIGHT = 1 - COSINE_WEIGHT;

/** Lowercase, split on whitespace, strip surrounding punctuation, dedupe. */
export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().split(/\s+/)) {
    const token = raw.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
    if (token.length > 0) tokens.add(token);
  }
  return tokens;
}

/** Fraction of the query's tokens that also appear in the candidate text. */
function overlap(queryTokens: Set<string>, text: string): number {
  if (queryTokens.size === 0) return 0;
  const hitTokens = tokenize(text);
  let shared = 0;
  for (const token of queryTokens) {
    if (hitTokens.has(token)) shared++;
  }
  return shared / queryTokens.size;
}

/**
 * Hybrid (dense + lexical) reranker in the retrieval RerankFn shape: reorders
 * the candidate pool by a blended score. QueryHit.score is a cosine DISTANCE
 * (lower = closer), so dense similarity is `1 - score`. The caller over-fetches
 * a wider pool, this reorders it, then the runner slices back to k.
 */
export function createHybridRerank(cosineWeight = COSINE_WEIGHT): RerankFn {
  const overlapWeight = 1 - cosineWeight;
  return async (queryText: string, hits: QueryHit[]): Promise<QueryHit[]> => {
    const queryTokens = tokenize(queryText);
    const scored = hits.map((hit) => ({
      hit,
      score: cosineWeight * (1 - hit.score) + overlapWeight * overlap(queryTokens, hit.text),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.hit);
  };
}
