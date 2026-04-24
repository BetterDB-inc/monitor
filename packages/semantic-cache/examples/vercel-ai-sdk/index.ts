/**
 * Vercel AI SDK + @betterdb/semantic-cache example
 *
 * Demonstrates createSemanticCacheMiddleware() wired into wrapLanguageModel().
 * Similar prompts return from Valkey without calling the LLM.
 *
 * Prerequisites:
 *   - Valkey 8.0+ with valkey-search at localhost:6399
 *   - OPENAI_API_KEY environment variable set
 *
 * Usage:
 *   pnpm install && pnpm start
 */
import Valkey from 'iovalkey';
import { openai } from '@ai-sdk/openai';
import { generateText, wrapLanguageModel } from 'ai';
import { SemanticCache } from '@betterdb/semantic-cache';
import { createSemanticCacheMiddleware } from '@betterdb/semantic-cache/ai';
import { createOpenAIEmbed } from '@betterdb/semantic-cache/embed/openai';

const host = process.env.VALKEY_HOST ?? 'localhost';
const port = parseInt(process.env.VALKEY_PORT ?? '6399', 10);

const client = new Valkey({ host, port });

const semanticCache = new SemanticCache({
  client,
  embedFn: createOpenAIEmbed({ model: 'text-embedding-3-small' }),
  name: 'example_vercel_ai',
  defaultThreshold: 0.12,
  defaultTtl: 300,
});

await semanticCache.initialize();
await semanticCache.flush();
await semanticCache.initialize();

const model = wrapLanguageModel({
  model: openai('gpt-4o-mini'),
  middleware: createSemanticCacheMiddleware({ cache: semanticCache }),
});

async function generate(prompt: string) {
  console.log(`\nUser: ${prompt}`);
  const start = Date.now();
  const { text } = await generateText({ model, prompt });
  const elapsed = Date.now() - start;
  console.log(`Assistant: ${text.slice(0, 100)}${text.length > 100 ? '...' : ''}`);
  console.log(`  (${elapsed}ms)`);
  return text;
}

async function main() {
  console.log('=== Vercel AI SDK + createSemanticCacheMiddleware example ===');
  console.log('WARNING: Cache flushed at startup - do not use flush() in production.\n');

  console.log('=== Round 1: First call (cache miss) ===');
  await generate('What is the capital of Portugal?');

  console.log('\n=== Round 2: Same prompt (cache hit) ===');
  await generate('What is the capital of Portugal?');

  console.log('\n=== Round 3: Paraphrase (semantic hit) ===');
  await generate('Which city serves as Portugal\'s capital?');

  const stats = await semanticCache.stats();
  console.log('\n-- Cache Stats --');
  console.log(`Hits: ${stats.hits} | Misses: ${stats.misses} | Hit rate: ${(stats.hitRate * 100).toFixed(0)}%`);

  await semanticCache.flush();
  await client.quit();
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
