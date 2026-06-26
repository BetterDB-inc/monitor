/**
 * READ-ONLY DIAGNOSTIC — single-session-preference grader flip measurement.
 *
 * For every single-session-preference record in longmemeval_s, this rebuilds the
 * record's index, retrieves k hits, asks the UNCHANGED reader for an answer, then
 * grades that one answer twice: with the production generic judge prompt (exactly
 * as judge.ts grades) and with a proposed preference-aware rubric. It reports the
 * flip count and dumps every flipped record in full for eyeball review.
 *
 * It modifies NOTHING in the harness grading path — judge.ts/reader.ts are reused
 * as-is; the preference rubric lives only inside this diagnostic.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Retriever } from '../../src/index';
import type { RetrievalSchema } from '../../src/index';
import { createOpenAIEmbedder } from './embed';
import { createRealStore } from './store';
import { createOpenAIReader, chat } from './reader';
import { createOpenAIJudge } from './judge';
import { loadDataset } from './dataset';
import { chunkRecord } from './adapter';
import type { LmeRecord } from './types';

const READER_MODEL = process.env.LONGMEMEVAL_READER_MODEL ?? 'gpt-4o';
const JUDGE_MODEL = process.env.LONGMEMEVAL_JUDGE_MODEL ?? 'gpt-4o';
const K = 10;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function pollUntil(predicate: () => Promise<boolean>, attempts = 40): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) return true;
    await sleep(100);
  }
  return false;
}

function buildSchema(dims: number): RetrievalSchema {
  return {
    fields: { session_id: { type: 'tag' }, date: { type: 'tag' } },
    vector: { metric: 'cosine', algorithm: 'hnsw', dims },
  };
}

/** Proposed preference-aware grader: mirrors judge.ts parse exactly, swaps the rubric. */
async function gradePreference(
  apiKey: string,
  question: string,
  gold: string,
  predicted: string,
): Promise<boolean> {
  const system =
    'You are an impartial grader for a long-term memory QA benchmark. The gold answer ' +
    'describes the user\'s stated preferences. Decide whether the model answer is consistent ' +
    'with and honors those preferences (it need not restate them verbatim; a recommendation or ' +
    'response that aligns with the preferences is correct). Reply with exactly one word: ' +
    '"correct" or "incorrect".';
  const user = `Question: ${question}\nGold answer: ${gold}\nModel answer: ${predicted}\n\nVerdict:`;
  const verdict = (await chat(apiKey, JUDGE_MODEL, system, user)).toLowerCase();
  const saysCorrect = /\bcorrect\b/.test(verdict);
  const negated =
    /\bincorrect\b/.test(verdict) || /\b(?:not|partially|isn't)\b[\s\S]{0,20}\bcorrect\b/.test(verdict);
  return saysCorrect && !negated;
}

/** One-sentence rationale for display only (does not affect the verdict). */
async function explain(
  apiKey: string,
  rubric: 'generic' | 'preference',
  question: string,
  gold: string,
  predicted: string,
): Promise<string> {
  const lens =
    rubric === 'generic'
      ? 'whether the model answer conveys the same key information as the gold answer'
      : 'whether the model answer honors the user preferences described in the gold answer';
  const system = `You are grading a QA answer. In ONE short sentence, explain ${lens}.`;
  const user = `Question: ${question}\nGold answer: ${gold}\nModel answer: ${predicted}\n\nOne-sentence reason:`;
  return (await chat(apiKey, JUDGE_MODEL, system, user)).replace(/\s+/g, ' ').trim();
}

interface Row {
  id: string;
  question: string;
  gold: string;
  answer: string;
  generic: boolean;
  preference: boolean;
  genericWhy: string;
  preferenceWhy: string;
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey === undefined || apiKey === '') throw new Error('OPENAI_API_KEY required');
  const valkeyUrl = process.env.VALKEY_URL ?? 'redis://:devpassword@localhost:6384';
  const dataPath =
    process.env.LONGMEMEVAL_DATA ??
    join(dirname(fileURLToPath(import.meta.url)), 'longmemeval_s_cleaned.json');
  const cachePath = join(dirname(fileURLToPath(import.meta.url)), '.cache', 'embeddings.json');

  const embedder = await createOpenAIEmbedder(apiKey, cachePath);
  const store = await createRealStore(valkeyUrl);
  if (store === null) throw new Error(`Valkey unreachable at ${valkeyUrl}`);
  const reader = createOpenAIReader(apiKey);
  const genericJudge = createOpenAIJudge(apiKey);

  const { records } = await loadDataset(dataPath);
  const prefs = records.filter((r) => r.question_type === 'single-session-preference');

  console.log('='.repeat(72));
  console.log('PREFERENCE GRADER FLIP DIAGNOSTIC (read-only)');
  console.log('='.repeat(72));
  console.log(`reader=${reader.name}  generic-judge=${genericJudge.name}  pref-judge=openai-judge:${JUDGE_MODEL}`);
  console.log(`records=${prefs.length}  k=${K}  dataset=${dataPath}`);
  console.log('='.repeat(72));

  const schema = buildSchema(embedder.dims);
  const rows: Row[] = [];

  try {
    for (let i = 0; i < prefs.length; i++) {
      const record: LmeRecord = prefs[i];
      const name = `diagpref_${i}_${Math.random().toString(36).slice(2, 8)}`;
      const retriever = new Retriever({ client: store.client, name, schema, embedFn: embedder.embed });
      const chunks = chunkRecord(record, 'session');
      await retriever.createIndex();
      await retriever.upsert(chunks);
      const settled = await pollUntil(async () => {
        const h = await retriever.health();
        return h.numDocs >= chunks.length && h.percentIndexed >= 100;
      });
      if (!settled) console.warn(`  index ${name} did not settle (record ${i + 1})`);

      const hits = await retriever.query({ text: record.question, k: K });
      // Mirror runner.ts exactly: date-prefixed contexts + date-anchored question.
      const contexts = hits.map((h) => (h.fields.date ? `[${h.fields.date}] ${h.text}` : h.text));
      const question =
        record.question_date !== undefined && record.question_date !== ''
          ? `${record.question} (question asked on ${record.question_date})`
          : record.question;
      const answer = await reader.answer(question, contexts);

      const generic = await genericJudge.grade(question, record.answer, answer);
      const preference = await gradePreference(apiKey, question, record.answer, answer);
      const genericWhy = await explain(apiKey, 'generic', question, record.answer, answer);
      const preferenceWhy = await explain(apiKey, 'preference', question, record.answer, answer);

      rows.push({
        id: record.question_id,
        question,
        gold: record.answer,
        answer,
        generic,
        preference,
        genericWhy,
        preferenceWhy,
      });
      console.log(
        `[${String(i + 1).padStart(2)}/${prefs.length}] ${record.question_id}  generic=${generic ? 'Y' : 'N'} pref=${preference ? 'Y' : 'N'}`,
      );

      await retriever.delete(chunks.map((c) => c.id)).catch(() => {});
      await retriever.dropIndex().catch(() => {});
    }
  } finally {
    await embedder.flush?.();
    await store.close();
  }

  const flips = rows.filter((r) => !r.generic && r.preference);
  const overcorrect = rows.filter((r) => r.generic && !r.preference);
  const bothPass = rows.filter((r) => r.generic && r.preference);
  const bothFail = rows.filter((r) => !r.generic && !r.preference);
  const genericCorrect = rows.filter((r) => r.generic).length;
  const prefCorrect = rows.filter((r) => r.preference).length;

  console.log('\n' + '='.repeat(72));
  console.log('SUMMARY');
  console.log('='.repeat(72));
  console.log(`generic judge correct   : ${genericCorrect}/${rows.length} (${((genericCorrect / rows.length) * 100).toFixed(1)}%)`);
  console.log(`preference judge correct: ${prefCorrect}/${rows.length} (${((prefCorrect / rows.length) * 100).toFixed(1)}%)`);
  console.log(`FLIPS (generic N -> pref Y)        : ${flips.length}`);
  console.log(`OVER-CORRECTION (generic Y -> pref N): ${overcorrect.length}`);
  console.log(`both pass : ${bothPass.length}   both fail : ${bothFail.length}`);

  const dump = (label: string, list: Row[]): void => {
    if (list.length === 0) return;
    console.log('\n' + '-'.repeat(72));
    console.log(`${label} (${list.length})`);
    console.log('-'.repeat(72));
    for (const r of list) {
      console.log(`\n# ${r.id}`);
      console.log(`Q    : ${r.question}`);
      console.log(`GOLD : ${r.gold}`);
      console.log(`ANS  : ${r.answer}`);
      console.log(`generic=${r.generic ? 'CORRECT' : 'INCORRECT'} | preference=${r.preference ? 'CORRECT' : 'INCORRECT'}`);
      console.log(`  generic-why : ${r.genericWhy}`);
      console.log(`  pref-why    : ${r.preferenceWhy}`);
    }
  };

  // Full dump of every flip (guardrail: user eyeballs that pref grades "honors", not just leniently).
  dump('FLIPPED RECORDS — generic INCORRECT, preference CORRECT', flips);
  // Over-corrections matter too: pref must not start failing answers the generic passed.
  dump('OVER-CORRECTIONS — generic CORRECT, preference INCORRECT', overcorrect);
  // Records still failing under both — context for the residual gap.
  dump('STILL INCORRECT UNDER BOTH', bothFail);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
