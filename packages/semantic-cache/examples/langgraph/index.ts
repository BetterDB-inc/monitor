/**
 * LangGraph BetterDBSemanticStore example for @betterdb/semantic-cache
 *
 * Demonstrates using SemanticCache as a LangGraph-compatible memory store
 * with similarity-based retrieval.
 *
 * No API key required - uses a mock embedder.
 *
 * When to use this vs agent-cache/langgraph:
 * - Use BetterDBSemanticStore (this) for similarity-based memory retrieval.
 * - Use agent-cache BetterDBSaver for exact-match checkpoint persistence.
 *
 * Prerequisites:
 *   - Valkey 8.0+ with valkey-search at localhost:6399
 *
 * Usage:
 *   pnpm install && pnpm start
 */
import Valkey from 'iovalkey';
import { SemanticCache } from '@betterdb/semantic-cache';
import { BetterDBSemanticStore } from '@betterdb/semantic-cache/langgraph';

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

const semanticCache = new SemanticCache({
  client,
  embedFn: mockEmbed,
  name: 'example_langgraph_store',
  defaultThreshold: 0.3,
  embeddingCache: { enabled: false },
});

const store = new BetterDBSemanticStore({
  cache: semanticCache,
  embedField: 'content',
});

async function main() {
  console.log('=== LangGraph BetterDBSemanticStore example ===\n');

  console.log('WARNING: Flushing cache - deletes all existing cache data.');
  await semanticCache.initialize();
  await semanticCache.flush();
  await semanticCache.initialize();
  console.log('Cache initialized and flushed.\n');

  const namespace = ['user', 'alice', 'memories'];

  // -- Put items --
  console.log('-- Storing memories --');
  await store.put(namespace, 'mem1', {
    content: 'Alice lives in Paris and loves museums.',
    type: 'location',
  });
  await store.put(namespace, 'mem2', {
    content: 'Alice is a software engineer who works on AI projects.',
    type: 'profession',
  });
  await store.put(namespace, 'mem3', {
    content: 'Alice enjoys cooking Italian food and reading science fiction.',
    type: 'hobbies',
  });
  console.log('  Stored 3 memories.\n');

  // -- Get by key --
  console.log('-- Get by key (mem1) --');
  const item = await store.get(namespace, 'mem1');
  if (item) {
    console.log(`  Found: key=${item.key} value=${JSON.stringify(item.value)}`);
  } else {
    console.log('  Not found (SCAN-based get may not match in all test scenarios)');
  }
  console.log();

  // -- Semantic search --
  console.log('-- Semantic search: "What does Alice do for work?" --');
  const results = await store.search(namespace, {
    query: 'What does Alice do for work?',
    limit: 2,
  });
  console.log(`  Found ${results.length} result(s):`);
  for (const r of results) {
    console.log(`  - [${r.key}] ${JSON.stringify((r.value as { content: string }).content).slice(0, 60)}...`);
  }
  console.log();

  // -- Batch write --
  console.log('-- Batch write --');
  await store.batch([
    {
      namespace,
      key: 'mem4',
      value: { content: 'Alice recently visited Tokyo for a tech conference.', type: 'travel' },
    },
  ]);
  console.log('  Batch write complete.\n');

  await semanticCache.flush();
  await client.quit();
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
