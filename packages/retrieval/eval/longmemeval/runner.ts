import { Retriever } from '../../src/index';
import type { RetrievalSchema, RerankFn } from '../../src/index';
import { chunkRecord, recordIsHit } from './adapter';
import { createHybridRerank } from './rerank';
import { createCrossEncoderRerank, SCORER_BATCH_SIZE } from './cross-encoder';
import type { CrossEncoderScorer } from './cross-encoder';
import { assembleContexts } from './assemble';
import type { AssembleOptions } from './assemble';
import { resolveTemporal } from './temporal';
import { consolidateRecordFacts } from './facts';
import type { FactExtractor } from './facts';
import { createCostReport } from './levers';
import type { CostReport, LeverCostEntry, LeverName } from './levers';
import type { ChunkMode, Embedder, Judge, LmeRecord, Reader, Store } from './types';

export interface RunConfig {
  records: AsyncIterable<LmeRecord> | Iterable<LmeRecord>;
  embedder: Embedder;
  store: Store;
  reader: Reader | null;
  judge: Judge | null;
  k: number;
  chunkMode: ChunkMode;
  limit: number;
  // When > k, over-fetch this many candidates and hybrid-rerank them down to k.
  // Equal to k (the default) disables reranking and preserves baseline behavior.
  rerankPool: number;
  // Levers enabled for this run, in canonical ablation order. Empty (the default)
  // reproduces the frozen baseline.
  levers?: LeverName[];
  // Accumulator levers report their added embedding/LLM/latency cost into.
  costReport?: CostReport;
  // Opt-in structure features for the assemble lever (dedup / MMR / grouping).
  // Without any set, the lever only date-prefixes the rerank-ordered top-k.
  assembleOptions?: AssembleOptions;
  // LLM seam for the facts lever. Required when 'facts' is enabled; extracts
  // atomic facts per session for consolidation into curated fact chunks.
  factExtractor?: FactExtractor;
  // Model seam for the rerank-cross lever. When 'rerank-cross' is enabled (and
  // rerankPool > k), the pool is reordered by this scorer instead of the hybrid
  // reranker.
  crossEncoderScorer?: CrossEncoderScorer;
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
  levers: LeverName[];
  costs: LeverCostEntry[];
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

function resolveRerankFn(
  useRerank: boolean,
  crossScorer: CrossEncoderScorer | undefined,
  costReport: CostReport,
): RerankFn | undefined {
  if (useRerank === false) {
    return undefined;
  }
  if (crossScorer === undefined) {
    return createHybridRerank();
  }
  const counted: CrossEncoderScorer = async (query, documents) => {
    const startedAt = Date.now();
    const scores = await crossScorer(query, documents);
    // Projected cost, mock or real: the OpenAI scorer spends one chat call per
    // SCORER_BATCH_SIZE passages (harness convention — mocks report the cost
    // the real seam would incur).
    const llmCalls = Math.max(1, Math.ceil(documents.length / SCORER_BATCH_SIZE));
    costReport.record('rerank-cross', { llmCalls, latencyMs: Date.now() - startedAt });
    return scores;
  };
  return createCrossEncoderRerank(counted);
}

export async function runEval(config: RunConfig): Promise<EvalSummary> {
  const { records, embedder, store, reader, judge, k, chunkMode, limit, rerankPool } = config;
  const levers = config.levers ?? [];
  const costReport = config.costReport ?? createCostReport();
  const assembleOn = levers.includes('assemble');
  const temporalOn = levers.includes('temporal');
  const factsOn = levers.includes('facts') && config.factExtractor !== undefined;
  const qaRun = reader !== null && judge !== null;
  const useRerank = rerankPool > k;
  const fetchK = useRerank ? rerankPool : k;
  const crossScorer = levers.includes('rerank-cross') ? config.crossEncoderScorer : undefined;
  if (crossScorer !== undefined && useRerank === false) {
    // Without an over-fetch pool the scorer is never invoked, and the run would
    // report a pure-baseline result labeled as the rerank-cross lever — a false
    // ablation point. Refuse instead of measuring nothing.
    throw new Error(
      `the 'rerank-cross' lever needs an over-fetch pool: set rerankPool (LONGMEMEVAL_RERANK_POOL) above k=${k}`,
    );
  }
  const rerankFn = resolveRerankFn(useRerank, crossScorer, costReport);
  const schema = buildSchema(embedder.dims);
  const byType = new Map<string, TypeStats>();

  let total = 0;
  let recallHits = 0;
  let qaCorrect = 0;
  let totalChunks = 0;

  // Flush in `finally` so a mid-run failure (embedding/Valkey/reader error)
  // still persists the embeddings already computed — billable work must not be
  // discarded just because the run didn't reach the end.
  try {
    let i = 0;
    for await (const record of records) {
      if (i >= limit) break;
      const name = `lme_${i}_${Math.random().toString(36).slice(2, 8)}`;
      const retriever = new Retriever({
        client: store.client,
        name,
        schema,
        embedFn: embedder.embed,
        rerankFn,
      });

      let chunks = chunkRecord(record, chunkMode);
      if (factsOn && config.factExtractor !== undefined) {
        const startedAt = Date.now();
        const { chunks: factChunks, llmCalls } = await consolidateRecordFacts(
          record,
          config.factExtractor,
        );
        costReport.record('facts', { llmCalls, latencyMs: Date.now() - startedAt });
        chunks = [...chunks, ...factChunks];
      }
      totalChunks += chunks.length;

      await retriever.createIndex();
      // Batch-embed every chunk up front so the per-entry embed calls inside
      // upsert hit the warm cache instead of making one serial HTTP request
      // each — the dominant cost on large haystacks (longmemeval_m).
      await embedder.prewarm?.(chunks.map((c) => c.text));
      await retriever.upsert(chunks);

      if (store.isReal) {
        // A hit-count check can pass while HNSW is still backfilling. Wait for the
        // index to report every chunk ingested and fully indexed so recall is not
        // measured on an incomplete graph.
        const settled = await pollUntil(async () => {
          const h = await retriever.health();
          // percentIndexed is normalized to a 0-100 scale; require full coverage.
          return h.numDocs >= chunks.length && h.percentIndexed >= 100;
        });
        if (!settled) {
          console.warn(
            `index ${name} did not settle within the poll window (record ${i + 1}); recall may be undercounted`,
          );
        }
      }

      // Over-fetch fetchK candidates and hybrid-rerank them, then keep the top k
      // so recall/QA are measured on exactly k hits in both modes. When rerank is
      // off, fetchK === k and this is a plain top-k query.
      const pool = await retriever.query({
        text: record.question,
        k: fetchK,
        ...(useRerank ? { hybrid: 'rerank' as const } : {}),
      });
      const hits = pool.slice(0, k);
      const hit = recordIsHit(hits, record.answer_session_ids);

      const stats = bump(byType, record.question_type);
      stats.total++;
      total++;
      if (hit) {
        stats.recallHits++;
        recallHits++;
      }

      if (qaRun && reader !== null && judge !== null) {
        // Temporal-reasoning questions need the session date (stored on the chunk's
        // `date` tag) and the question's asked-on date in the prompt; passing only
        // hit.text strips both and depresses temporal QA. Prefix each excerpt with
        // its date and carry question_date into the question the reader sees.
        //
        // When the assemble lever is on, assembleContexts renders the wider rerank
        // `pool` into the reader's contexts; dedup / MMR / chronological grouping
        // apply only via the opt-in assembleOptions (env-wired in run.ts). Recall
        // above is still measured on the unmodified rerank top-k.
        let readerPool = pool;
        if (temporalOn) {
          const startedAt = Date.now();
          readerPool = resolveTemporal(pool, { asOf: record.question_date });
          costReport.record('temporal', { latencyMs: Date.now() - startedAt });
        }

        let contexts: string[];
        if (assembleOn) {
          const startedAt = Date.now();
          contexts = assembleContexts(readerPool, k, config.assembleOptions ?? {});
          costReport.record('assemble', { latencyMs: Date.now() - startedAt });
        } else {
          contexts = readerPool
            .slice(0, k)
            .map((h) => (h.fields.date ? `[${h.fields.date}] ${h.text}` : h.text));
        }
        const question =
          record.question_date !== undefined && record.question_date !== ''
            ? `${record.question} (question asked on ${record.question_date})`
            : record.question;
        const answer = await reader.answer(question, contexts);
        // Grade against the same date-anchored question the reader saw, so the
        // judge has the temporal anchor too and doesn't mismark temporal items.
        const correct = await judge.grade(question, record.answer, answer);
        if (correct) {
          stats.qaCorrect++;
          qaCorrect++;
        }
      }

      await retriever.delete(chunks.map((c) => c.id)).catch(() => {});
      await retriever.dropIndex().catch(() => {});
      i++;
    }
  } finally {
    await embedder.flush?.();
  }

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
    levers,
    costs: costReport.entries(),
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

  if (summary.levers.length > 0) {
    lines.push('');
    lines.push(`Levers (ablation order): ${summary.levers.join(' → ')}`);
    for (const cost of summary.costs) {
      lines.push(
        `  ${cost.name.padEnd(14)} embed=${cost.embedCalls}  llm=${cost.llmCalls}  +${cost.latencyMs}ms`,
      );
    }
  }

  lines.push('');
  return lines.join('\n');
}
