import { describe, it, expect } from 'vitest';
import { resolveEnabledLevers, createCostReport } from '../../eval/longmemeval/levers';
import { createMockEmbedder } from '../../eval/longmemeval/embed';
import { createMockStore } from '../../eval/longmemeval/store';
import { loadFixture } from '../../eval/longmemeval/dataset';
import { runEval, formatSummary } from '../../eval/longmemeval/runner';
import type { EvalSummary } from '../../eval/longmemeval/runner';

const baseConfig = async () => ({
  records: await loadFixture(),
  embedder: createMockEmbedder(),
  store: createMockStore(),
  reader: null,
  judge: null,
  k: 2,
  chunkMode: 'session' as const,
  limit: 20,
  rerankPool: 2,
});

describe('resolveEnabledLevers', () => {
  it('enables only the levers whose flags are set', () => {
    expect(resolveEnabledLevers({})).toEqual([]);
    expect(resolveEnabledLevers({ LONGMEMEVAL_ASSEMBLE: '1' })).toEqual(['assemble']);
  });

  it('returns enabled levers in canonical ablation order, not env order', () => {
    const levers = resolveEnabledLevers({
      LONGMEMEVAL_GRAPH: '1',
      LONGMEMEVAL_ASSEMBLE: 'true',
      LONGMEMEVAL_FACTS: '1',
    });
    expect(levers).toEqual(['assemble', 'facts', 'graph']);
  });
});

describe('createCostReport', () => {
  it('sums repeated costs per lever and emits them in canonical order', () => {
    const report = createCostReport();
    report.record('facts', { llmCalls: 2, latencyMs: 100 });
    report.record('assemble', { latencyMs: 5 });
    report.record('facts', { llmCalls: 1, embedCalls: 3, latencyMs: 50 });

    expect(report.entries()).toEqual([
      { name: 'assemble', embedCalls: 0, llmCalls: 0, latencyMs: 5 },
      { name: 'facts', embedCalls: 3, llmCalls: 3, latencyMs: 150 },
    ]);
  });
});

describe('runEval foundation', () => {
  it('is inert by default: no levers, no costs, baseline recall preserved', async () => {
    const summary = await runEval(await baseConfig());

    expect(summary.levers).toEqual([]);
    expect(summary.costs).toEqual([]);
    expect(summary.recallAtK).toBeGreaterThanOrEqual(0.75);
  });
});

const summaryFixture = (overrides: Partial<EvalSummary> = {}): EvalSummary => ({
  total: 1,
  recallHits: 1,
  recallAtK: 1,
  qaRun: false,
  qaCorrect: 0,
  qaAccuracy: 0,
  k: 2,
  totalChunks: 1,
  byType: new Map(),
  levers: [],
  costs: [],
  ...overrides,
});

describe('formatSummary lever costs', () => {
  it('omits the lever-cost section when no levers are enabled', () => {
    expect(formatSummary(summaryFixture())).not.toMatch(/lever/i);
  });

  it('reports each enabled lever and its cost when present', () => {
    const out = formatSummary(
      summaryFixture({
        levers: ['assemble'],
        costs: [{ name: 'assemble', embedCalls: 0, llmCalls: 0, latencyMs: 12 }],
      }),
    );
    expect(out).toMatch(/lever/i);
    expect(out).toContain('assemble');
    expect(out).toContain('12');
  });
});
