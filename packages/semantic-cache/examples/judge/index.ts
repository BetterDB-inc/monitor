/**
 * LLM-as-judge example for @betterdb/semantic-cache
 *
 * Demonstrates the judge option for adjudicating borderline cache hits.
 * Uses a mocked judgeFn — no real OpenAI or LLM dependency required.
 *
 * Prerequisites:
 *   - Valkey 8.0+ with valkey-search at localhost:6399
 *
 * Usage:
 *   pnpm install && pnpm start
 */
import Valkey from 'iovalkey';
import { SemanticCache } from '@betterdb/semantic-cache';

const host = process.env.VALKEY_HOST ?? 'localhost';
const port = parseInt(process.env.VALKEY_PORT ?? '6399', 10);

// Offline mock embedder: produces deterministic vectors from text.
function mockEmbed(text: string): Promise<number[]> {
  const dim = 16;
  const words = text.toLowerCase().split(/\W+/).filter(Boolean);
  const vec = new Array<number>(dim).fill(0);
  for (const w of words) {
    for (let i = 0; i < Math.min(w.length, dim); i++) {
      vec[i % dim] += w.charCodeAt(i) / 128;
    }
  }
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1;
  return Promise.resolve(vec.map((x) => x / norm));
}

const client = new Valkey({ host, port });

const cache = new SemanticCache({
  client,
  embedFn: mockEmbed,
  name: 'example_judge',
  defaultThreshold: 0.3,
  uncertaintyBand: 0.15,
  embeddingCache: { enabled: false },
});

// Mock judge: accepts when the response shares at least 2 words with the prompt.
// In production, replace this with a real LLM call.
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
  console.log('=== LLM-as-judge example ===\n');

  await cache.initialize();
  await cache.flush();
  await cache.initialize();
  console.log('Cache initialized.\n');

  await cache.store('What is the capital of France?', 'The capital of France is Paris.');
  await cache.store('How does photosynthesis work?', 'Photosynthesis converts sunlight into energy.');
  console.log('Seeded 2 entries.\n');

  await new Promise((r) => setTimeout(r, 500));

  const q1 = "What is France's capital city?";
  console.log(`Query: "${q1}"`);
  const r1 = await cache.check(q1, {
    judge: { judgeFn: mockJudge, onError: 'accept', timeoutMs: 2000 },
  });
  console.log(`  Result: hit=${r1.hit} confidence=${r1.confidence} response="${r1.response ?? '—'}"`);
  if (r1.nearestMiss) {
    console.log(`  nearestMiss.deltaToThreshold=${r1.nearestMiss.deltaToThreshold.toFixed(4)}`);
  }
  console.log();

  const q2 = 'What is the speed of light?';
  console.log(`Query: "${q2}"`);
  const r2 = await cache.check(q2, {
    judge: { judgeFn: mockJudge, onError: 'accept', timeoutMs: 2000 },
  });
  console.log(`  Result: hit=${r2.hit} confidence=${r2.confidence}`);
  console.log();

  const q3 = 'How does photosynthesis work?';
  console.log(`Query: "${q3}" (exact match)`);
  const r3 = await cache.check(q3, {
    judge: { judgeFn: mockJudge, onError: 'accept', timeoutMs: 2000 },
  });
  console.log(`  Result: hit=${r3.hit} confidence=${r3.confidence} response="${r3.response ?? '—'}"`);

  await cache.flush();
  await client.quit();
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
