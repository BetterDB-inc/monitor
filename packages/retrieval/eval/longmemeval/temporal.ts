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

export function resolveTemporal(hits: QueryHit[], options: TemporalOptions = {}): QueryHit[] {
  const scoped = applyAsOf(hits, options.asOf);
  return [...scoped].sort((a, b) => {
    return (b.fields.date ?? '').localeCompare(a.fields.date ?? '');
  });
}
