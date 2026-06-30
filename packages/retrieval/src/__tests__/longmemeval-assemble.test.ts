import { describe, it, expect } from 'vitest';
import type { QueryHit } from '../index';
import { assembleContexts } from '../../eval/longmemeval/assemble';
import { createMockEmbedder } from '../../eval/longmemeval/embed';
import { createMockStore } from '../../eval/longmemeval/store';
import { createMockJudge } from '../../eval/longmemeval/judge';
import { loadFixture } from '../../eval/longmemeval/dataset';
import { runEval } from '../../eval/longmemeval/runner';
import { createCostReport } from '../../eval/longmemeval/levers';
import type { Reader } from '../../eval/longmemeval/types';

const hit = (id: string, text: string, session_id: string, date: string, score = 0): QueryHit => ({
  id,
  text,
  score,
  fields: { session_id, date },
});

describe('assembleContexts', () => {
  it('orders a single session chronologically and prefixes the date', () => {
    const hits = [hit('b', 'second', 's1', '2026-02-01'), hit('a', 'first', 's1', '2026-01-01')];
    expect(assembleContexts(hits, 10)).toEqual(['[2026-01-01] first', '[2026-02-01] second']);
  });

  it('keeps each session contiguous when sessions share a date and interleave in rank order', () => {
    const hits = [
      hit('s1a', 'alpha-1', 's1', '2026-01-01'),
      hit('s2a', 'beta-1', 's2', '2026-01-01'),
      hit('s1b', 'alpha-2', 's1', '2026-01-01'),
      hit('s2b', 'beta-2', 's2', '2026-01-01'),
    ];
    expect(assembleContexts(hits, 10)).toEqual([
      '[2026-01-01] alpha-1',
      '[2026-01-01] alpha-2',
      '[2026-01-01] beta-1',
      '[2026-01-01] beta-2',
    ]);
  });

  it('orders sessions chronologically by their earliest date, not rank order', () => {
    const hits = [
      hit('late', 'march', 's_late', '2026-03-01'),
      hit('early', 'january', 's_early', '2026-01-01'),
    ];
    expect(assembleContexts(hits, 10)).toEqual(['[2026-01-01] january', '[2026-03-01] march']);
  });

  it('drops near-duplicate chunks, keeping the higher-ranked one', () => {
    const hits = [
      hit('dupA', 'the quick brown fox jumps', 's1', '2026-01-01', 0.1),
      hit('dupB', 'the quick brown fox jumps over', 's1', '2026-01-01', 0.3),
      hit('other', 'completely unrelated zebra content here', 's1', '2026-01-01', 0.2),
    ];
    const out = assembleContexts(hits, 10);
    expect(out).toHaveLength(2);
    expect(out).toContain('[2026-01-01] the quick brown fox jumps');
    expect(out).toContain('[2026-01-01] completely unrelated zebra content here');
    expect(out).not.toContain('[2026-01-01] the quick brown fox jumps over');
  });

  it('uses MMR to fill k slots with diverse hits, not near-identical clusters', () => {
    const hits = [
      hit('cat1', 'my cat loves tuna fish snacks', 's1', '2026-01-01', 0.1),
      hit('cat2', 'my cat enjoys tuna fish treats', 's2', '2026-01-02', 0.12),
      hit('cat3', 'my cat adores tuna fish meals', 's3', '2026-01-03', 0.14),
      hit('fin', 'quarterly revenue grew eighteen percent', 's4', '2026-01-04', 0.2),
    ];
    const out = assembleContexts(hits, 2, { mmrLambda: 0.5 });
    expect(out).toHaveLength(2);
    expect(out.some((c) => c.includes('cat loves tuna'))).toBe(true);
    expect(out.some((c) => c.includes('revenue grew'))).toBe(true);
  });

  it('respects the incoming pool order (rerank) over raw vector distance', () => {
    // Array order is the rerank order (best first); .score is raw vector
    // distance. Here the rerank-best hit (first) has a WORSE distance than its
    // near-duplicate, so a distance-based dedup would wrongly keep the latter.
    const hits = [
      hit('A', 'the quick brown fox jumps high', 's1', '2026-01-01', 0.3),
      hit('B', 'the quick brown fox jumps', 's1', '2026-01-01', 0.1),
    ];
    expect(assembleContexts(hits, 1)).toEqual(['[2026-01-01] the quick brown fox jumps high']);
  });
});

function spyReader(): { reader: Reader; calls: string[][] } {
  const calls: string[][] = [];
  const reader: Reader = {
    name: 'spy',
    answer: async (_question, contexts) => {
      calls.push(contexts);
      return contexts[0] ?? '';
    },
  };
  return { reader, calls };
}

function leadingDates(contexts: string[]): string[] {
  return contexts
    .map((c) => /^\[([^\]]+)\]/.exec(c)?.[1])
    .filter((d): d is string => d !== undefined);
}

describe('assemble lever integration', () => {
  it('feeds the reader chronologically-assembled contexts and records a zero-cost entry', async () => {
    const { reader, calls } = spyReader();
    const costReport = createCostReport();
    const summary = await runEval({
      records: await loadFixture(),
      embedder: createMockEmbedder(),
      store: createMockStore(),
      reader,
      judge: createMockJudge(),
      k: 2,
      chunkMode: 'session',
      limit: 20,
      rerankPool: 2,
      levers: ['assemble'],
      costReport,
    });

    expect(summary.levers).toEqual(['assemble']);
    const assembleCost = summary.costs.find((c) => c.name === 'assemble');
    expect(assembleCost).toBeDefined();
    expect(assembleCost?.embedCalls).toBe(0);
    expect(assembleCost?.llmCalls).toBe(0);

    expect(calls.length).toBeGreaterThan(0);
    for (const contexts of calls) {
      const dates = leadingDates(contexts);
      expect(dates).toEqual([...dates].sort());
    }
  });
});
