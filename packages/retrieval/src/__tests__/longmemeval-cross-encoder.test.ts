import { describe, it, expect } from 'vitest';
import type { QueryHit } from '../index';
import {
  createCrossEncoderRerank,
  createOpenAICrossEncoderScorer,
  parseScores,
} from '../../eval/longmemeval/cross-encoder';
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
  it('parses a complete numeric JSON array', () => {
    expect(parseScores('[0.9, 0.1, 0.5]', 3)).toEqual([0.9, 0.1, 0.5]);
  });

  it('returns all zeros on malformed output instead of throwing', () => {
    expect(parseScores('scores: [0.9, ', 2)).toEqual([0, 0]);
    expect(parseScores('no array here', 2)).toEqual([0, 0]);
  });

  it('degrades a partial or non-numeric reply to all zeros so the incumbent order survives', () => {
    // Zero-filling only the tail would silently demote trailing passages; a
    // stable sort over all-equal scores keeps the hybrid/KNN order instead.
    expect(parseScores('[0.9, 0.8]', 4)).toEqual([0, 0, 0, 0]);
    expect(parseScores('[0.9, "x", 0.1]', 3)).toEqual([0, 0, 0]);
    expect(parseScores('[0.9, 0.8, 0.7, 0.6]', 3)).toEqual([0, 0, 0]);
  });
});

describe('createOpenAICrossEncoderScorer', () => {
  const countPassages = (prompt: string): number => {
    return (prompt.match(/^\[\d+\] /gm) ?? []).length;
  };

  it('batches large pools into multiple calls and concatenates scores in order', async () => {
    const prompts: string[] = [];
    const chatFn = async (
      _apiKey: string,
      _model: string,
      _system: string,
      user: string,
    ): Promise<string> => {
      prompts.push(user);
      const count = countPassages(user);
      return JSON.stringify(
        Array.from({ length: count }, (_, index) => {
          return (prompts.length * 100 + index) / 10_000;
        }),
      );
    };
    const scorer = createOpenAICrossEncoderScorer('key', chatFn);

    const documents = Array.from({ length: 25 }, (_, index) => `document ${index}`);
    const scores = await scorer('the query', documents);

    expect(prompts.length).toBeGreaterThan(1);
    expect(scores).toHaveLength(25);
    expect(scores[0]).toBeCloseTo(0.01);
    const lastBatchFirstScore = (prompts.length * 100) / 10_000;
    expect(scores[24]).toBeGreaterThanOrEqual(lastBatchFirstScore);
  });

  it('flattens multi-line passages and truncates them to the prompt budget', async () => {
    const prompts: string[] = [];
    const chatFn = async (
      _apiKey: string,
      _model: string,
      _system: string,
      user: string,
    ): Promise<string> => {
      prompts.push(user);
      return JSON.stringify(new Array(countPassages(user)).fill(0.5));
    };
    const scorer = createOpenAICrossEncoderScorer('key', chatFn);

    const longDocument = `first line\nsecond line\n${'word '.repeat(2000)}`;
    const scores = await scorer('q', [longDocument, 'short doc']);

    expect(scores).toHaveLength(2);
    expect(prompts).toHaveLength(1);
    expect(countPassages(prompts[0])).toBe(2);
    const lines = prompts[0].split('\n').filter((line) => {
      return /^\[\d+\] /.test(line);
    });
    expect(lines).toHaveLength(2);
    expect(lines[0].length).toBeLessThanOrEqual(2100);
  });
});

describe('rerank-cross misconfiguration', () => {
  it('rejects a run where the lever is on but no scorer seam is provided', async () => {
    // Without the guard this silently falls back to the hybrid reranker (or
    // plain top-k when the pool equals k) while the summary reports the
    // rerank-cross lever as enabled with zero cost — a false ablation point.
    await expect(
      runEval({
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
      }),
    ).rejects.toThrow(/rerank-cross/);
    await expect(
      runEval({
        records: await loadFixture(),
        embedder: createMockEmbedder(),
        store: createMockStore(),
        reader: null,
        judge: null,
        k: 2,
        chunkMode: 'session',
        limit: 20,
        rerankPool: 2,
        levers: ['rerank-cross'],
      }),
    ).rejects.toThrow(/rerank-cross/);
  });

  it('rejects a run where the lever is on but the pool never exceeds k', async () => {
    await expect(
      runEval({
        records: await loadFixture(),
        embedder: createMockEmbedder(),
        store: createMockStore(),
        reader: null,
        judge: null,
        k: 2,
        chunkMode: 'session',
        limit: 20,
        rerankPool: 2,
        levers: ['rerank-cross'],
        crossEncoderScorer: overlapScorer,
      }),
    ).rejects.toThrow(/rerank-cross/);
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
