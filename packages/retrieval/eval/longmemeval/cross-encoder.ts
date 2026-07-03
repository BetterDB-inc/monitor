import type { QueryHit, RerankFn } from '../../src/index';
import { chat } from './reader';

const SCORER_MODEL = process.env.LONGMEMEVAL_RERANK_MODEL ?? 'gpt-5.4';
// Chunks run up to ~6000 tokens (adapter.ts); scoring a whole 30–50 doc pool in
// one prompt can blow past the context limit and 400 the entire run. Flatten
// and cap each passage, and score the pool in bounded batches instead.
const PASSAGE_CHAR_BUDGET = 2000;
export const SCORER_BATCH_SIZE = 20;

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
// numbers. Any malformed, partial, or non-numeric reply degrades to all-zeros:
// zero-filling only the missing tail would silently demote trailing passages,
// while all-equal scores let the stable sort keep the incumbent hybrid/KNN
// order for the whole batch.
export function parseScores(raw: string, count: number): number[] {
  const zeros = new Array(count).fill(0);
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) {
    return zeros;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return zeros;
  }
  if (!Array.isArray(parsed) || parsed.length !== count) {
    return zeros;
  }
  const everyNumeric = parsed.every((value) => {
    return typeof value === 'number' && Number.isFinite(value);
  });
  if (everyNumeric === false) {
    return zeros;
  }
  return parsed as number[];
}

// Multi-line chunks joined with bare newlines make passage boundaries ambiguous
// to the scorer (miscounts misalign every score after them). One passage = one
// prompt line, capped to the budget.
function renderPassage(document: string): string {
  const flattened = document.replace(/\s+/g, ' ').trim();
  if (flattened.length <= PASSAGE_CHAR_BUDGET) {
    return flattened;
  }
  return `${flattened.slice(0, PASSAGE_CHAR_BUDGET)}…`;
}

export function createOpenAICrossEncoderScorer(
  apiKey: string,
  chatFn: typeof chat = chat,
): CrossEncoderScorer {
  const system =
    'You score passage relevance for a query. Given a query and a numbered list ' +
    'of passages, return ONLY a JSON array of floats in [0,1], one per passage in ' +
    'order, where higher means more useful for answering the query.';
  return async (query, documents) => {
    const scores: number[] = [];
    for (let offset = 0; offset < documents.length; offset += SCORER_BATCH_SIZE) {
      const batch = documents.slice(offset, offset + SCORER_BATCH_SIZE);
      const user = `Query: ${query}\n\nPassages:\n${batch
        .map((document, index) => `[${index}] ${renderPassage(document)}`)
        .join('\n')}`;
      const reply = await chatFn(apiKey, SCORER_MODEL, system, user);
      scores.push(...parseScores(reply, batch.length));
    }
    return scores;
  };
}
