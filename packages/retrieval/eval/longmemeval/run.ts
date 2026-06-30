import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createMockEmbedder, createOpenAIEmbedder } from './embed';
import { createMockStore, createRealStore } from './store';
import { createMockReader, createOpenAIReader } from './reader';
import { createMockJudge, createOpenAIJudge } from './judge';
import { loadRecords, sourceLabel } from './dataset';
import { runEval, formatSummary } from './runner';
import { resolveEnabledLevers, createCostReport } from './levers';
import { createMockFactExtractor, createOpenAIFactExtractor } from './facts';
import type { FactExtractor } from './facts';
import type { ChunkMode, Embedder, Judge, Reader, Store } from './types';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  const valkeyUrl = process.env.VALKEY_URL ?? 'redis://:devpassword@localhost:6384';
  const dataPath = process.env.LONGMEMEVAL_DATA;
  const limit = envInt('LONGMEMEVAL_LIMIT', 20);
  const k = envInt('LONGMEMEVAL_K', 10);
  // Over-fetch this many candidates and hybrid-rerank (dense + lexical) down to
  // k. Defaults to k → reranking off (baseline top-k). Set > k to enable.
  const rerankPool = Math.max(envInt('LONGMEMEVAL_RERANK_POOL', k), k);
  const chunkMode: ChunkMode = process.env.LONGMEMEVAL_CHUNK === 'turn' ? 'turn' : 'session';
  const qa = process.env.LONGMEMEVAL_QA === '1';
  const levers = resolveEnabledLevers(process.env);
  const costReport = createCostReport();

  let factExtractor: FactExtractor | undefined;
  if (levers.includes('facts')) {
    factExtractor =
      apiKey !== undefined && apiKey !== ''
        ? createOpenAIFactExtractor(apiKey)
        : createMockFactExtractor();
  }

  const cachePath = join(dirname(fileURLToPath(import.meta.url)), '.cache', 'embeddings.json');

  // EMBEDDER seam.
  let embedder: Embedder;
  if (apiKey !== undefined && apiKey !== '') {
    embedder = await createOpenAIEmbedder(apiKey, cachePath);
  } else {
    embedder = createMockEmbedder();
  }

  // STORE seam.
  let store: Store | null = await createRealStore(valkeyUrl);
  if (store === null) {
    store = createMockStore();
  }

  // READER + JUDGE seams (Tier 2 only).
  let reader: Reader | null = null;
  let judge: Judge | null = null;
  if (qa) {
    if (apiKey !== undefined && apiKey !== '') {
      reader = createOpenAIReader(apiKey);
      judge = createOpenAIJudge(apiKey);
    } else {
      reader = createMockReader();
      judge = createMockJudge();
    }
  }

  const records = loadRecords(dataPath, limit);
  const source = sourceLabel(dataPath);

  const tier = qa
    ? 'Tier 2 (retrieval + QA)'
    : store.isReal || embedder.dims === 1536
      ? 'Tier 1 (real recall)'
      : 'Tier 0 (offline)';

  console.log('='.repeat(64));
  console.log('LongMemEval retrieval harness — @betterdb/retrieval');
  console.log('='.repeat(64));
  console.log(`tier      : ${tier}`);
  console.log(`embedder  : ${embedder.name}  (dims=${embedder.dims})`);
  console.log(`store     : ${store.name}${store.isReal ? '' : '  (Valkey unreachable → mock)'}`);
  console.log(`reader    : ${reader === null ? 'disabled' : reader.name}`);
  console.log(`judge     : ${judge === null ? 'disabled' : judge.name}`);
  console.log(`dataset   : ${source}  (limit ${limit})`);
  const rerankLabel = rerankPool > k ? `hybrid pool=${rerankPool}→${k}` : 'off';
  console.log(
    `params    : limit=${limit} k=${k} chunk=${chunkMode} qa=${qa} rerank=${rerankLabel}`,
  );
  console.log(`levers    : ${levers.length > 0 ? levers.join(' → ') : 'none (baseline)'}`);
  console.log('='.repeat(64));

  try {
    const summary = await runEval({
      records,
      embedder,
      store,
      reader,
      judge,
      k,
      chunkMode,
      limit,
      rerankPool,
      levers,
      costReport,
      factExtractor,
    });
    console.log(formatSummary(summary));
  } finally {
    await store.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
