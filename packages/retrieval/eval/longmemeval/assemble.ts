import type { QueryHit } from '../../src/index';
import { tokenize } from './rerank';

const DEFAULT_DEDUP_THRESHOLD = 0.9;
const DEFAULT_MMR_LAMBDA = 0.5;

export interface AssembleOptions {
  dedupThreshold?: number;
  mmrLambda?: number;
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
  const kept: QueryHit[] = [];
  const keptTokens: Set<string>[] = [];
  for (const hit of [...hits].sort((a, b) => a.score - b.score)) {
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
  const pool = hits
    .map((hit) => ({ hit, tokens: tokenize(hit.text) }))
    .sort((a, b) => a.hit.score - b.hit.score);
  const selected: { hit: QueryHit; tokens: Set<string> }[] = [];

  while (selected.length < k && pool.length > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const candidate = pool[i];
      const relevance = 1 - candidate.hit.score;
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

export function assembleContexts(
  hits: QueryHit[],
  k: number,
  options: AssembleOptions = {},
): string[] {
  const dedupThreshold = options.dedupThreshold ?? DEFAULT_DEDUP_THRESHOLD;
  const mmrLambda = options.mmrLambda ?? DEFAULT_MMR_LAMBDA;

  const deduped = dedupe(hits, dedupThreshold);
  const selected = mmrSelect(deduped, k, mmrLambda);
  const sessions = [...groupBySession(selected).values()]
    .map((group) => [...group].sort(byDate))
    .sort((a, b) => byDate(a[0], b[0]));

  const ordered: QueryHit[] = [];
  for (const session of sessions) {
    for (const hit of session) {
      ordered.push(hit);
    }
  }
  return ordered.map(renderContext);
}
