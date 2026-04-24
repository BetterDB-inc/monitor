/**
 * Threshold effectiveness tuning example for @betterdb/semantic-cache
 *
 * Demonstrates thresholdEffectiveness() analyzing the rolling score window
 * and recommending threshold adjustments.
 *
 * No API key required - uses a mock embedder and simulated queries.
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

// Parameterized mock embedder for controllable similarity
function makeEmbedder(jitter: number) {
  return (text: string): Promise<number[]> => {
    const dim = 16;
    const words = text.toLowerCase().split(/\W+/).filter(Boolean);
    const vec = new Array<number>(dim).fill(0);
    for (const w of words) {
      for (let i = 0; i < Math.min(w.length, dim); i++) {
        vec[i % dim] += w.charCodeAt(i) / 128;
      }
    }
    // Add controlled noise
    for (let i = 0; i < dim; i++) {
      vec[i] += (Math.random() - 0.5) * jitter;
    }
    const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1;
    return Promise.resolve(vec.map((x) => x / norm));
  };
}

const client = new Valkey({ host, port });

// Use a fairly loose threshold to generate uncertain hits
const THRESHOLD = 0.15;
const cache = new SemanticCache({
  client,
  embedFn: makeEmbedder(0.3), // moderate noise -> some uncertain hits
  name: 'example_threshold',
  defaultThreshold: THRESHOLD,
  uncertaintyBand: 0.05,
  embeddingCache: { enabled: false },
});

// Seed prompts
const SEED_PROMPTS = [
  'What is machine learning?',
  'How does gradient descent work?',
  'What is a neural network?',
  'Explain backpropagation in simple terms',
  'What is overfitting in machine learning?',
];

// Query variations (some will hit, some might be uncertain, some miss)
const QUERY_PROMPTS = [
  'What is machine learning?',
  'Explain machine learning simply',
  'What is ML?',
  'How does gradient descent optimize?',
  'Explain gradient descent',
  'What is a deep neural network?',
  'Describe neural networks',
  'What is backpropagation?',
  'How does backpropagation work?',
  'What is model overfitting?',
  'What is the best pizza topping?', // unrelated
  'How do you make pasta?', // unrelated
];

async function main() {
  console.log('=== Threshold effectiveness tuning example ===\n');

  console.log('WARNING: Flushing cache - deletes all existing cache data.');
  await cache.initialize();
  await cache.flush();
  await cache.initialize();
  console.log(`Cache initialized. Threshold: ${THRESHOLD}\n`);

  // -- Seed the cache --
  console.log(`-- Seeding cache with ${SEED_PROMPTS.length} entries --`);
  for (const prompt of SEED_PROMPTS) {
    await cache.store(prompt, `Answer for: ${prompt}`);
  }
  console.log('  Seeding complete.\n');

  // -- Run queries to populate the similarity window --
  console.log(`-- Running ${QUERY_PROMPTS.length} queries to build similarity window --`);
  let hits = 0;
  let misses = 0;
  let uncertain = 0;

  for (const query of QUERY_PROMPTS) {
    const result = await cache.check(query);
    if (result.hit) {
      hits++;
      if (result.confidence === 'uncertain') uncertain++;
      process.stdout.write(`  HIT${result.confidence === 'uncertain' ? '~' : ' '}`);
    } else {
      misses++;
      process.stdout.write('  MISS');
    }
    if (result.similarity !== undefined) {
      process.stdout.write(` (${result.similarity.toFixed(3)})`);
    }
    process.stdout.write(` - "${query.slice(0, 35)}"\n`);
  }
  console.log();

  // -- Get threshold recommendations --
  console.log('-- Threshold Effectiveness Analysis --');
  const analysis = await cache.thresholdEffectiveness({ minSamples: 5 });

  console.log(`Category: ${analysis.category}`);
  console.log(`Sample count: ${analysis.sampleCount}`);
  console.log(`Current threshold: ${analysis.currentThreshold}`);
  console.log(`Hit rate: ${(analysis.hitRate * 100).toFixed(1)}%`);
  console.log(`Uncertain hit rate: ${(analysis.uncertainHitRate * 100).toFixed(1)}%`);
  console.log(`Near-miss rate: ${(analysis.nearMissRate * 100).toFixed(1)}%`);
  console.log(`Avg hit similarity: ${analysis.avgHitSimilarity.toFixed(4)}`);
  console.log(`Avg miss similarity: ${analysis.avgMissSimilarity.toFixed(4)}`);
  console.log();
  console.log(`Recommendation: ${analysis.recommendation.toUpperCase()}`);
  if (analysis.recommendedThreshold !== undefined) {
    console.log(`Recommended threshold: ${analysis.recommendedThreshold.toFixed(4)}`);
  }
  console.log(`Reasoning: ${analysis.reasoning}`);

  await cache.flush();
  await client.quit();
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
