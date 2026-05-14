/**
 * LLM-as-judge example for @betterdb/semantic-cache
 *
 * Uses real OpenAI embeddings (text-embedding-3-small) so paraphrases
 * actually land in the uncertainty band and trigger the judge.
 *
 * Prerequisites:
 *   - Valkey 8.0+ with valkey-search at localhost:6399
 *   - OPENAI_API_KEY env var set
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... pnpm start
 */
import Valkey from 'iovalkey';
import { SemanticCache } from '@betterdb/semantic-cache';
import { createOpenAIEmbed } from '@betterdb/semantic-cache/embed/openai';

if (!process.env.OPENAI_API_KEY) {
  console.error('Error: OPENAI_API_KEY env var is required.');
  process.exit(1);
}

const host = process.env.VALKEY_HOST ?? 'localhost';
const port = parseInt(process.env.VALKEY_PORT ?? '6399', 10);

const client = new Valkey({ host, port });

// text-embedding-3-small: paraphrases land at ~0.10-0.20, unrelated at 0.30+
const cache = new SemanticCache({
  client,
  embedFn: createOpenAIEmbed({ model: 'text-embedding-3-small' }),
  name: 'example_judge',
  defaultThreshold: 0.20,   // hit if distance <= 0.20
  uncertaintyBand: 0.08,    // uncertain if 0.12 < distance <= 0.20 → judge fires
  embeddingCache: { enabled: true },
});

// Mock judge: accepts if the response contains key words from the prompt.
// Replace this with a real LLM call in production.
async function mockJudge(input: {
  prompt: string;
  response: string;
  similarity: number;
  threshold: number;
  category: string | undefined;
}): Promise<boolean> {
  const promptWords = new Set(input.prompt.toLowerCase().split(/\W+/).filter(Boolean));
  const responseWords = input.response.toLowerCase().split(/\W+/).filter(Boolean);
  const overlap = responseWords.filter((w) => promptWords.has(w)).length;
  const accept = overlap >= 2;
  console.log(
    `  [judge] similarity=${input.similarity.toFixed(4)} overlap=${overlap} → ${accept ? 'ACCEPT' : 'REJECT'}`,
  );
  return accept;
}

async function main() {
  console.log('=== LLM-as-judge example (real embeddings) ===\n');

  await cache.initialize();
  await cache.flush();
  await cache.initialize();
  console.log('Cache initialized.\n');

  await cache.store('What is the capital of France?', 'The capital of France is Paris.');
  await cache.store('How does photosynthesis work?', 'Photosynthesis converts sunlight into energy.');
  console.log('Seeded 2 entries.\n');

  await new Promise((r) => setTimeout(r, 500));

  // Paraphrase — should land in the uncertainty band and trigger the judge
  const q1 = "What is France's capital city?";
  console.log(`Query: "${q1}"`);
  const r1 = await cache.check(q1, {
    judge: { judgeFn: mockJudge, onError: 'accept', timeoutMs: 5000 },
  });
  console.log(`  hit=${r1.hit} confidence=${r1.confidence} response="${r1.response ?? '—'}"`);
  if (r1.nearestMiss) {
    console.log(`  nearestMiss.deltaToThreshold=${r1.nearestMiss.deltaToThreshold.toFixed(4)}`);
  }
  console.log();

  // Unrelated — clear miss, judge not invoked
  const q2 = 'What is the speed of light?';
  console.log(`Query: "${q2}"`);
  const r2 = await cache.check(q2, {
    judge: { judgeFn: mockJudge, onError: 'accept', timeoutMs: 5000 },
  });
  console.log(`  hit=${r2.hit} confidence=${r2.confidence}`);
  console.log();

  // Exact match — high confidence, judge not invoked
  const q3 = 'How does photosynthesis work?';
  console.log(`Query: "${q3}" (exact match)`);
  const r3 = await cache.check(q3, {
    judge: { judgeFn: mockJudge, onError: 'accept', timeoutMs: 5000 },
  });
  console.log(`  hit=${r3.hit} confidence=${r3.confidence} response="${r3.response ?? '—'}"`);

  await cache.flush();
  await client.quit();
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
