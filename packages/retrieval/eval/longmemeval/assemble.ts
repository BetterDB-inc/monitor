import type { QueryHit } from '../../src/index';
import { tokenize } from './rerank';

export interface AssembleOptions {
  // Structure features are OPT-IN. By default assembleContexts is relevance-first
  // and non-destructive: it keeps the rerank-ordered top-k and only prefixes the
  // date. On real LongMemEval-M, enabling dedup + MMR + chronological re-sort by
  // default regressed QA hard (evidence dropped/reordered before the reader), so
  // each structure feature is now behind its own flag for isolated A/B.
  dedupThreshold?: number;
  mmrLambda?: number;
  group?: boolean;
}

function envUnitFloat(value: string | undefined, min: number): number | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  const parsed = parseFloat(value);
  if (Number.isFinite(parsed) === false || parsed < min || parsed > 1) {
    return undefined;
  }
  return parsed;
}

// Env wiring for the opt-in structure features. Without any of these set, the
// assemble lever only date-prefixes the rerank-ordered top-k — enabling the
// flag alone is NOT a meaningful ablation point.
export function resolveAssembleOptions(env: Record<string, string | undefined>): AssembleOptions {
  const options: AssembleOptions = {};
  // A zero threshold is rejected, not clamped: containment is never negative,
  // so dedupe at 0 would mark every later hit a duplicate and collapse the
  // reader to a single context. MMR lambda 0 (pure diversity) stays valid.
  const dedupThreshold = envUnitFloat(env.LONGMEMEVAL_DEDUP_THRESHOLD, Number.EPSILON);
  if (dedupThreshold !== undefined) {
    options.dedupThreshold = dedupThreshold;
  }
  const mmrLambda = envUnitFloat(env.LONGMEMEVAL_MMR_LAMBDA, 0);
  if (mmrLambda !== undefined) {
    options.mmrLambda = mmrLambda;
  }
  if (env.LONGMEMEVAL_GROUP === '1' || env.LONGMEMEVAL_GROUP === 'true') {
    options.group = true;
  }
  return options;
}

function renderContext(hit: QueryHit): string {
  const date = hit.fields.date;
  return date ? `[${date}] ${hit.text}` : hit.text;
}

function containment(a: Set<string>, b: Set<string>): number {
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;
  if (smaller.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const token of smaller) {
    if (larger.has(token)) {
      shared++;
    }
  }
  return shared / smaller.size;
}

function dedupe(hits: QueryHit[], threshold: number): QueryHit[] {
  // Iterate in the given pool order, which is already best-first (hybrid rerank
  // when enabled, raw KNN distance otherwise). Re-sorting by QueryHit.score here
  // would discard the rerank order and keep the wrong near-duplicate.
  const kept: QueryHit[] = [];
  const keptTokens: Set<string>[] = [];
  for (const hit of hits) {
    const tokens = tokenize(hit.text);
    const isDuplicate = keptTokens.some((prior) => {
      return containment(tokens, prior) >= threshold;
    });
    if (!isDuplicate) {
      kept.push(hit);
      keptTokens.push(tokens);
    }
  }
  return kept;
}

function byDate(a: QueryHit, b: QueryHit): number {
  return (a.fields.date ?? '').localeCompare(b.fields.date ?? '');
}

function mmrSelect(hits: QueryHit[], k: number, lambda: number): QueryHit[] {
  // Relevance follows the incoming pool order (rerank order when enabled), not
  // QueryHit.score (raw vector distance) — using the latter would diverge from
  // the hybrid ranking. Earlier position => higher relevance.
  const pool = hits.map((hit, index) => ({
    hit,
    tokens: tokenize(hit.text),
    relevance: hits.length > 0 ? 1 - index / hits.length : 0,
  }));
  const selected: { hit: QueryHit; tokens: Set<string> }[] = [];

  while (selected.length < k && pool.length > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const candidate = pool[i];
      const relevance = candidate.relevance;
      let maxSimilarity = 0;
      for (const chosen of selected) {
        const similarity = containment(candidate.tokens, chosen.tokens);
        if (similarity > maxSimilarity) {
          maxSimilarity = similarity;
        }
      }
      const mmr = lambda * relevance - (1 - lambda) * maxSimilarity;
      if (mmr > bestScore) {
        bestScore = mmr;
        bestIndex = i;
      }
    }
    const [chosen] = pool.splice(bestIndex, 1);
    if (chosen !== undefined) {
      selected.push(chosen);
    }
  }
  return selected.map((entry) => entry.hit);
}

function groupBySession(hits: QueryHit[]): Map<string, QueryHit[]> {
  const groups = new Map<string, QueryHit[]>();
  for (const hit of hits) {
    const sessionId = hit.fields.session_id ?? '';
    const group = groups.get(sessionId);
    if (group === undefined) {
      groups.set(sessionId, [hit]);
    } else {
      group.push(hit);
    }
  }
  return groups;
}

function groupChronologically(hits: QueryHit[]): QueryHit[] {
  const sessions = [...groupBySession(hits).values()]
    .map((group) => {
      return [...group].sort(byDate);
    })
    .sort((a, b) => {
      return byDate(a[0], b[0]);
    });
  const ordered: QueryHit[] = [];
  for (const session of sessions) {
    for (const hit of session) {
      ordered.push(hit);
    }
  }
  return ordered;
}

export function assembleContexts(
  hits: QueryHit[],
  k: number,
  options: AssembleOptions = {},
): string[] {
  let selected = hits;
  if (options.dedupThreshold !== undefined) {
    selected = dedupe(selected, options.dedupThreshold);
  }
  if (options.mmrLambda !== undefined) {
    selected = mmrSelect(selected, k, options.mmrLambda);
  } else {
    selected = selected.slice(0, k);
  }
  if (options.group === true) {
    selected = groupChronologically(selected);
  }
  return selected.map(renderContext);
}
