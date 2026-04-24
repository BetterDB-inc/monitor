/**
 * LangChain + @betterdb/semantic-cache example
 *
 * Demonstrates BetterDBSemanticCache (implements LangChain's BaseCache interface)
 * wired into a ChatOpenAI model. Similar prompts return from Valkey without
 * calling the LLM.
 *
 * Prerequisites:
 *   - Valkey 8.0+ with valkey-search at localhost:6399
 *   - OPENAI_API_KEY environment variable set
 *
 * Usage:
 *   pnpm install && pnpm start
 */
import Valkey from 'iovalkey';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage } from '@langchain/core/messages';
import { SemanticCache } from '@betterdb/semantic-cache';
import { BetterDBSemanticCache } from '@betterdb/semantic-cache/langchain';
import { createOpenAIEmbed } from '@betterdb/semantic-cache/embed/openai';

const host = process.env.VALKEY_HOST ?? 'localhost';
const port = parseInt(process.env.VALKEY_PORT ?? '6399', 10);

const client = new Valkey({ host, port });

const semanticCache = new SemanticCache({
  client,
  embedFn: createOpenAIEmbed({ model: 'text-embedding-3-small' }),
  name: 'example_langchain_sc',
  defaultThreshold: 0.12,
  defaultTtl: 300,
});

const model = new ChatOpenAI({
  model: 'gpt-4o-mini',
  temperature: 0,
  cache: new BetterDBSemanticCache({ cache: semanticCache }),
});

async function ask(prompt: string) {
  console.log(`\nUser: ${prompt}`);
  const start = Date.now();
  const response = await model.invoke([new HumanMessage(prompt)]);
  const elapsed = Date.now() - start;
  const content = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
  console.log(`Assistant: ${content.slice(0, 100)}${content.length > 100 ? '...' : ''}`);
  console.log(`  (${elapsed}ms)`);
}

async function main() {
  console.log('=== LangChain + BetterDBSemanticCache example ===\n');

  console.log('WARNING: Flushing cache - deletes all existing cache data.');
  await semanticCache.initialize();
  await semanticCache.flush();
  await semanticCache.initialize();
  console.log('Cache initialized and flushed.');

  console.log('\n=== Round 1: First call (cache miss, calls LLM) ===');
  await ask('What is the capital of Spain?');

  console.log('\n=== Round 2: Same prompt (cache hit) ===');
  await ask('What is the capital of Spain?');

  console.log('\n=== Round 3: Paraphrase (semantic cache hit) ===');
  await ask('Which city is the capital of Spain?');

  console.log('\n=== Round 4: Unrelated (cache miss) ===');
  await ask('What is the best pizza topping?');

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
