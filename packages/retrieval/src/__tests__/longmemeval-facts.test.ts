import { describe, it, expect } from 'vitest';
import { reconcile, applyOps } from '../../eval/longmemeval/facts';
import type { Fact, FactOp, FactExtractor } from '../../eval/longmemeval/facts';
import { createMockEmbedder } from '../../eval/longmemeval/embed';
import { createMockStore } from '../../eval/longmemeval/store';
import { loadFixture } from '../../eval/longmemeval/dataset';
import { runEval } from '../../eval/longmemeval/runner';
import { createCostReport } from '../../eval/longmemeval/levers';

const fact = (subject: string, statement: string, date: string): Fact => ({
  subject,
  statement,
  date,
});

describe('reconcile', () => {
  it('ADDs a fact whose subject is not yet in the store', () => {
    const ops = reconcile([fact('employer', 'works at Google', '2026-01-01')], []);
    expect(ops).toEqual([
      {
        type: 'add',
        fact: { subject: 'employer', statement: 'works at Google', date: '2026-01-01' },
      },
    ]);
  });

  it('emits NOOP when an incoming fact matches an existing subject and statement', () => {
    const existing = [fact('employer', 'works at Google', '2026-01-01')];
    const ops = reconcile([fact('employer', 'works at Google', '2026-02-01')], existing);
    expect(ops).toEqual([{ type: 'noop', subject: 'employer' }]);
  });

  it('UPDATEs when an incoming fact supersedes an existing subject with a newer statement', () => {
    const existing = [fact('employer', 'works at Google', '2026-01-01')];
    const ops = reconcile([fact('employer', 'works at Meta', '2026-03-01')], existing);
    expect(ops).toEqual([
      {
        type: 'update',
        subject: 'employer',
        fact: { subject: 'employer', statement: 'works at Meta', date: '2026-03-01' },
      },
    ]);
  });

  it('does not supersede an existing fact with a stale (older) differing statement', () => {
    const existing = [fact('employer', 'works at Meta', '2026-03-01')];
    const ops = reconcile([fact('employer', 'works at Google', '2026-01-01')], existing);
    expect(ops).toEqual([{ type: 'noop', subject: 'employer' }]);
  });

  it('DELETEs an existing subject when the incoming fact is a tombstone', () => {
    const existing = [fact('employer', 'works at Google', '2026-01-01')];
    const ops = reconcile(
      [{ subject: 'employer', statement: '', date: '2026-03-01', tombstone: true }],
      existing,
    );
    expect(ops).toEqual([{ type: 'delete', subject: 'employer' }]);
  });
});

describe('applyOps', () => {
  it('applies ADD/UPDATE/DELETE/NOOP to produce the curated fact set', () => {
    const existing = [
      fact('employer', 'works at Google', '2026-01-01'),
      fact('city', 'lives in Paris', '2026-01-01'),
    ];
    const ops: FactOp[] = [
      {
        type: 'update',
        subject: 'employer',
        fact: fact('employer', 'works at Meta', '2026-03-01'),
      },
      { type: 'delete', subject: 'city' },
      { type: 'add', fact: fact('pet', 'has a dog', '2026-02-01') },
      { type: 'noop', subject: 'city' },
    ];
    expect(applyOps(existing, ops)).toEqual([
      fact('employer', 'works at Meta', '2026-03-01'),
      fact('pet', 'has a dog', '2026-02-01'),
    ]);
  });
});

describe('facts lever integration', () => {
  it('extracts and indexes facts behind the lever, one LLM call per session, no recall regression', async () => {
    const records = await loadFixture();
    const limit = 20;
    const totalSessions = records
      .slice(0, limit)
      .reduce((sum, record) => sum + record.haystack_sessions.length, 0);

    const extractor: FactExtractor = async (session, meta) => [
      { subject: `topic_${meta.sessionId}`, statement: session[0]?.content ?? 'fact' },
    ];

    const baseConfig = {
      embedder: createMockEmbedder(),
      store: createMockStore(),
      reader: null,
      judge: null,
      k: 2,
      chunkMode: 'session' as const,
      limit,
      rerankPool: 2,
    };

    const baseline = await runEval({ ...baseConfig, records: await loadFixture() });

    const costReport = createCostReport();
    const withFacts = await runEval({
      ...baseConfig,
      records: await loadFixture(),
      levers: ['facts'],
      costReport,
      factExtractor: extractor,
    });

    expect(withFacts.levers).toEqual(['facts']);
    expect(withFacts.costs.find((c) => c.name === 'facts')?.llmCalls).toBe(totalSessions);
    expect(withFacts.recallAtK).toBeGreaterThanOrEqual(baseline.recallAtK);
  });
});
