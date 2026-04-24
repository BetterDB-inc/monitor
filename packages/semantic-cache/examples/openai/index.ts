/**
 * OpenAI Chat Completions + @betterdb/semantic-cache example
 *
 * Demonstrates:
 *   1. prepareSemanticParams() extracting the semantic key from OpenAI params
 *   2. createOpenAIEmbed() as the embedding function
 *   3. Cache miss then semantic hit for similar prompts
 *
 * Prerequisites:
 *   - Valkey running at localhost:6399 (or set VALKEY_HOST/VALKEY_PORT)
 *   - OPENAI_API_KEY environment variable set
 *
 * Usage:
 *   pnpm install && pnpm start
 */
import Valkey from 'iovalkey';
import { SemanticCache } from '@betterdb/semantic-cache';
import { createOpenAIEmbed } from '@betterdb/semantic-cache/embed/openai';
import { prepareSemanticParams } from '@betterdb/semantic-cache/openai';
import OpenAI from 'openai';

const host = process.env.VALKEY_HOST ?? 'localhost';
const port = parseInt(process.env.VALKEY_PORT ?? '6399', 10);

const client = new Valkey({ host, port });
const openai = new OpenAI();

const cache = new SemanticCache({
  client,
  embedFn: createOpenAIEmbed({ client: openai, model: 'text-embedding-3-small' }),
  name: 'example_openai',
  defaultThreshold: 0.1,
  defaultTtl: 300,
  useDefaultCostTable: true,
});

async function callWithCache(params: Parameters<typeof openai.chat.completions.create>[0]) {
  const { text, model } = await prepareSemanticParams(
    params as Parameters<typeof prepareSemanticParams>[0],
  );
  if (!text) return null;

  const cached = await cache.check(text, { filter: model ? `@model:{${model.replace(/-/g, '\\-')}}` : undefined });
  if (cached.hit) {
    console.log(`  [cache HIT] similarity=${cached.similarity?.toFixed(4)} confidence=${cached.confidence}`);
    if (cached.costSaved) console.log(`  [cost saved] $${cached.costSaved.toFixed(6)}`);
    return cached.response;
  }

  console.log('  [cache MISS] calling OpenAI API...');
  const response = await openai.chat.completions.create(params as Parameters<typeof openai.chat.completions.create>[0] & { stream?: false });
  const answer = (response as { choices: Array<{ message: { content: string | null } }> }).choices[0].message.content ?? '';

  await cache.store(text, answer, {
    model: params.model,
    inputTokens: (response as { usage?: { prompt_tokens?: number } }).usage?.prompt_tokens,
    outputTokens: (response as { usage?: { completion_tokens?: number } }).usage?.completion_tokens,
  });

  return answer;
}

async function main() {
  console.log('═══ OpenAI Chat Completions + SemanticCache example ═══\n');

  console.log('WARNING: Flushing cache - deletes all existing cache data.');
  await cache.initialize();
  await cache.flush();
  await cache.initialize();
  console.log('Cache initialized and flushed.\n');

  // -- Round 1: seed the cache --
  console.log('── Round 1: Seeding the cache ──');

  const params1 = {
    model: 'gpt-4o-mini',
    messages: [{ role: 'user' as const, content: 'What is the capital of France?' }],
  };
  console.log(`User: ${params1.messages[0].content}`);
  const ans1 = await callWithCache(params1);
  console.log(`Assistant: ${ans1}\n`);

  // -- Round 2: semantic hit --
  console.log('── Round 2: Semantic cache hit ──');

  const params2 = {
    model: 'gpt-4o-mini',
    messages: [{ role: 'user' as const, content: 'What city is the capital of France?' }],
  };
  console.log(`User: ${params2.messages[0].content}`);
  const ans2 = await callWithCache(params2);
  console.log(`Assistant: ${ans2}\n`);

  // -- Stats --
  const stats = await cache.stats();
  console.log('── Cache Stats ──');
  console.log(`Hits: ${stats.hits} | Misses: ${stats.misses} | Hit rate: ${(stats.hitRate * 100).toFixed(0)}%`);
  console.log(`Cost saved: $${(stats.costSavedMicros / 1_000_000).toFixed(6)}`);

  await cache.flush();
  await client.quit();
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
