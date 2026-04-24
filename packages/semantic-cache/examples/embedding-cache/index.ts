/**
 * Embedding cache example for @betterdb/semantic-cache
 *
 * Demonstrates that repeated check() calls on the same text skip the embedFn
 * when the embedding cache is enabled, by wrapping embedFn in a counter.
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

let embedCallCount = 0;

function trackingEmbed(text: string): Promise<number[]> {
  embedCallCount++;
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

async function runWithEmbeddingCache(enabled: boolean): Promise<void> {
  embedCallCount = 0;

  const cache = new SemanticCache({
    client,
    embedFn: trackingEmbed,
    name: `example_emb_${enabled ? 'on' : 'off'}`,
    defaultThreshold: 0.2,
    embeddingCache: { enabled, ttl: 3600 },
  });

  await cache.initialize();
  await cache.flush();
  await cache.initialize();

  const text = 'What is the capital of France?';

  // First call
  await cache.check(text);
  const afterFirst = embedCallCount;

  // Second call with same text
  await cache.check(text);
  const afterSecond = embedCallCount;

  // Third call with different text
  await cache.check('Who invented the telephone?');
  const afterThird = embedCallCount;

  console.log(`  After 1st call (same text):  ${afterFirst} embedFn call(s)`);
  console.log(`  After 2nd call (same text):  ${afterSecond} embedFn call(s) ${enabled && afterSecond === afterFirst ? '[cached!]' : ''}`);
  console.log(`  After 3rd call (diff text):  ${afterThird} embedFn call(s)`);

  await cache.flush();
}

async function main() {
  console.log('=== Embedding cache example ===\n');

  console.log('-- With embedding cache ENABLED --');
  await runWithEmbeddingCache(true);
  console.log();

  console.log('-- With embedding cache DISABLED --');
  await runWithEmbeddingCache(false);
  console.log();

  console.log('Key insight: when enabled, repeated check() on the same text');
  console.log('reads the cached Float32 vector from Valkey instead of calling embedFn.');

  await client.quit();
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
