import { describe, it, expect } from 'vitest';
import type { QueryHit } from '../index';
import { createCrossEncoderRerank, parseScores } from '../../eval/longmemeval/cross-encoder';
import type { CrossEncoderScorer } from '../../eval/longmemeval/cross-encoder';
import { createMockEmbedder } from '../../eval/longmemeval/embed';
import { createMockStore } from '../../eval/longmemeval/store';
import { loadFixture } from '../../eval/longmemeval/dataset';
import { runEval } from '../../eval/longmemeval/runner';
import { createCostReport } from '../../eval/longmemeval/levers';

const overlapScorer: CrossEncoderScorer = async (query, documents) => {
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

const hit = (id: string, text: string): QueryHit => ({
  id,
  text,
  score: 0,
  fields: { session_id: id },
});

describe('createCrossEncoderRerank', () => {
  it('reorders hits by cross-encoder score, highest first', async () => {
    const hits = [hit('a', 'alpha'), hit('b', 'beta'), hit('c', 'gamma')];
    const scores: Record<string, number> = { alpha: 0.1, beta: 0.9, gamma: 0.5 };
    const rerank = createCrossEncoderRerank(async (_q, docs) => docs.map((d) => scores[d] ?? 0));

    const out = await rerank('q', hits);
    expect(out.map((h) => h.id)).toEqual(['b', 'c', 'a']);
  });

  it('keeps ties in input order and sorts missing scores last', async () => {
    const hits = [hit('a', 'x'), hit('b', 'y'), hit('c', 'z'), hit('d', 'w')];
    // Only three scores for four docs: d is unscored and must sort last; a and c
    // tie at 0.5 and must keep their input order.
    const rerank = createCrossEncoderRerank(async () => [0.5, 0.9, 0.5]);

    const out = await rerank('q', hits);
    expect(out.map((h) => h.id)).toEqual(['b', 'a', 'c', 'd']);
  });
});

describe('parseScores', () => {
  it('parses a JSON array to exactly count numbers, padding non-numbers with 0', () => {
    expect(parseScores('[0.9, 0.1, "x"]', 3)).toEqual([0.9, 0.1, 0]);
  });

  it('returns all zeros on malformed output instead of throwing', () => {
    expect(parseScores('scores: [0.9, ', 2)).toEqual([0, 0]);
    expect(parseScores('no array here', 2)).toEqual([0, 0]);
  });
});

describe('rerank-cross lever integration', () => {
  it('reranks the pool with the cross-encoder behind the lever and records cost', async () => {
    const costReport = createCostReport();
    const summary = await runEval({
      records: await loadFixture(),
      embedder: createMockEmbedder(),
      store: createMockStore(),
      reader: null,
      judge: null,
      k: 2,
      chunkMode: 'session',
      limit: 20,
      rerankPool: 8,
      levers: ['rerank-cross'],
      costReport,
      crossEncoderScorer: overlapScorer,
    });

    expect(summary.levers).toEqual(['rerank-cross']);
    const cost = summary.costs.find((c) => c.name === 'rerank-cross');
    expect(cost?.llmCalls).toBeGreaterThan(0);
    expect(cost?.embedCalls).toBe(0);
    expect(summary.recallAtK).toBeGreaterThanOrEqual(0.75);
  });
});
