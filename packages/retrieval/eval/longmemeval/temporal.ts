import type { QueryHit } from '../../src/index';

export interface TemporalOptions {
  asOf?: string;
}

function applyAsOf(hits: QueryHit[], asOf: string | undefined): QueryHit[] {
  if (asOf === undefined || asOf === '') {
    return hits;
  }
  const kept = hits.filter((hit) => {
    const date = hit.fields.date;
    return date === undefined || date <= asOf;
  });
  return kept.length > 0 ? kept : hits;
}

// As-of filter ONLY: drop chunks dated after the question, preserving the
// incoming rerank order. An earlier version also re-sorted survivors
// newest-first, but that fed a recency-ordered pool into the assembler's
// position-based relevance and regressed QA on LongMemEval-M — ordering is left
// to the rerank / assembler stages.
export function resolveTemporal(hits: QueryHit[], options: TemporalOptions = {}): QueryHit[] {
  return applyAsOf(hits, options.asOf);
}
