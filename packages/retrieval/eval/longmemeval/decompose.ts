import type { QueryHit } from '../../src/index';
import { chat } from './reader';

const DECOMPOSE_MODEL = process.env.LONGMEMEVAL_DECOMPOSE_MODEL ?? 'gpt-5.4';

// Decomposes a multi-hop question into sub-queries — an LLM seam. The original
// question is always retrieved too; these are the extra hops.
export type QueryDecomposer = (question: string) => Promise<string[]>;

// Offline deterministic decomposer: split on " and ", otherwise no sub-queries.
export function createMockDecomposer(): QueryDecomposer {
  return async (question) => {
    const parts = question
      .split(/\s+and\s+/i)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    return parts.length > 1 ? parts : [];
  };
}

export function parseSubQueries(raw: string): string[] {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((item): item is string => typeof item === 'string');
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

export function mergeHits(perQueryHits: QueryHit[][], limit: number): QueryHit[] {
  const seen = new Set<string>();
  const merged: QueryHit[] = [];
  for (const hits of perQueryHits) {
    for (const hit of hits) {
      if (seen.has(hit.id)) {
        continue;
      }
      seen.add(hit.id);
      merged.push(hit);
    }
  }
  return merged.slice(0, limit);
}
