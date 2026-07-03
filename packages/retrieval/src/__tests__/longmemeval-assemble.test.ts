import { describe, it, expect } from 'vitest';
import type { QueryHit } from '../index';
import { assembleContexts, resolveAssembleOptions } from '../../eval/longmemeval/assemble';
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

describe('assembleContexts (default: relevance-first, non-destructive)', () => {
  it('keeps the top-k in pool order without dedup, MMR, or re-sort, prefixing the date', () => {
    const hits = [
      hit('a', 'the quick brown fox jumps', 's2', '2026-03-01'),
      hit('b', 'the quick brown fox jumps over', 's1', '2026-01-01'),
      hit('c', 'unrelated zebra content', 's1', '2026-01-01'),
    ];
    // No dedup (b, a near-duplicate, both kept), no chronological re-sort (a's
    // later date does not move it), no dropping — just the rerank-ordered top-k.
    expect(assembleContexts(hits, 3)).toEqual([
      '[2026-03-01] the quick brown fox jumps',
      '[2026-01-01] the quick brown fox jumps over',
      '[2026-01-01] unrelated zebra content',
    ]);
  });

  it('truncates to k in pool order', () => {
    const hits = [
      hit('a', 'first', 's1', '2026-01-01'),
      hit('b', 'second', 's2', '2026-02-01'),
      hit('c', 'third', 's3', '2026-03-01'),
    ];
    expect(assembleContexts(hits, 2)).toEqual(['[2026-01-01] first', '[2026-02-01] second']);
  });

  it('renders hits without a date as bare text', () => {
    const hits: QueryHit[] = [{ id: 'a', text: 'no date', score: 0, fields: { session_id: 's1' } }];
    expect(assembleContexts(hits, 5)).toEqual(['no date']);
  });
});

describe('assembleContexts (opt-in structure)', () => {
  it('dedups near-duplicates only when dedupThreshold is set', () => {
    const hits = [
      hit('a', 'the quick brown fox jumps', 's1', '2026-01-01'),
      hit('b', 'the quick brown fox jumps over', 's1', '2026-01-01'),
      hit('c', 'unrelated zebra content here', 's1', '2026-01-01'),
    ];
    const out = assembleContexts(hits, 10, { dedupThreshold: 0.9 });
    expect(out).toEqual([
      '[2026-01-01] the quick brown fox jumps',
      '[2026-01-01] unrelated zebra content here',
    ]);
  });

  it('applies MMR diversity only when mmrLambda is set', () => {
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

  it('groups by session and orders chronologically only when group is set', () => {
    const hits = [
      hit('s2a', 'beta-1', 's2', '2026-03-01'),
      hit('s1a', 'alpha-1', 's1', '2026-01-01'),
      hit('s2b', 'beta-2', 's2', '2026-03-01'),
      hit('s1b', 'alpha-2', 's1', '2026-01-01'),
    ];
    expect(assembleContexts(hits, 10, { group: true })).toEqual([
      '[2026-01-01] alpha-1',
      '[2026-01-01] alpha-2',
      '[2026-03-01] beta-1',
      '[2026-03-01] beta-2',
    ]);
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

describe('assemble lever integration', () => {
  it('feeds the reader relevance-first contexts and records a zero-cost entry, no recall regression', async () => {
    const baseConfig = {
      embedder: createMockEmbedder(),
      store: createMockStore(),
      k: 2,
      chunkMode: 'session' as const,
      limit: 20,
      rerankPool: 2,
    };
    const baseline = await runEval({
      ...baseConfig,
      records: await loadFixture(),
      reader: null,
      judge: null,
    });

    const { reader, calls } = spyReader();
    const costReport = createCostReport();
    const withAssemble = await runEval({
      ...baseConfig,
      records: await loadFixture(),
      reader,
      judge: createMockJudge(),
      levers: ['assemble'],
      costReport,
    });

    expect(withAssemble.levers).toEqual(['assemble']);
    const cost = withAssemble.costs.find((c) => c.name === 'assemble');
    expect(cost?.embedCalls).toBe(0);
    expect(cost?.llmCalls).toBe(0);
    expect(calls.length).toBeGreaterThan(0);
    for (const contexts of calls) {
      expect(contexts.length).toBeLessThanOrEqual(2);
    }
    expect(withAssemble.recallAtK).toBeGreaterThanOrEqual(baseline.recallAtK);
  });

  it('threads assembleOptions through to the reader contexts', async () => {
    const { reader, calls } = spyReader();
    await runEval({
      records: await loadFixture(),
      embedder: createMockEmbedder(),
      store: createMockStore(),
      reader,
      judge: createMockJudge(),
      k: 3,
      chunkMode: 'session',
      limit: 20,
      rerankPool: 3,
      levers: ['assemble'],
      assembleOptions: { group: true },
    });

    expect(calls.length).toBeGreaterThan(0);
    for (const contexts of calls) {
      const dates = contexts.map((context) => {
        return (context.match(/^\[([^\]]*)\]/) ?? [])[1] ?? '';
      });
      expect([...dates].sort()).toEqual(dates);
    }
  });
});

describe('resolveAssembleOptions', () => {
  it('parses dedup threshold, MMR lambda, and group flag from the environment', () => {
    expect(
      resolveAssembleOptions({
        LONGMEMEVAL_DEDUP_THRESHOLD: '0.8',
        LONGMEMEVAL_MMR_LAMBDA: '0.7',
        LONGMEMEVAL_GROUP: '1',
      }),
    ).toEqual({ dedupThreshold: 0.8, mmrLambda: 0.7, group: true });
  });

  it('returns no options when unset or invalid', () => {
    expect(resolveAssembleOptions({})).toEqual({});
    expect(
      resolveAssembleOptions({
        LONGMEMEVAL_DEDUP_THRESHOLD: 'nan',
        LONGMEMEVAL_MMR_LAMBDA: '-1',
        LONGMEMEVAL_GROUP: '0',
      }),
    ).toEqual({});
  });

  it('rejects a zero dedup threshold (containment >= 0 would drop every later hit)', () => {
    expect(resolveAssembleOptions({ LONGMEMEVAL_DEDUP_THRESHOLD: '0' })).toEqual({});
    expect(resolveAssembleOptions({ LONGMEMEVAL_MMR_LAMBDA: '0' })).toEqual({ mmrLambda: 0 });
  });
});
