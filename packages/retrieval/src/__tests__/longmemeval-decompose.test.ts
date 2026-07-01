import { describe, it, expect } from 'vitest';
import type { QueryHit } from '../index';
import { mergeHits, parseSubQueries } from '../../eval/longmemeval/decompose';
import type { QueryDecomposer } from '../../eval/longmemeval/decompose';
import { createMockEmbedder } from '../../eval/longmemeval/embed';
import { createMockStore } from '../../eval/longmemeval/store';
import { loadFixture } from '../../eval/longmemeval/dataset';
import { runEval } from '../../eval/longmemeval/runner';
import { createCostReport } from '../../eval/longmemeval/levers';

const hit = (id: string): QueryHit => ({ id, text: id, score: 0, fields: { session_id: id } });

describe('mergeHits (reciprocal rank fusion)', () => {
  it('unions per-query hits, deduping by id', () => {
    const q0 = [hit('a'), hit('b')];
    const q1 = [hit('b'), hit('c')];
    const q2 = [hit('d')];
    expect(
      mergeHits([q0, q1, q2], 10)
        .map((h) => h.id)
        .sort(),
    ).toEqual(['a', 'b', 'c', 'd']);
  });

  it('surfaces a top sub-query hit even when the primary query fills the cap', () => {
    const primary = [hit('a'), hit('b')];
    const sub = [hit('c'), hit('a')];
    // Old behaviour concatenated then truncated, dropping c. RRF lets c (rank 0
    // in the sub-query) into the merged pool at cap 2.
    expect(mergeHits([primary, sub], 2).map((h) => h.id)).toContain('c');
  });

  it('ranks a hit corroborated across queries above singletons', () => {
    const q0 = [hit('a'), hit('b')];
    const q1 = [hit('b'), hit('c')];
    // b appears in both queries, so its fused score beats the singletons.
    expect(mergeHits([q0, q1], 10)[0].id).toBe('b');
  });

  it('handles empty input and truncates the union to limit', () => {
    expect(mergeHits([], 5)).toEqual([]);
    expect(mergeHits([[hit('a'), hit('b'), hit('c')], []], 2)).toHaveLength(2);
  });
});

describe('parseSubQueries', () => {
  it('parses a JSON array of strings and ignores non-strings', () => {
    expect(parseSubQueries('["who", "when", 3]')).toEqual(['who', 'when']);
  });

  it('returns [] on malformed or non-array output instead of throwing', () => {
    expect(parseSubQueries('sub-queries: ["who", ')).toEqual([]);
    expect(parseSubQueries('none')).toEqual([]);
  });
});

describe('decompose lever integration', () => {
  it('retrieves per sub-query and merges behind the lever, one decompose call per record, no recall regression', async () => {
    const baseConfig = {
      embedder: createMockEmbedder(),
      store: createMockStore(),
      reader: null,
      judge: null,
      k: 2,
      chunkMode: 'session' as const,
      limit: 20,
      rerankPool: 2,
    };
    const baseline = await runEval({ ...baseConfig, records: await loadFixture() });

    const decomposer: QueryDecomposer = async (question) => [
      `${question} detail one`,
      `${question} detail two`,
    ];
    const costReport = createCostReport();
    const withDecompose = await runEval({
      ...baseConfig,
      records: await loadFixture(),
      levers: ['decompose'],
      costReport,
      decomposer,
    });

    expect(withDecompose.levers).toEqual(['decompose']);
    const cost = withDecompose.costs.find((c) => c.name === 'decompose');
    expect(cost?.llmCalls).toBe(withDecompose.total);
    expect(withDecompose.recallAtK).toBeGreaterThanOrEqual(baseline.recallAtK);
  });
});
