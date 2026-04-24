/**
 * Batch check example for @betterdb/semantic-cache
 *
 * Demonstrates checkBatch() for pipelined multi-prompt lookups,
 * and compares timing against sequential check() calls.
 *
 * No API key required.
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

function mockEmbed(text: string): Promise<number[]> {
  const dim = 8;
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
  name: 'example_batch',
  defaultThreshold: 0.2,
  embeddingCache: { enabled: false },
});

const SEED = [
  { q: 'What is the capital of France?', a: 'Paris' },
  { q: 'What is the capital of Germany?', a: 'Berlin' },
  { q: 'What is the capital of Italy?', a: 'Rome' },
];

const QUERIES = [
  'What is the capital of France?',           // hit
  'Capital of Germany?',                       // near hit
  'Who invented the telephone?',               // miss
  'What is the capital of Italy?',             // hit
  'What is the best programming language?',    // miss
];

async function main() {
  console.log('=== Batch check example ===\n');

  console.log('WARNING: Flushing cache - deletes all existing cache data.');
  await cache.initialize();
  await cache.flush();
  await cache.initialize();
  console.log('Cache initialized and flushed.\n');

  // Seed
  console.log('-- Seeding cache --');
  for (const { q, a } of SEED) {
    await cache.store(q, a);
    console.log(`  Stored: "${q}"`);
  }
  console.log();

  // Sequential check
  console.log(`-- Sequential check() x${QUERIES.length} --`);
  const seqStart = performance.now();
  const seqResults = [];
  for (const q of QUERIES) {
    seqResults.push(await cache.check(q));
  }
  const seqMs = performance.now() - seqStart;

  // Batch check
  console.log(`-- checkBatch() x${QUERIES.length} --`);
  const batchStart = performance.now();
  const batchResults = await cache.checkBatch(QUERIES);
  const batchMs = performance.now() - batchStart;

  // Print results
  console.log('\n-- Results comparison --');
  console.log('Query'.padEnd(45) + 'Sequential'.padEnd(14) + 'Batch');
  console.log('-'.repeat(75));
  for (let i = 0; i < QUERIES.length; i++) {
    const seqHit = seqResults[i].hit ? `HIT(${seqResults[i].confidence})` : 'MISS';
    const batchHit = batchResults[i].hit ? `HIT(${batchResults[i].confidence})` : 'MISS';
    console.log(QUERIES[i].slice(0, 44).padEnd(45) + seqHit.padEnd(14) + batchHit);
  }

  console.log(`\nSequential: ${seqMs.toFixed(1)}ms | Batch: ${batchMs.toFixed(1)}ms`);
  if (batchMs < seqMs) {
    console.log(`Batch was ${((seqMs - batchMs) / seqMs * 100).toFixed(0)}% faster.`);
  }

  await cache.flush();
  await client.quit();
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
