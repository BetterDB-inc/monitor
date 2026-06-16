import { Retriever } from '../../src/index';
import type { RetrievalSchema } from '../../src/index';
import { chunkRecord, recordIsHit } from './adapter';
import type { ChunkMode, Embedder, Judge, LmeRecord, Reader, Store } from './types';

export interface RunConfig {
  records: LmeRecord[];
  embedder: Embedder;
  store: Store;
  reader: Reader | null;
  judge: Judge | null;
  k: number;
  chunkMode: ChunkMode;
  limit: number;
}

export interface TypeStats {
  type: string;
  total: number;
  recallHits: number;
  qaCorrect: number;
}

export interface EvalSummary {
  total: number;
  recallHits: number;
  recallAtK: number;
  qaRun: boolean;
  qaCorrect: number;
  qaAccuracy: number;
  k: number;
  totalChunks: number;
  byType: Map<string, TypeStats>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function pollUntil(predicate: () => Promise<boolean>, attempts = 40): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) return true;
    await sleep(100);
  }
  return false;
}

function buildSchema(dims: number): RetrievalSchema {
  return {
    fields: {
      session_id: { type: 'tag' },
      date: { type: 'tag' },
    },
    vector: { metric: 'cosine', algorithm: 'hnsw', dims },
  };
}

function bump(byType: Map<string, TypeStats>, type: string): TypeStats {
  let stats = byType.get(type);
  if (stats === undefined) {
    stats = { type, total: 0, recallHits: 0, qaCorrect: 0 };
    byType.set(type, stats);
  }
  return stats;
}

export async function runEval(config: RunConfig): Promise<EvalSummary> {
  const { records, embedder, store, reader, judge, k, chunkMode, limit } = config;
  const qaRun = reader !== null && judge !== null;
  const schema = buildSchema(embedder.dims);
  const byType = new Map<string, TypeStats>();

  let total = 0;
  let recallHits = 0;
  let qaCorrect = 0;
  let totalChunks = 0;

  const slice = records.slice(0, limit);
  for (let i = 0; i < slice.length; i++) {
    const record = slice[i];
    const name = `lme_${i}_${Math.random().toString(36).slice(2, 8)}`;
    const retriever = new Retriever({
      client: store.client,
      name,
      schema,
      embedFn: embedder.embed,
    });

    const chunks = chunkRecord(record, chunkMode);
    totalChunks += chunks.length;

    await retriever.createIndex();
    await retriever.upsert(chunks);

    if (store.isReal) {
      const expected = Math.min(k, chunks.length);
      const settled = await pollUntil(async () => {
        const hits = await retriever.query({ text: record.question, k });
        return hits.length >= expected;
      });
      if (!settled) {
        // HNSW indexing did not converge within the poll window; querying now
        // can miss the evidence chunk, so surface it rather than silently
        // undercounting recall for this record.
        console.warn(
          `index ${name} did not settle within the poll window (record ${i + 1}); recall may be undercounted`,
        );
      }
    }

    const hits = await retriever.query({ text: record.question, k });
    const hit = recordIsHit(hits, record.answer_session_ids);

    const stats = bump(byType, record.question_type);
    stats.total++;
    total++;
    if (hit) {
      stats.recallHits++;
      recallHits++;
    }

    if (qaRun && reader !== null && judge !== null) {
      const contexts = hits.map((h) => h.text);
      const answer = await reader.answer(record.question, contexts);
      const correct = await judge.grade(record.question, record.answer, answer);
      if (correct) {
        stats.qaCorrect++;
        qaCorrect++;
      }
    }

    await retriever.delete(chunks.map((c) => c.id)).catch(() => {});
    await retriever.dropIndex().catch(() => {});
  }

  await embedder.flush?.();

  return {
    total,
    recallHits,
    recallAtK: total > 0 ? recallHits / total : 0,
    qaRun,
    qaCorrect,
    qaAccuracy: qaRun && total > 0 ? qaCorrect / total : 0,
    k,
    totalChunks,
    byType,
  };
}

export function formatSummary(summary: EvalSummary): string {
  const lines: string[] = [];
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
  lines.push('');
  lines.push(`Records: ${summary.total}   Chunks indexed: ${summary.totalChunks}   k=${summary.k}`);
  lines.push('');

  const header = summary.qaRun
    ? 'question_type                         n   recall@k   QA-acc'
    : 'question_type                         n   recall@k';
  lines.push(header);
  lines.push('-'.repeat(header.length));

  const rows = Array.from(summary.byType.values()).sort((a, b) => a.type.localeCompare(b.type));
  for (const row of rows) {
    const recall = pct(row.total > 0 ? row.recallHits / row.total : 0);
    const base = `${row.type.padEnd(36)} ${String(row.total).padStart(3)}   ${recall.padStart(8)}`;
    lines.push(summary.qaRun ? `${base}   ${pct(row.qaCorrect / row.total).padStart(6)}` : base);
  }

  lines.push('-'.repeat(header.length));
  const overall = `${'OVERALL'.padEnd(36)} ${String(summary.total).padStart(3)}   ${pct(
    summary.recallAtK,
  ).padStart(8)}`;
  lines.push(summary.qaRun ? `${overall}   ${pct(summary.qaAccuracy).padStart(6)}` : overall);
  lines.push('');
  return lines.join('\n');
}
