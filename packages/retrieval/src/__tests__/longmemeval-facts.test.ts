import { describe, it, expect } from 'vitest';
import {
  reconcile,
  applyOps,
  consolidateRecordFacts,
  parseFacts,
} from '../../eval/longmemeval/facts';
import type { Fact, FactOp, FactExtractor } from '../../eval/longmemeval/facts';
import type { LmeRecord } from '../../eval/longmemeval/types';
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

  it('lets a dateless later update supersede a dated prior (sessions arrive chronologically)', () => {
    const existing = [fact('employer', 'works at Google', '2026-01-01')];
    const ops = reconcile([{ subject: 'employer', statement: 'works at Meta' }], existing);
    expect(ops).toEqual([
      {
        type: 'update',
        subject: 'employer',
        fact: { subject: 'employer', statement: 'works at Meta' },
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

  it('ignores a stale tombstone dated before the curated fact', () => {
    const existing = [fact('employer', 'works at Meta', '2026-03-01')];
    const ops = reconcile(
      [{ subject: 'employer', statement: '', date: '2026-01-01', tombstone: true }],
      existing,
    );
    expect(ops).toEqual([{ type: 'noop', subject: 'employer' }]);
  });

  it('supersedes a fact added earlier in the same batch', () => {
    const ops = reconcile(
      [
        fact('employer', 'works at Google', '2026-01-01'),
        fact('employer', 'works at Meta', '2026-03-01'),
      ],
      [],
    );
    expect(ops).toEqual([
      {
        type: 'add',
        fact: { subject: 'employer', statement: 'works at Google', date: '2026-01-01' },
      },
      {
        type: 'update',
        subject: 'employer',
        fact: { subject: 'employer', statement: 'works at Meta', date: '2026-03-01' },
      },
    ]);
  });

  it('applies a same-batch tombstone against a fact added earlier in the batch', () => {
    const ops = reconcile(
      [fact('pet', 'has a dog', '2026-01-01'), { subject: 'pet', statement: '', tombstone: true }],
      [],
    );
    expect(ops).toEqual([
      { type: 'add', fact: { subject: 'pet', statement: 'has a dog', date: '2026-01-01' } },
      { type: 'delete', subject: 'pet' },
    ]);
    expect(applyOps([], ops)).toEqual([]);
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

describe('parseFacts', () => {
  it('parses a JSON array of facts', () => {
    const raw = '[{"subject":"employer","statement":"works at Meta"}]';
    expect(parseFacts(raw)).toEqual([
      { subject: 'employer', statement: 'works at Meta', tombstone: false },
    ]);
  });

  it('returns [] for malformed JSON instead of throwing', () => {
    expect(parseFacts('[{"subject": "x", ')).toEqual([]);
  });

  it('returns [] when prose brackets produce invalid JSON', () => {
    expect(parseFacts('I found [some] facts: [{"subject":"a","statement":"b"}]')).toEqual([]);
  });
});

describe('consolidateRecordFacts', () => {
  it('emits a fact chunk for every source session when a fact is restated', async () => {
    const record: LmeRecord = {
      question_id: 'q',
      question_type: 't',
      question: '?',
      answer: 'a',
      haystack_session_ids: ['S1', 'S2'],
      haystack_dates: ['2026-01-01', '2026-02-01'],
      haystack_sessions: [
        [{ role: 'user', content: 'I like tea' }],
        [{ role: 'user', content: 'I like tea' }],
      ],
      answer_session_ids: ['S2'],
    };
    const extract: FactExtractor = async () => [{ subject: 'beverage', statement: 'likes tea' }];

    const { chunks } = await consolidateRecordFacts(record, extract);
    expect(chunks.map((c) => c.fields.session_id).sort()).toEqual(['S1', 'S2']);
  });

  it('tags each restated fact chunk with its own source session date', async () => {
    const record: LmeRecord = {
      question_id: 'q',
      question_type: 't',
      question: '?',
      answer: 'a',
      haystack_session_ids: ['S1', 'S2'],
      haystack_dates: ['2026-01-01', '2026-02-01'],
      haystack_sessions: [
        [{ role: 'user', content: 'I like tea' }],
        [{ role: 'user', content: 'I like tea' }],
      ],
      answer_session_ids: ['S2'],
    };
    const extract: FactExtractor = async () => [{ subject: 'beverage', statement: 'likes tea' }];

    const { chunks } = await consolidateRecordFacts(record, extract);
    const tagged = chunks.map((c) => [c.fields.session_id, c.fields.date]).sort();
    expect(tagged).toEqual([
      ['S1', '2026-01-01'],
      ['S2', '2026-02-01'],
    ]);
  });
});
