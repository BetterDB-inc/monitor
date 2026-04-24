/**
 * OpenAI Responses API + @betterdb/semantic-cache example
 *
 * Demonstrates prepareSemanticParams() from the openai-responses adapter
 * extracting the semantic key from OpenAI Responses API params.
 *
 * Prerequisites:
 *   - Valkey 8.0+ with valkey-search at localhost:6399
 *   - OPENAI_API_KEY environment variable set
 *
 * Usage:
 *   pnpm install && pnpm start
 */
import Valkey from 'iovalkey';
import { SemanticCache } from '@betterdb/semantic-cache';
import { createOpenAIEmbed } from '@betterdb/semantic-cache/embed/openai';
import { prepareSemanticParams } from '@betterdb/semantic-cache/openai-responses';
import OpenAI from 'openai';

const host = process.env.VALKEY_HOST ?? 'localhost';
const port = parseInt(process.env.VALKEY_PORT ?? '6399', 10);

const client = new Valkey({ host, port });
const openai = new OpenAI();

const cache = new SemanticCache({
  client,
  embedFn: createOpenAIEmbed({ model: 'text-embedding-3-small' }),
  name: 'example_openai_resp',
  defaultThreshold: 0.12,
  defaultTtl: 300,
});

type ResponseParams = Parameters<typeof openai.responses.create>[0];

async function callWithCache(params: ResponseParams) {
  const { text } = await prepareSemanticParams(params as Parameters<typeof prepareSemanticParams>[0]);
  if (!text) return null;

  const cached = await cache.check(text);
  if (cached.hit) {
    console.log(`  [cache HIT] similarity=${cached.similarity?.toFixed(4)} confidence=${cached.confidence}`);
    return cached.response;
  }

  console.log('  [cache MISS] calling OpenAI Responses API...');
  const response = await openai.responses.create(params);
  const answer = response.output_text ?? '';

  await cache.store(text, answer, { model: params.model });
  return answer;
}

async function main() {
  console.log('=== OpenAI Responses API + SemanticCache example ===\n');

  console.log('WARNING: Flushing cache - deletes all existing cache data.');
  await cache.initialize();
  await cache.flush();
  await cache.initialize();
  console.log('Cache initialized and flushed.\n');

  // -- Round 1: seed --
  console.log('-- Round 1: Seeding --');
  const params1: ResponseParams = {
    model: 'gpt-4o-mini',
    input: 'What is the capital of Australia?',
  };
  console.log(`User: ${params1.input}`);
  const ans1 = await callWithCache(params1);
  console.log(`Assistant: ${ans1}\n`);

  // -- Round 2: semantic hit --
  console.log('-- Round 2: Semantic hit --');
  const params2: ResponseParams = {
    model: 'gpt-4o-mini',
    input: 'Which city is the capital of Australia?',
  };
  console.log(`User: ${params2.input}`);
  const ans2 = await callWithCache(params2);
  console.log(`Assistant: ${ans2}\n`);

  // -- Stats --
  const stats = await cache.stats();
  console.log('-- Cache Stats --');
  console.log(`Hits: ${stats.hits} | Misses: ${stats.misses}`);

  await cache.flush();
  await client.quit();
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
