import Valkey from 'iovalkey';
import { SemanticCache, CacheCheckResult } from '@betterdb/semantic-cache';
import { mockEmbed, tokenise, STOP_WORDS } from './mock-embedder';

const USE_MOCK = process.argv.includes('--mock') || process.env.MOCK_EMBEDDINGS === 'true';

/** Real embedder — only constructed if not in mock mode. */
async function openaiEmbed(text: string): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'OPENAI_API_KEY environment variable is not set.\n' +
        'Run with --mock to use the built-in mock embedder instead:\n' +
        '  npm start -- --mock',
    );
  }
  // Lazy import so openai package is not loaded in mock mode
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey });
  const res = await client.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
  });
  return res.data[0].embedding;
}

const embedFn = USE_MOCK ? mockEmbed : openaiEmbed;

const storedPrompts = [
  'What is the capital of France?',
  'Who wrote Romeo and Juliet?',
  'What is the speed of light?',
];

function mockReason(prompt: string, result: CacheCheckResult): string {
  if (!USE_MOCK) return '';

  const queryTokens = new Set(tokenise(prompt));

  if (!result.hit) {
    const allStoredTokens = storedPrompts.flatMap(tokenise);
    const shared = [...new Set(allStoredTokens.filter(t => queryTokens.has(t)))];
    if (shared.length === 0) return '\n  (mock: no shared words with stored prompts)';
    return `\n  (mock: shares words [${shared.slice(0, 4).join(', ')}] but above threshold)`;
  }

  const matchedTokens = storedPrompts
    .flatMap(tokenise)
    .filter(t => queryTokens.has(t));
  const unique = [...new Set(matchedTokens)];
  if (unique.length === 0) return '\n  (mock: vector collision — no obvious shared words)';
  return `\n  (mock: shared words — ${unique.slice(0, 4).join(', ')})`;
}

async function main() {
  // --- Mode banner ---

  if (USE_MOCK) {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  MOCK MODE — no OpenAI API key needed');
    console.log('');
    console.log('  ⚠️  Uses WORD OVERLAP, not semantic understanding.');
    console.log('  A hit occurs when prompts share tokens — not because');
    console.log('  the embedder understands meaning. Real embedding models');
    console.log('  will produce different results for some queries.');
    console.log('');
    console.log(`  Threshold: 0.25 (mock) vs 0.10 (real mode default)`);
    console.log('  Run without --mock to use OpenAI text-embedding-3-small.');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log();
  } else {
    console.log('Running with OpenAI text-embedding-3-small');
  }
  console.log();

  // --- Setup ---

  // Mock embedder produces larger cosine distances than real models because
  // it relies on exact word overlap rather than learned semantic similarity.
  // Threshold 0.25 in mock mode gives meaningful demo hits/misses:
  //   "Capital city of France?" vs "What is the capital of France?" → 0.184 (hit)
  //   "Who wrote Hamlet?" vs "Who wrote Romeo and Juliet?"          → 0.592 (miss)
  const threshold = USE_MOCK ? 0.25 : 0.10;

  const url = process.env.VALKEY_URL;
  const port = url ? parseInt(new URL(url).port, 10) : 6399;
  const host = url ? new URL(url).hostname : 'localhost';

  const client = new Valkey({ host, port });

  const cache = new SemanticCache({
    name: 'example_basic',
    client,
    embedFn,
    defaultThreshold: threshold,
    defaultTtl: 300,
    categoryThresholds: USE_MOCK
      ? { geography: 0.25, literature: 0.25, science: 0.25 }
      : { geography: 0.12, literature: 0.12, science: 0.10 },
  });

  // --- Initialize ---

  console.log('Initializing cache...');
  await cache.initialize();
  console.log('Cache initialized.\n');

  // --- Store entries ---

  console.log('Storing 3 prompt/response pairs...');

  await cache.store('What is the capital of France?', 'Paris', {
    category: 'geography',
    model: 'gpt-4o',
  });
  console.log('  Stored: "What is the capital of France?" -> "Paris" [geography]');

  await cache.store('Who wrote Romeo and Juliet?', 'William Shakespeare', {
    category: 'literature',
    model: 'gpt-4o',
  });
  console.log('  Stored: "Who wrote Romeo and Juliet?" -> "William Shakespeare" [literature]');

  await cache.store('What is the speed of light?', 'Approximately 299,792 kilometres per second', {
    category: 'science',
    model: 'gpt-4o',
  });
  console.log('  Stored: "What is the speed of light?" -> "Approximately 299,792 km/s" [science]');
  console.log();

  // --- Check 1: Exact match ---

  const q1 = 'What is the capital of France?';
  console.log(`[check 1] "${q1}"`);
  const r1 = await cache.check(q1);
  if (r1.hit) {
    console.log(`  hit: true | confidence: ${r1.confidence} | similarity: ${r1.similarity?.toFixed(4)} | response: ${r1.response}${mockReason(q1, r1)}`);
  } else {
    console.log(`  hit: false | similarity: ${r1.similarity?.toFixed(4)}${mockReason(q1, r1)}`);
  }
  console.log();

  // --- Check 2: Paraphrase ---

  const q2 = 'Capital city of France?';
  console.log(`[check 2] "${q2}"`);
  const r2 = await cache.check(q2);
  if (r2.hit) {
    console.log(`  hit: true | confidence: ${r2.confidence} | similarity: ${r2.similarity?.toFixed(4)} | response: ${r2.response}${mockReason(q2, r2)}`);
  } else if (r2.nearestMiss) {
    console.log(`  hit: false | nearest miss: ${r2.nearestMiss.similarity.toFixed(4)} (delta: +${r2.nearestMiss.deltaToThreshold.toFixed(4)})${mockReason(q2, r2)}`);
  } else {
    console.log(`  hit: false${mockReason(q2, r2)}`);
  }
  console.log();

  // --- Check 3: Different topic ---

  const q3 = 'Who wrote Hamlet?';
  console.log(`[check 3] "${q3}"`);
  const r3 = await cache.check(q3);
  if (r3.hit) {
    console.log(`  hit: true | confidence: ${r3.confidence} | similarity: ${r3.similarity?.toFixed(4)} | response: ${r3.response}${mockReason(q3, r3)}`);
  } else if (r3.nearestMiss) {
    console.log(`  hit: false | nearest miss: ${r3.nearestMiss.similarity.toFixed(4)} (delta: +${r3.nearestMiss.deltaToThreshold.toFixed(4)})${mockReason(q3, r3)}`);
  } else {
    console.log(`  hit: false${mockReason(q3, r3)}`);
  }
  console.log();

  // --- Check 4: Unrelated ---

  const q4 = 'What is the best pizza topping?';
  console.log(`[check 4] "${q4}"`);
  const r4 = await cache.check(q4);
  if (r4.hit) {
    console.log(`  hit: true | confidence: ${r4.confidence} | similarity: ${r4.similarity?.toFixed(4)} | response: ${r4.response}${mockReason(q4, r4)}`);
  } else if (r4.nearestMiss) {
    console.log(`  hit: false | nearest miss: ${r4.nearestMiss.similarity.toFixed(4)} (delta: +${r4.nearestMiss.deltaToThreshold.toFixed(4)})${mockReason(q4, r4)}`);
  } else {
    console.log(`  hit: false${mockReason(q4, r4)}`);
  }
  console.log();

  // --- Stats ---

  const stats = await cache.stats();
  console.log(`Cache stats: ${stats.hits} hits / ${stats.total} lookups (${(stats.hitRate * 100).toFixed(1)}% hit rate)`);
  console.log();

  // --- Index info ---

  const info = await cache.indexInfo();
  console.log(`Index: ${info.name}, docs: ${info.numDocs}, dimension: ${info.dimension}, state: ${info.indexingState}`);
  console.log();

  // --- Cleanup ---

  console.log('Flushing cache...');
  await cache.flush();
  console.log('Done.');

  await client.quit();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
