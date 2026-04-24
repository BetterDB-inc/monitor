/**
 * Cost tracking example for @betterdb/semantic-cache
 *
 * Demonstrates:
 *   1. store() with inputTokens/outputTokens/model to record cost
 *   2. check() returning costSaved on hit
 *   3. stats() showing cumulative costSavedMicros
 *
 * No API key required - uses a mock embedder.
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

// Simple word-overlap mock embedder
function mockEmbed(text: string): Promise<number[]> {
  const words = text.toLowerCase().split(/\W+/).filter(Boolean);
  const dim = 16;
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

// Use default cost table (bundled LiteLLM prices)
const cache = new SemanticCache({
  client,
  embedFn: mockEmbed,
  name: 'example_cost',
  defaultThreshold: 0.25, // loose threshold for mock embedder
  embeddingCache: { enabled: false },
});

const PROMPTS = [
  { text: 'What is the capital of France?', answer: 'Paris is the capital of France.' },
  { text: 'What is the capital of Germany?', answer: 'Berlin is the capital of Germany.' },
  { text: 'Who wrote Romeo and Juliet?', answer: 'William Shakespeare wrote Romeo and Juliet.' },
];

const MODEL = 'gpt-4o-mini';
// Simulated token counts per response
const TOKENS = { input: 25, output: 15 };

async function main() {
  console.log('=== Cost tracking example ===\n');

  console.log('WARNING: Flushing cache - deletes all existing cache data.');
  await cache.initialize();
  await cache.flush();
  await cache.initialize();
  console.log('Cache initialized and flushed.\n');

  // -- Seed the cache with cost information --
  console.log('-- Seeding cache with cost-annotated entries --');
  for (const { text, answer } of PROMPTS) {
    await cache.store(text, answer, {
      model: MODEL,
      inputTokens: TOKENS.input,
      outputTokens: TOKENS.output,
    });
    console.log(`  Stored: "${text.slice(0, 40)}..."`);
  }
  console.log();

  // -- Query the cache 5 times (should all be hits) --
  console.log('-- Running 5 cache lookups --');
  let totalSaved = 0;
  const queries = [
    'What is the capital city of France?',
    'What is France\'s capital?',
    'Capital of Germany?',
    'Who is the author of Romeo and Juliet?',
    'Who wrote the play Romeo and Juliet?',
  ];

  for (const query of queries) {
    const result = await cache.check(query);
    if (result.hit) {
      const saved = result.costSaved ?? 0;
      totalSaved += saved;
      console.log(
        `  HIT: "${query.slice(0, 35)}..." | saved $${saved.toFixed(6)}`,
      );
    } else {
      console.log(`  MISS: "${query.slice(0, 35)}..."`);
    }
  }
  console.log();

  // -- Print total cost saved --
  const stats = await cache.stats();
  console.log('-- Cost Summary --');
  console.log(`Hits: ${stats.hits} / Requests: ${stats.total}`);
  console.log(`Total cost saved: $${(stats.costSavedMicros / 1_000_000).toFixed(6)}`);
  console.log(`(via cumulative stats): $${(stats.costSavedMicros / 1_000_000).toFixed(6)}`);

  await cache.flush();
  await client.quit();
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
