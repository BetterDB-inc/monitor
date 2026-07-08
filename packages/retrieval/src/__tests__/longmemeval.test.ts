import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockEmbedder } from '../../eval/longmemeval/embed';
import { createMockStore } from '../../eval/longmemeval/store';
import { createMockReader } from '../../eval/longmemeval/reader';
import { createMockJudge } from '../../eval/longmemeval/judge';
import { loadFixture, loadRecords, parseTypeList } from '../../eval/longmemeval/dataset';
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
      rerankPool: 2,
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
        rerankPool: 2,
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
      rerankPool: 2,
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
      rerankPool: 3,
    });

    expect(summary.total).toBe(records.length);
    expect(summary.totalChunks).toBeGreaterThan(records.length);
  });

  it('hybrid rerank over-fetch still retrieves the evidence session', async () => {
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
      // Over-fetch 8 candidates, hybrid-rerank (dense + lexical) down to k=2.
      rerankPool: 8,
    });

    expect(summary.total).toBe(records.length);
    expect(summary.recallAtK).toBeGreaterThanOrEqual(0.75);
  });
});

// Streaming loader: the stratified slice must early-stop instead of scanning a
// multi-GB dataset to EOF once every type is capped. We build a temp JSON array
// whose valid, capped slice is followed by many filler records of an
// already-full type and then a deliberately MALFORMED record: if the loader
// keeps reading past the slice it hits the malformed tail and the parser
// throws, so a clean completion proves it stopped early.
describe('loadRecords stratified early-stop', () => {
  const TYPES = ['t0', 't1', 't2', 't3', 't4', 't5'];
  const pad = 'x'.repeat(2000); // push the malformed tail past the read buffer

  function writeStreamFixture(dir: string): string {
    const rec = (i: number, type: string): string =>
      `{"question_id":"q${i}","question_type":"${type}","pad":"${pad}"}`;
    const rows: string[] = [];
    let i = 0;
    // Grouped by type on disk (like _m/_s): 2 of each of the 6 types.
    for (const type of TYPES) {
      rows.push(rec(i++, type));
      rows.push(rec(i++, type));
    }
    // Filler records of an already-full type; must never be yielded.
    for (let f = 0; f < 60; f++) rows.push(rec(i++, 't0'));
    // Malformed record: invalid JSON after the colon → parser error if reached.
    const poison = `{"question_id":"bad","question_type":@@@}`;
    const path = join(dir, 'stream.json');
    writeFileSync(path, `[${rows.join(',')},${poison}]`);
    return path;
  }

  async function collect(gen: AsyncGenerator<{ question_type: string }>): Promise<string[]> {
    const out: string[] = [];
    for await (const record of gen) out.push(record.question_type);
    return out;
  }

  it('stops after the caps fill (no type filter) without reaching the malformed tail', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lme-stream-'));
    try {
      const path = writeStreamFixture(dir);
      // expectedTypeCount=6 lets it early-stop after 2 of each of the 6 types.
      const types = await collect(loadRecords(path, 1e9, undefined, 2, 6));
      expect(types).toHaveLength(12);
      for (const type of TYPES) {
        expect(types.filter((t) => t === type)).toHaveLength(2);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('without the type-count hint it scans to EOF and hits the malformed tail', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lme-stream-'));
    try {
      const path = writeStreamFixture(dir);
      // No expectedTypeCount and no filter → no early-stop → reaches the poison.
      await expect(collect(loadRecords(path, 1e9, undefined, 2))).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Shared parse used by BOTH the runner (to size its limit cap) and loadRecords
// (to filter + early-stop). Locking its semantics guards the invariant that the
// two callers derive identical type sets.
describe('parseTypeList', () => {
  it('returns an empty set for undefined / empty / whitespace-only input', () => {
    expect(parseTypeList(undefined).size).toBe(0);
    expect(parseTypeList('').size).toBe(0);
    expect(parseTypeList('   ').size).toBe(0);
    expect(parseTypeList(' , ,').size).toBe(0);
  });

  it('trims, drops blanks, and dedupes', () => {
    expect(parseTypeList(' temporal-reasoning , multi-session ')).toEqual(
      new Set(['temporal-reasoning', 'multi-session']),
    );
    // Repeated type collapses to one entry (so the runner's cap is not inflated).
    expect(parseTypeList('single-session,single-session').size).toBe(1);
    // Trailing/empty segments are ignored.
    expect(parseTypeList('knowledge-update,,').size).toBe(1);
  });
});
