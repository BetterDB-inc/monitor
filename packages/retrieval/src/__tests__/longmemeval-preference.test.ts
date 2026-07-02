import { describe, it, expect } from 'vitest';
import type { QueryHit } from '../index';
import {
  isPreferenceQuestion,
  promotePreferenceHits,
  createMockPreferenceExtractor,
  createPreferenceAwareJudge,
  verdictIsCorrect,
} from '../../eval/longmemeval/preference';
import type { FactExtractor } from '../../eval/longmemeval/facts';
import { createMockEmbedder } from '../../eval/longmemeval/embed';
import { createMockStore } from '../../eval/longmemeval/store';
import { loadFixture } from '../../eval/longmemeval/dataset';
import { runEval } from '../../eval/longmemeval/runner';
import { createCostReport } from '../../eval/longmemeval/levers';
import type { Judge } from '../../eval/longmemeval/types';

const hit = (id: string): QueryHit => ({ id, text: id, score: 0, fields: { session_id: id } });

describe('isPreferenceQuestion', () => {
  it('matches recommendation-shaped questions', () => {
    expect(isPreferenceQuestion('Can you recommend a restaurant for my trip?')).toBe(true);
    expect(isPreferenceQuestion('Any suggestions for a weekend activity?')).toBe(true);
    expect(isPreferenceQuestion('Give me some tips for my garden')).toBe(true);
    expect(isPreferenceQuestion('What should I cook tonight?')).toBe(true);
  });

  it('does not match factual questions', () => {
    expect(isPreferenceQuestion('When did I visit the dentist?')).toBe(false);
    expect(isPreferenceQuestion('What is the name of my sister?')).toBe(false);
    expect(isPreferenceQuestion('How much did I pay for the couch?')).toBe(false);
  });
});

describe('promotePreferenceHits', () => {
  it('promotes a preference hit from outside the top-k into the window', () => {
    const hits = [hit('a'), hit('b'), hit('c'), hit('pref_0'), hit('d')];
    const out = promotePreferenceHits(hits, 2);
    expect(out.slice(0, 2).map((h) => h.id)).toEqual(['a', 'pref_0']);
  });

  it('keeps every hit, only reordered', () => {
    const hits = [hit('a'), hit('b'), hit('c'), hit('pref_0'), hit('d')];
    const out = promotePreferenceHits(hits, 2);
    expect(out.map((h) => h.id).sort()).toEqual(hits.map((h) => h.id).sort());
    expect(out).toHaveLength(hits.length);
  });

  it('respects the promotion cap', () => {
    const hits = [hit('a'), hit('b'), hit('c'), hit('pref_0'), hit('pref_1'), hit('pref_2')];
    const out = promotePreferenceHits(hits, 3, 2);
    expect(out.slice(0, 3).map((h) => h.id)).toEqual(['a', 'pref_0', 'pref_1']);
  });

  it('is a no-op when no preference hits are outside the window', () => {
    const inside = [hit('pref_0'), hit('a'), hit('b'), hit('c')];
    expect(promotePreferenceHits(inside, 2)).toEqual(inside);
    const none = [hit('a'), hit('b'), hit('c')];
    expect(promotePreferenceHits(none, 2)).toEqual(none);
  });
});

describe('createMockPreferenceExtractor', () => {
  it('extracts user turns that state a preference', async () => {
    const extract = createMockPreferenceExtractor();
    const facts = await extract(
      [
        { role: 'user', content: 'I love spicy food' },
        { role: 'assistant', content: 'Noted!' },
        { role: 'user', content: 'What time is it?' },
      ],
      { sessionId: 'S1' },
    );
    expect(facts).toHaveLength(1);
    expect(facts[0].statement).toBe('I love spicy food');
  });

  it('returns [] when no turn states a preference', async () => {
    const extract = createMockPreferenceExtractor();
    const facts = await extract([{ role: 'user', content: 'What time is it?' }], {
      sessionId: 'S1',
    });
    expect(facts).toEqual([]);
  });
});

describe('verdictIsCorrect', () => {
  it('accepts a plain "correct" verdict', () => {
    expect(verdictIsCorrect('Correct')).toBe(true);
    expect(verdictIsCorrect('The answer is correct.')).toBe(true);
  });

  it('rejects negated and partial forms', () => {
    expect(verdictIsCorrect('incorrect')).toBe(false);
    expect(verdictIsCorrect('not correct')).toBe(false);
    expect(verdictIsCorrect('partially correct')).toBe(false);
    expect(verdictIsCorrect('no idea')).toBe(false);
  });
});

describe('createPreferenceAwareJudge', () => {
  it('routes preference-shaped questions to the preference judge and others to the generic judge', async () => {
    const calls: string[] = [];
    const preference: Judge = {
      name: 'pref',
      grade: async () => {
        calls.push('pref');
        return true;
      },
    };
    const generic: Judge = {
      name: 'generic',
      grade: async () => {
        calls.push('generic');
        return false;
      },
    };
    const judge = createPreferenceAwareJudge(preference, generic);

    expect(await judge.grade('Can you recommend a book?', 'g', 'p')).toBe(true);
    expect(await judge.grade('When did I move to Sofia?', 'g', 'p')).toBe(false);
    expect(calls).toEqual(['pref', 'generic']);
  });
});

describe('preference lever integration', () => {
  it('indexes preference chunks, promotes them for preference questions only, and reports cost', async () => {
    const preferenceExtractor: FactExtractor = async (_session, meta) => [
      { subject: 'cuisine', statement: 'user loves spicy food', date: meta.date },
    ];
    const costReport = createCostReport();

    const baseline = await runEval({
      records: await loadFixture(),
      embedder: createMockEmbedder(),
      store: createMockStore(),
      reader: null,
      judge: null,
      k: 2,
      chunkMode: 'session',
      limit: 20,
      rerankPool: 2,
    });

    const withPreference = await runEval({
      records: await loadFixture(),
      embedder: createMockEmbedder(),
      store: createMockStore(),
      reader: null,
      judge: null,
      k: 2,
      chunkMode: 'session',
      limit: 20,
      rerankPool: 2,
      levers: ['preference'],
      costReport,
      preferenceExtractor,
    });

    expect(withPreference.levers).toEqual(['preference']);
    expect(withPreference.totalChunks).toBeGreaterThan(baseline.totalChunks);
    const cost = withPreference.costs.find((c) => c.name === 'preference');
    expect(cost).toBeDefined();
    expect(cost?.llmCalls).toBeGreaterThan(0);
    expect(withPreference.recallAtK).toBeGreaterThanOrEqual(baseline.recallAtK);
  });
});
