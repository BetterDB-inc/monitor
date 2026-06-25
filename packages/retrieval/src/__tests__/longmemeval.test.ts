import { describe, it, expect } from 'vitest';
import { createMockEmbedder } from '../../eval/longmemeval/embed';
import { createMockStore } from '../../eval/longmemeval/store';
import { createMockReader } from '../../eval/longmemeval/reader';
import { createMockJudge } from '../../eval/longmemeval/judge';
import { loadFixture } from '../../eval/longmemeval/dataset';
import { runEval } from '../../eval/longmemeval/runner';

// Tier 0: fully offline (mock store + hashed embed), no keys/network/Docker.
describe('longmemeval Tier 0 smoke', () => {
  it('retrieves the evidence session above threshold on the fixture', async () => {
    const records = await loadFixture();
    const summary = await runEval({
      records,
      embedder: createMockEmbedder(),
      store: createMockStore(),
      reader: null,
      judge: null,
      k: 2,
      chunkMode: 'session',
      limit: 20,
    });

    expect(summary.total).toBe(records.length);
    // Lexical mock embedding must rank the evidence session within the top-k.
    expect(summary.recallAtK).toBeGreaterThanOrEqual(0.75);
  });

  it('is deterministic across runs', async () => {
    const records = await loadFixture();
    const run = (): ReturnType<typeof runEval> =>
      runEval({
        records,
        embedder: createMockEmbedder(),
        store: createMockStore(),
        reader: null,
        judge: null,
        k: 2,
        chunkMode: 'session',
        limit: 20,
      });

    const a = await run();
    const b = await run();
    expect(a.recallHits).toBe(b.recallHits);
    expect(a.recallAtK).toBe(b.recallAtK);
  });

  it('runs the mock reader+judge QA path end to end', async () => {
    const records = await loadFixture();
    const summary = await runEval({
      records,
      embedder: createMockEmbedder(),
      store: createMockStore(),
      reader: createMockReader(),
      judge: createMockJudge(),
      k: 2,
      chunkMode: 'session',
      limit: 20,
    });

    expect(summary.qaRun).toBe(true);
    // Mock reader echoes the top hit; the evidence text contains the gold answer.
    expect(summary.qaAccuracy).toBeGreaterThanOrEqual(0.75);
  });

  it('supports per-turn chunking', async () => {
    const records = await loadFixture();
    const summary = await runEval({
      records,
      embedder: createMockEmbedder(),
      store: createMockStore(),
      reader: null,
      judge: null,
      k: 3,
      chunkMode: 'turn',
      limit: 20,
    });

    expect(summary.total).toBe(records.length);
    expect(summary.totalChunks).toBeGreaterThan(records.length);
  });
});
