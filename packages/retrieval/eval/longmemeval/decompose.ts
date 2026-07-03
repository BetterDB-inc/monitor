import type { QueryHit } from '../../src/index';
import { chat, DEFAULT_CHAT_MODEL } from './reader';
import { extractJsonArray } from './json';

const DECOMPOSE_MODEL = process.env.LONGMEMEVAL_DECOMPOSE_MODEL ?? DEFAULT_CHAT_MODEL;

// Decomposes a multi-hop question into sub-queries — an LLM seam. The original
// question is always retrieved too; these are the extra hops.
export type QueryDecomposer = (question: string) => Promise<string[]>;

// Offline deterministic decomposer: split on " and ", otherwise no sub-queries.
export function createMockDecomposer(): QueryDecomposer {
  return async (question) => {
    const parts = question
      .split(/\s+and\s+/i)
      .map((part) => {
        return part.trim();
      })
      .filter((part) => {
        return part.length > 0;
      });
    return parts.length > 1 ? parts : [];
  };
}

export function parseSubQueries(raw: string): string[] {
  const parsed = extractJsonArray(raw);
  if (parsed === null) {
    return [];
  }
  return parsed.filter((item): item is string => {
    return typeof item === 'string';
  });
}

export function createOpenAIDecomposer(apiKey: string): QueryDecomposer {
  const system =
    'Decompose a multi-hop question into 1-3 focused sub-questions, each aimed at ' +
    'retrieving one piece of evidence. Return ONLY a JSON array of strings. If the ' +
    'question is already single-hop, return [].';
  return async (question) => {
    const reply = await chat(apiKey, DECOMPOSE_MODEL, system, question);
    return parseSubQueries(reply);
  };
}

// Reciprocal Rank Fusion constant — dampens the contribution of lower ranks so
// a hit's position across queries matters more than its absolute rank.
const RRF_K = 60;

// Merge per-query ranked hit lists by Reciprocal Rank Fusion: each hit scores
// sum(1 / (RRF_K + rank)) across the queries it appears in, so evidence a
// sub-query surfaces competes with the primary query's hits (a plain
// concatenate-then-truncate would drop it once the primary fills the cap), and
// hits corroborated across queries are boosted.
export function mergeHits(perQueryHits: QueryHit[][], limit: number): QueryHit[] {
  const scoreById = new Map<string, number>();
  const hitById = new Map<string, QueryHit>();
  for (const hits of perQueryHits) {
    hits.forEach((hit, rank) => {
      scoreById.set(hit.id, (scoreById.get(hit.id) ?? 0) + 1 / (RRF_K + rank));
      if (hitById.has(hit.id) === false) {
        hitById.set(hit.id, hit);
      }
    });
  }
  return [...hitById.values()]
    .sort((a, b) => (scoreById.get(b.id) ?? 0) - (scoreById.get(a.id) ?? 0))
    .slice(0, limit);
}
