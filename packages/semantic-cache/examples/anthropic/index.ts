/**
 * Anthropic Messages API + @betterdb/semantic-cache example
 *
 * Demonstrates:
 *   1. prepareSemanticParams() from @betterdb/semantic-cache/anthropic
 *   2. OpenAI text-embedding-3-small as embedding function (Anthropic has no embedding API)
 *   3. Cache miss then semantic hit for similar prompts
 *
 * Prerequisites:
 *   - Valkey 8.0+ with valkey-search at localhost:6399
 *   - ANTHROPIC_API_KEY and OPENAI_API_KEY environment variables set
 *
 * Usage:
 *   pnpm install && pnpm start
 */
import Valkey from 'iovalkey';
import Anthropic from '@anthropic-ai/sdk';
import { SemanticCache } from '@betterdb/semantic-cache';
import { createOpenAIEmbed } from '@betterdb/semantic-cache/embed/openai';
import { prepareSemanticParams } from '@betterdb/semantic-cache/anthropic';

const host = process.env.VALKEY_HOST ?? 'localhost';
const port = parseInt(process.env.VALKEY_PORT ?? '6399', 10);

const client = new Valkey({ host, port });
const anthropic = new Anthropic();

const cache = new SemanticCache({
  client,
  embedFn: createOpenAIEmbed({ model: 'text-embedding-3-small' }),
  name: 'example_anthropic',
  defaultThreshold: 0.12,
  defaultTtl: 300,
});

async function callWithCache(params: Anthropic.MessageCreateParamsNonStreaming) {
  const { text, model } = await prepareSemanticParams(params);
  if (!text) return null;

  const cached = await cache.check(text);
  if (cached.hit) {
    console.log(`  [cache HIT] similarity=${cached.similarity?.toFixed(4)} confidence=${cached.confidence}`);
    return cached.response;
  }

  console.log('  [cache MISS] calling Anthropic API...');
  const response = await anthropic.messages.create(params);
  const answer = response.content[0].type === 'text' ? response.content[0].text : '';

  await cache.store(text, answer, {
    model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  });

  return answer;
}

async function main() {
  console.log('=== Anthropic Messages + SemanticCache example ===\n');

  console.log('WARNING: Flushing cache - deletes all existing cache data.');
  await cache.initialize();
  await cache.flush();
  await cache.initialize();
  console.log('Cache initialized and flushed.\n');

  // -- Round 1: seed the cache --
  console.log('-- Round 1: Seeding the cache --');
  const params1: Anthropic.MessageCreateParamsNonStreaming = {
    model: 'claude-haiku-4-5',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'What is the capital of Japan?' }],
  };
  console.log(`User: ${params1.messages[0].content}`);
  const ans1 = await callWithCache(params1);
  console.log(`Assistant: ${ans1}\n`);

  // -- Round 2: semantic hit --
  console.log('-- Round 2: Semantic cache hit --');
  const params2: Anthropic.MessageCreateParamsNonStreaming = {
    model: 'claude-haiku-4-5',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'Which city is the capital of Japan?' }],
  };
  console.log(`User: ${params2.messages[0].content}`);
  const ans2 = await callWithCache(params2);
  console.log(`Assistant: ${ans2}\n`);

  // -- Stats --
  const stats = await cache.stats();
  console.log('-- Cache Stats --');
  console.log(`Hits: ${stats.hits} | Misses: ${stats.misses} | Hit rate: ${(stats.hitRate * 100).toFixed(0)}%`);
  console.log(`Cost saved: $${(stats.costSavedMicros / 1_000_000).toFixed(6)}`);

  await cache.flush();
  await client.quit();
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
