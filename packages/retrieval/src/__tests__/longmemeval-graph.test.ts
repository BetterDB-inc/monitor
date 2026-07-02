import { describe, it, expect } from 'vitest';
import {
  buildEntityGraph,
  traverseGraph,
  createMockEntityLinker,
  parseEntityLists,
} from '../../eval/longmemeval/graph';
import type { EntityLinker } from '../../eval/longmemeval/graph';
import { consolidateRecordFacts } from '../../eval/longmemeval/facts';
import type { Fact, FactExtractor } from '../../eval/longmemeval/facts';
import { createMockEmbedder } from '../../eval/longmemeval/embed';
import { createMockStore } from '../../eval/longmemeval/store';
import { loadFixture } from '../../eval/longmemeval/dataset';
import { runEval } from '../../eval/longmemeval/runner';
import { createCostReport } from '../../eval/longmemeval/levers';
import type { Reader, Judge } from '../../eval/longmemeval/types';

const fact = (statement: string, date?: string): Fact => ({
  subject: statement.split(' ')[0].toLowerCase(),
  statement,
  date,
});

describe('traverseGraph', () => {
  it('hop 1 returns facts mentioning a seed entity, case-insensitively', () => {
    const facts = [fact('Alice works at Acme'), fact('Bob likes tea')];
    const graph = buildEntityGraph(facts, [['Alice', 'Acme'], ['Bob']]);
    expect(traverseGraph(graph, ['alice'], 1)).toEqual([facts[0]]);
  });

  it('hop 2 reaches facts connected through a shared entity', () => {
    const facts = [fact('Alice introduced me to Bob'), fact('Bob runs a bakery')];
    const graph = buildEntityGraph(facts, [['Alice', 'Bob'], ['Bob']]);
    expect(traverseGraph(graph, ['alice'], 1)).toEqual([facts[0]]);
    expect(traverseGraph(graph, ['alice'], 2)).toEqual([facts[0], facts[1]]);
  });

  it('drops facts dated after asOf but keeps dateless facts', () => {
    const facts = [
      fact('Alice joined the gym', '2026-01-05'),
      fact('Alice has a sister'),
      fact('Alice moved to Sofia', '2026-03-01'),
    ];
    const graph = buildEntityGraph(facts, [['Alice'], ['Alice'], ['Alice']]);
    expect(traverseGraph(graph, ['alice'], 1, { asOf: '2026-02-01' })).toEqual([
      facts[0],
      facts[1],
    ]);
  });

  it('dedupes facts reachable via multiple seeds and caps at limit', () => {
    const shared = fact('Alice married Bob');
    const facts = [shared, fact('Alice paints'), fact('Alice sails'), fact('Alice codes')];
    const graph = buildEntityGraph(facts, [['Alice', 'Bob'], ['Alice'], ['Alice'], ['Alice']]);
    expect(traverseGraph(graph, ['alice', 'bob'], 1)).toHaveLength(4);
    expect(traverseGraph(graph, ['alice', 'bob'], 1, { limit: 2 })).toHaveLength(2);
  });

  it('returns [] for unknown seeds', () => {
    const graph = buildEntityGraph([fact('Alice paints')], [['Alice']]);
    expect(traverseGraph(graph, ['zoe'], 2)).toEqual([]);
  });
});

describe('createMockEntityLinker', () => {
  it('extracts capitalized words per text, lowercased and deduped', async () => {
    const linker = createMockEntityLinker();
    const out = await linker(['Alice met Bob and Alice again', 'no entities here']);
    expect(out).toEqual([['alice', 'bob'], []]);
  });
});

describe('parseEntityLists', () => {
  it('parses an array of string arrays, dropping non-strings', () => {
    expect(parseEntityLists('[["Alice"],["Bob",3]]', 2)).toEqual([['Alice'], ['Bob']]);
  });

  it('pads or truncates to the expected length', () => {
    expect(parseEntityLists('[["Alice"]]', 2)).toEqual([['Alice'], []]);
    expect(parseEntityLists('[["a"],["b"],["c"]]', 2)).toEqual([['a'], ['b']]);
  });

  it('degrades to empty lists on malformed output instead of throwing', () => {
    expect(parseEntityLists('entities: [["Alice"', 2)).toEqual([[], []]);
    expect(parseEntityLists('none', 1)).toEqual([[]]);
  });
});

describe('consolidateRecordFacts curated facts', () => {
  it('returns the curated facts alongside the chunks', async () => {
    const extract: FactExtractor = async (_session, meta) => [
      { subject: 'home_city', statement: `lives in city ${meta.sessionId}` },
    ];
    const record = {
      question_id: 'q',
      question_type: 't',
      question: '?',
      answer: 'a',
      haystack_session_ids: ['S0', 'S1'],
      haystack_dates: ['2026-01-01', '2026-01-02'],
      haystack_sessions: [
        [{ role: 'user' as const, content: 'x' }],
        [{ role: 'user' as const, content: 'y' }],
      ],
      answer_session_ids: ['S0'],
    };
    const { facts } = await consolidateRecordFacts(record, extract, 2);
    expect(facts).toHaveLength(1);
    expect(facts[0].statement).toBe('lives in city S1');
  });
});

describe('graph lever integration', () => {
  it('appends traversed facts to reader contexts, one linker call per record plus one per question', async () => {
    const contextsSeen: string[][] = [];
    const reader: Reader = {
      name: 'spy',
      answer: async (_question, contexts) => {
        contextsSeen.push(contexts);
        return 'answer';
      },
    };
    const judge: Judge = { name: 'yes', grade: async () => true };
    const factExtractor: FactExtractor = async () => [
      { subject: 'introduction', statement: 'Alice introduced me to Bob' },
    ];
    const entityLinker: EntityLinker = async (texts) => texts.map(() => ['alice']);
    const costReport = createCostReport();

    const summary = await runEval({
      records: await loadFixture(),
      embedder: createMockEmbedder(),
      store: createMockStore(),
      reader,
      judge,
      k: 2,
      chunkMode: 'session',
      limit: 20,
      rerankPool: 2,
      levers: ['facts', 'graph'],
      costReport,
      factExtractor,
      entityLinker,
    });

    expect(contextsSeen.length).toBe(summary.total);
    for (const contexts of contextsSeen) {
      expect(contexts.some((c) => c.includes('Alice introduced me to Bob'))).toBe(true);
    }
    const cost = summary.costs.find((c) => c.name === 'graph');
    expect(cost?.llmCalls).toBe(summary.total * 2);
  });

  it('does not duplicate a graph fact already present in the reader contexts', async () => {
    const factExtractor: FactExtractor = async () => [
      { subject: 'introduction', statement: 'Alice introduced me to Bob' },
    ];
    const entityLinker: EntityLinker = async (texts) => texts.map(() => ['alice']);
    const judge: Judge = { name: 'yes', grade: async () => true };
    const countMatches = (contexts: string[]): number => {
      return contexts.filter((c) => {
        return c.includes('Alice introduced me to Bob');
      }).length;
    };
    const run = async (levers: ('facts' | 'graph')[]): Promise<number[]> => {
      const counts: number[] = [];
      const reader: Reader = {
        name: 'spy',
        answer: async (_question, contexts) => {
          counts.push(countMatches(contexts));
          return 'answer';
        },
      };
      await runEval({
        records: await loadFixture(),
        embedder: createMockEmbedder(),
        store: createMockStore(),
        reader,
        judge,
        k: 50,
        chunkMode: 'session',
        limit: 20,
        rerankPool: 50,
        levers,
        factExtractor,
        entityLinker,
      });
      return counts;
    };

    // At k=50 every fact chunk is already retrieved, so the graph traversal
    // finds nothing new: per-record counts must match the facts-only run.
    const factsOnly = await run(['facts']);
    const withGraph = await run(['facts', 'graph']);
    expect(factsOnly.every((count) => count >= 1)).toBe(true);
    expect(withGraph).toEqual(factsOnly);
  });
});
