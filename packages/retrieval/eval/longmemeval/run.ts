import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createMockEmbedder, createOpenAIEmbedder } from './embed';
import { createMockStore, createRealStore } from './store';
import { createMockReader, createOpenAIReader } from './reader';
import { createMockJudge, createOpenAIJudge } from './judge';
import { loadRecords, sourceLabel } from './dataset';
import { runEval, formatSummary } from './runner';
import { resolveEnabledLevers, createCostReport } from './levers';
import { resolveAssembleOptions } from './assemble';
import {
  createMockFactExtractor,
  createOpenAIFactExtractor,
  DEFAULT_FACTS_CONCURRENCY,
} from './facts';
import type { FactExtractor } from './facts';
import { createMockCrossEncoderScorer, createOpenAICrossEncoderScorer } from './cross-encoder';
import type { CrossEncoderScorer } from './cross-encoder';
import { createMockDecomposer, createOpenAIDecomposer } from './decompose';
import type { QueryDecomposer } from './decompose';
import { createMockEntityLinker, createOpenAIEntityLinker } from './graph';
import type { EntityLinker } from './graph';
import {
  createMockPreferenceExtractor,
  createOpenAIPreferenceExtractor,
  createOpenAIPreferenceJudge,
  createPreferenceAwareJudge,
} from './preference';
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
  const factsConcurrency = envInt('LONGMEMEVAL_FACTS_CONCURRENCY', DEFAULT_FACTS_CONCURRENCY);
  const levers = resolveEnabledLevers(process.env);
  const costReport = createCostReport();
  const assembleOptions = resolveAssembleOptions(process.env);

  let factExtractor: FactExtractor | undefined;
  if (levers.includes('facts')) {
    factExtractor =
      apiKey !== undefined && apiKey !== ''
        ? createOpenAIFactExtractor(apiKey)
        : createMockFactExtractor();
  }

  let crossEncoderScorer: CrossEncoderScorer | undefined;
  if (levers.includes('rerank-cross')) {
    crossEncoderScorer =
      apiKey !== undefined && apiKey !== ''
        ? createOpenAICrossEncoderScorer(apiKey)
        : createMockCrossEncoderScorer();
  }

  let decomposer: QueryDecomposer | undefined;
  if (levers.includes('decompose')) {
    decomposer =
      apiKey !== undefined && apiKey !== ''
        ? createOpenAIDecomposer(apiKey)
        : createMockDecomposer();
  }

  let entityLinker: EntityLinker | undefined;
  if (levers.includes('graph')) {
    entityLinker =
      apiKey !== undefined && apiKey !== ''
        ? createOpenAIEntityLinker(apiKey)
        : createMockEntityLinker();
  }
  const graphHops = envInt('LONGMEMEVAL_GRAPH_HOPS', 2);
  const graphMaxFacts = envInt('LONGMEMEVAL_GRAPH_MAX_FACTS', 5);

  let preferenceExtractor: FactExtractor | undefined;
  if (levers.includes('preference')) {
    preferenceExtractor =
      apiKey !== undefined && apiKey !== ''
        ? createOpenAIPreferenceExtractor(apiKey)
        : createMockPreferenceExtractor();
  }
  const preferencePromoteCap = envInt('LONGMEMEVAL_PREF_PROMOTE', 2);

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
      // Preference lever: recommendation-shaped questions are graded with the
      // rubric validated by diag-preference.ts; everything else stays on the
      // generic judge so other types cannot regress from the rubric.
      if (levers.includes('preference')) {
        judge = createPreferenceAwareJudge(createOpenAIPreferenceJudge(apiKey), judge);
      }
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
  if (levers.includes('assemble')) {
    // Without any structure option the assemble lever is a render-only pass —
    // say so in the banner instead of implying a meaningful ablation point.
    const features = [
      assembleOptions.dedupThreshold !== undefined
        ? `dedup=${assembleOptions.dedupThreshold}`
        : null,
      assembleOptions.mmrLambda !== undefined ? `mmr=${assembleOptions.mmrLambda}` : null,
      assembleOptions.group === true ? 'group' : null,
    ].filter((feature): feature is string => {
      return feature !== null;
    });
    console.log(
      `assemble  : ${features.length > 0 ? features.join(' ') : 'render-only (set LONGMEMEVAL_DEDUP_THRESHOLD / LONGMEMEVAL_MMR_LAMBDA / LONGMEMEVAL_GROUP)'}`,
    );
  }
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
      assembleOptions,
      factExtractor,
      factsConcurrency,
      crossEncoderScorer,
      decomposer,
      entityLinker,
      graphHops,
      graphMaxFacts,
      preferenceExtractor,
      preferencePromoteCap,
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
