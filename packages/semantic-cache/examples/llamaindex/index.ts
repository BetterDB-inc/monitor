/**
 * LlamaIndex + @betterdb/semantic-cache example
 *
 * Demonstrates prepareSemanticParams() extracting the cache key from
 * LlamaIndex ChatMessage arrays, with cache miss then semantic hit.
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
import { prepareSemanticParams } from '@betterdb/semantic-cache/llamaindex';
import type { ChatMessage } from '@llamaindex/core/llms';

const host = process.env.VALKEY_HOST ?? 'localhost';
const port = parseInt(process.env.VALKEY_PORT ?? '6399', 10);

const client = new Valkey({ host, port });

const cache = new SemanticCache({
  client,
  embedFn: createOpenAIEmbed({ model: 'text-embedding-3-small' }),
  name: 'example_llamaindex',
  defaultThreshold: 0.12,
  defaultTtl: 300,
});

// Simulate LlamaIndex chat messages
function userMessage(content: string): ChatMessage {
  return { role: 'user', content };
}

async function checkWithCache(messages: ChatMessage[], modelName = 'gpt-4o'): Promise<string | null> {
  const { text } = await prepareSemanticParams(messages, { model: modelName });
  if (!text) return null;

  const cached = await cache.check(text);
  if (cached.hit) {
    console.log(`  [cache HIT] similarity=${cached.similarity?.toFixed(4)} confidence=${cached.confidence}`);
    return cached.response ?? null;
  }
  return null;
}

async function main() {
  console.log('=== LlamaIndex + SemanticCache example ===\n');

  console.log('WARNING: Flushing cache - deletes all existing cache data.');
  await cache.initialize();
  await cache.flush();
  await cache.initialize();
  console.log('Cache initialized and flushed.\n');

  // -- Seed the cache --
  console.log('-- Seeding cache --');
  const seedText = 'What is the speed of light?';
  const seedAnswer = 'The speed of light in vacuum is approximately 299,792 km/s.';
  await cache.store(seedText, seedAnswer);
  console.log(`  Stored: "${seedText}" -> "${seedAnswer.slice(0, 40)}..."\n`);

  // -- Check 1: Exact match via LlamaIndex messages --
  console.log('-- Check 1: Exact match --');
  const msgs1: ChatMessage[] = [userMessage('What is the speed of light?')];
  const result1 = await checkWithCache(msgs1);
  console.log(`  Response: ${result1 ?? 'MISS'}\n`);

  // -- Check 2: Paraphrase --
  console.log('-- Check 2: Paraphrase --');
  const msgs2: ChatMessage[] = [
    userMessage('Previous context'),
    { role: 'assistant', content: 'OK' },
    userMessage('How fast does light travel?'),
  ];
  const { text } = await prepareSemanticParams(msgs2);
  console.log(`  Extracted key: "${text}"`);
  const cached2 = await cache.check(text);
  if (cached2.hit) {
    console.log(`  [cache HIT] similarity=${cached2.similarity?.toFixed(4)}`);
    console.log(`  Response: ${cached2.response}`);
  } else {
    console.log('  MISS');
  }
  console.log();

  // -- Stats --
  const stats = await cache.stats();
  console.log('-- Stats --');
  console.log(`Hits: ${stats.hits} | Misses: ${stats.misses}`);

  await cache.flush();
  await client.quit();
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
