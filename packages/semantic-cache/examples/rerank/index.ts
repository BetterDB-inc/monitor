/**
 * Rerank hook example for @betterdb/semantic-cache
 *
 * Demonstrates the rerank option for selecting the best candidate from
 * top-k similarity results using a custom ranking function.
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
  name: 'example_rerank',
  defaultThreshold: 0.3, // loose to retrieve multiple candidates
  embeddingCache: { enabled: false },
});

// Rerank strategy 1: pick longest response (most detailed)
async function pickLongest(
  _query: string,
  candidates: Array<{ response: string; similarity: number }>,
): Promise<number> {
  let maxIdx = 0;
  for (let i = 1; i < candidates.length; i++) {
    if (candidates[i].response.length > candidates[maxIdx].response.length) {
      maxIdx = i;
    }
  }
  return maxIdx;
}

// Rerank strategy 2: reject if similarity score is above a tight threshold (0.05).
// With the mock embedder, ML queries are very close (< 0.05), so this will pass.
// In production with real embeddings, paraphrases typically land at 0.05-0.15,
// and truly different questions at 0.2+. Tune this value for your use case.
async function strictQuality(
  _query: string,
  candidates: Array<{ response: string; similarity: number }>,
): Promise<number> {
  // Only accept a hit if the match is extremely close (essentially exact phrasing)
  const acceptable = candidates.findIndex((c) => c.similarity < 0.001);
  return acceptable; // -1 if none pass (miss)
}

async function main() {
  console.log('=== Rerank hook example ===\n');

  console.log('WARNING: Flushing cache - deletes all existing cache data.');
  await cache.initialize();
  await cache.flush();
  await cache.initialize();
  console.log('Cache initialized and flushed.\n');

  // Seed multiple entries on similar topics
  console.log('-- Seeding cache --');
  await cache.store('What is machine learning?', 'ML is a subset of AI.');
  await cache.store('How does machine learning work?', 'Machine learning works by training models on data to recognize patterns and make predictions.');
  await cache.store('Explain machine learning', 'Machine learning enables computers to learn from experience without being explicitly programmed. It uses statistical techniques to build mathematical models from sample data.');
  console.log('  Stored 3 entries (short, medium, long responses).\n');

  const query = 'Tell me about machine learning';

  // -- Without rerank: returns top-1 by similarity --
  console.log(`-- Without rerank (top-1 by similarity): "${query}" --`);
  const noRerank = await cache.check(query);
  if (noRerank.hit) {
    console.log(`  HIT: "${noRerank.response}"`);
    console.log(`  Similarity: ${noRerank.similarity?.toFixed(4)}`);
  } else {
    console.log('  MISS');
  }
  console.log();

  // -- With rerank: longest response wins --
  console.log(`-- With rerank (longest response wins): "${query}" --`);
  const withRerank = await cache.check(query, {
    rerank: { k: 3, rerankFn: pickLongest },
  });
  if (withRerank.hit) {
    console.log(`  HIT: "${withRerank.response}"`);
  } else {
    console.log('  MISS');
  }
  console.log();

  // -- With strict quality rerank: reject loose matches --
  console.log(`-- With strict quality rerank (reject similarity > 0.2): "${query}" --`);
  const strictResult = await cache.check(query, {
    rerank: { k: 3, rerankFn: strictQuality },
  });
  if (strictResult.hit) {
    console.log(`  HIT: "${strictResult.response}"`);
  } else {
    console.log('  MISS - no candidate passed the quality threshold.');
  }

  await cache.flush();
  await client.quit();
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
