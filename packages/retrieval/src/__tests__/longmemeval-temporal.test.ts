import { describe, it, expect } from 'vitest';
import type { QueryHit } from '../index';
import { resolveTemporal } from '../../eval/longmemeval/temporal';
import { createMockEmbedder } from '../../eval/longmemeval/embed';
import { createMockStore } from '../../eval/longmemeval/store';
import { createMockJudge } from '../../eval/longmemeval/judge';
import { loadFixture } from '../../eval/longmemeval/dataset';
import { runEval } from '../../eval/longmemeval/runner';
import { createCostReport } from '../../eval/longmemeval/levers';
import type { Reader } from '../../eval/longmemeval/types';

const hit = (id: string, date?: string, score = 0): QueryHit => ({
  id,
  text: id,
  score,
  fields: date !== undefined ? { session_id: id, date } : { session_id: id },
});

describe('resolveTemporal', () => {
  it('drops hits dated after the as-of date, keeping on/before', () => {
    const hits = [hit('a', '2026-01-01'), hit('b', '2026-05-01'), hit('c', '2026-03-01')];
    const out = resolveTemporal(hits, { asOf: '2026-03-01' });
    expect(out.map((h) => h.id).sort()).toEqual(['a', 'c']);
  });

  it('keeps all hits when the as-of filter would remove everything', () => {
    const hits = [hit('a', '2026-05-01'), hit('b', '2026-06-01')];
    const out = resolveTemporal(hits, { asOf: '2026-01-01' });
    expect(out.map((h) => h.id).sort()).toEqual(['a', 'b']);
  });

  it('orders survivors newest date first, with undated hits last', () => {
    const hits = [hit('a', '2026-01-01'), hit('u'), hit('b', '2026-05-01'), hit('c', '2026-03-01')];
    const out = resolveTemporal(hits);
    expect(out.map((h) => h.id)).toEqual(['b', 'c', 'a', 'u']);
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

describe('temporal lever integration', () => {
  it('shapes reader contexts newest-first behind the lever, zero-cost, no recall regression', async () => {
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
    const withTemporal = await runEval({
      ...baseConfig,
      records: await loadFixture(),
      reader,
      judge: createMockJudge(),
      levers: ['temporal'],
      costReport,
    });

    expect(withTemporal.levers).toEqual(['temporal']);
    const cost = withTemporal.costs.find((c) => c.name === 'temporal');
    expect(cost?.embedCalls).toBe(0);
    expect(cost?.llmCalls).toBe(0);

    expect(calls.length).toBeGreaterThan(0);
    for (const contexts of calls) {
      const dates = leadingDates(contexts);
      expect(dates).toEqual([...dates].sort().reverse());
    }

    expect(withTemporal.recallAtK).toBeGreaterThanOrEqual(baseline.recallAtK);
  });
});
