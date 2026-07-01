import type { QueryHit, RerankFn } from '../../src/index';
import { chat } from './reader';

const SCORER_MODEL = process.env.LONGMEMEVAL_RERANK_MODEL ?? 'gpt-5.4';

// Batch-scores (query, document) pairs — a cross-encoder / reranker-model seam.
// One call scores the whole over-fetch pool for a query.
export type CrossEncoderScorer = (query: string, documents: string[]) => Promise<number[]>;

export function createCrossEncoderRerank(score: CrossEncoderScorer): RerankFn {
  return async (queryText: string, hits: QueryHit[]): Promise<QueryHit[]> => {
    const scores = await score(
      queryText,
      hits.map((hit) => hit.text),
    );
    return hits
      .map((hit, index) => ({ hit, score: scores[index] ?? -Infinity }))
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.hit);
  };
}

// Offline deterministic scorer: query-token overlap. Enough to exercise the
// rerank path without a model.
export function createMockCrossEncoderScorer(): CrossEncoderScorer {
  return async (query, documents) => {
    const queryTokens = new Set(query.toLowerCase().split(/\s+/));
    return documents.map((document) => {
      let shared = 0;
      for (const token of document.toLowerCase().split(/\s+/)) {
        if (queryTokens.has(token)) {
          shared++;
        }
      }
      return shared;
    });
  };
}

// Parse an LLM-returned JSON array of relevance scores into exactly `count`
// numbers. Degrades to all-zeros on malformed output rather than throwing.
export function parseScores(raw: string, count: number): number[] {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) {
    return new Array(count).fill(0);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return new Array(count).fill(0);
  }
  if (!Array.isArray(parsed)) {
    return new Array(count).fill(0);
  }
  return Array.from({ length: count }, (_, index) => {
    const value = parsed[index];
    return typeof value === 'number' ? value : 0;
  });
}

export function createOpenAICrossEncoderScorer(apiKey: string): CrossEncoderScorer {
  const system =
    'You score passage relevance for a query. Given a query and a numbered list ' +
    'of passages, return ONLY a JSON array of floats in [0,1], one per passage in ' +
    'order, where higher means more useful for answering the query.';
  return async (query, documents) => {
    const user = `Query: ${query}\n\nPassages:\n${documents
      .map((document, index) => `[${index}] ${document}`)
      .join('\n')}`;
    const reply = await chat(apiKey, SCORER_MODEL, system, user);
    return parseScores(reply, documents.length);
  };
}
