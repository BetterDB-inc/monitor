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
// Replace this with a real LLM call in production; pass input.signal to your
// HTTP client (fetch, OpenAI/Anthropic SDK) so timeout cancels the request.
async function mockJudge(input: {
  prompt: string;
  response: string;
  similarity: number;
  threshold: number;
  category: string | undefined;
  signal: AbortSignal;
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

  const entries = [
    { prompt: 'What is the capital of France?',  response: 'The capital of France is Paris.' },
    { prompt: 'How does photosynthesis work?',   response: 'Photosynthesis converts sunlight into energy.' },
  ];
  for (const e of entries) await cache.store(e.prompt, e.response);
  console.log('Seeded entries:');
  for (const e of entries) console.log(`  • "${e.prompt}"`);
  console.log();

  await new Promise((r) => setTimeout(r, 500));

  function logResult(r: Awaited<ReturnType<typeof cache.check>>) {
    if (r.hit) {
      console.log(`  → HIT  confidence=${r.confidence}  distance=${r.similarity?.toFixed(4)}`);
      console.log(`         matched: "${r.response}"`);
    } else if (r.similarity !== undefined) {
      console.log(`  → MISS  nearest distance=${r.similarity.toFixed(4)}  (threshold=${cache._defaultThreshold})`);
    } else {
      console.log(`  → MISS  (no candidate found)`);
    }
  }

  // Paraphrase — lands in uncertainty band, judge fires
  const q1 = "What is France's capital city?";
  console.log(`Query: "${q1}"`);
  const r1 = await cache.check(q1, {
    judge: { judgeFn: mockJudge, onError: 'accept', timeoutMs: 5000 },
  });
  logResult(r1);
  console.log();

  // Unrelated — clear miss, judge not invoked
  const q2 = 'What is the speed of light?';
  console.log(`Query: "${q2}"`);
  const r2 = await cache.check(q2, {
    judge: { judgeFn: mockJudge, onError: 'accept', timeoutMs: 5000 },
  });
  logResult(r2);
  console.log();

  // Exact match — high confidence, judge not invoked
  const q3 = 'How does photosynthesis work?';
  console.log(`Query: "${q3}"`);
  const r3 = await cache.check(q3, {
    judge: { judgeFn: mockJudge, onError: 'accept', timeoutMs: 5000 },
  });
  logResult(r3);

  await cache.flush();
  await client.quit();
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
