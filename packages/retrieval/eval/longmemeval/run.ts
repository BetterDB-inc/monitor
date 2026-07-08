import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createMockEmbedder, createOpenAIEmbedder } from './embed';
import { createMockStore, createRealStore } from './store';
import { createMockReader, createOpenAIReader } from './reader';
import { createMockJudge, createOpenAIJudge } from './judge';
import { loadRecords, parseTypeList, sourceLabel } from './dataset';
import { runEval, formatSummary } from './runner';
import { resolveEnabledLevers, createCostReport } from './levers';
import { resolveAssembleOptions } from './assemble';
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
  // Restrict the run to one or more question_types (comma-separated, e.g.
  // "temporal-reasoning,multi-session") so a subset can be evaluated in
  // isolation. Unset = all types.
  const questionType = process.env.LONGMEMEVAL_TYPE;
  // Stratified slice: keep this many records of EACH question_type (balanced
  // across all types) instead of the flat limit. Unset/0 = flat limit. Because
  // _m/_s are grouped by type on disk, this is the only way to get an even
  // per-type sample for a paired A/B.
  const perType = envInt('LONGMEMEVAL_PER_TYPE', 0);
  // LongMemEval has 6 question_types. In stratified mode the total = perType x
  // (number of selected types), so the runner's per-record `limit` cap must be
  // raised to that total or it would truncate the slice. Count DISTINCT types
  // (deduped, mirroring loadRecords' Set-based allow-list) so a repeated type
  // does not inflate the cap; an empty/whitespace-only filter selects all
  // types, so fall back to the full count (never zero, which would stop the
  // run at once while loadRecords still emitted a stratified sample).
  const LME_TYPE_COUNT = 6;
  // Same parse as loadRecords' allow-list (via the shared helper) so the cap
  // here and the early-stop there can never disagree.
  const selectedTypes = parseTypeList(questionType);
  const typeCount = selectedTypes.size > 0 ? selectedTypes.size : LME_TYPE_COUNT;
  const runLimit = perType > 0 ? perType * typeCount : limit;
  const levers = resolveEnabledLevers(process.env);
  const costReport = createCostReport();
  const assembleOptions = resolveAssembleOptions(process.env);

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

  // Pass typeCount so stratified mode can early-stop after the caps fill even
  // when no explicit LONGMEMEVAL_TYPE filter is set, instead of scanning a
  // multi-GB dataset to EOF.
  const records = loadRecords(dataPath, limit, questionType, perType, typeCount);
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
  const limitLabel = perType > 0 ? `${perType}/type x${typeCount}=${runLimit}` : `${limit}`;
  console.log(
    `dataset   : ${source}  (limit ${limitLabel}${questionType ? `, type=${questionType}` : ''})`,
  );
  const rerankLabel = rerankPool > k ? `hybrid pool=${rerankPool}→${k}` : 'off';
  console.log(
    `params    : limit=${limitLabel} k=${k} chunk=${chunkMode} qa=${qa} rerank=${rerankLabel}`,
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
      limit: runLimit,
      rerankPool,
      levers,
      costReport,
      assembleOptions,
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
