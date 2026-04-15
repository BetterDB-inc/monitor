/**
 * LangChain + @betterdb/agent-cache example
 *
 * Demonstrates two caching tiers:
 *   1. LLM response caching — identical prompts return instantly from Valkey
 *   2. Tool result caching  — repeated tool calls skip the API
 *
 * Usage:
 *   # Start a local Valkey (or Redis) on port 6379
 *   docker run -d --name valkey -p 6379:6379 valkey/valkey:8
 *
 *   # Set your OpenAI key
 *   export OPENAI_API_KEY=sk-...
 *
 *   # Run the example
 *   npx tsx index.ts
 */
import Valkey from 'iovalkey';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage } from '@langchain/core/messages';
import { AgentCache } from '@betterdb/agent-cache';
import { BetterDBLlmCache } from '@betterdb/agent-cache/langchain';

// ── 1. Connect to Valkey ────────────────────────────────────────────
const valkey = new Valkey({ host: 'localhost', port: 6379 });

// ── 2. Create a cache ───────────────────────────────────────────────
const cache = new AgentCache({
  client: valkey,
  tierDefaults: {
    llm: { ttl: 3600 },
    tool: { ttl: 300 },
  },
  costTable: {
    'gpt-4o-mini': { inputPer1k: 0.00015, outputPer1k: 0.0006 },
    'gpt-4o':      { inputPer1k: 0.0025,  outputPer1k: 0.01 },
  },
});

// ── 3. Create a ChatOpenAI model with the cache ─────────────────────
const model = new ChatOpenAI({
  model: 'gpt-4o-mini',
  temperature: 0,
  cache: new BetterDBLlmCache({ cache }),
});

// ── 4. Define a cached tool ─────────────────────────────────────────
async function getWeather(city: string): Promise<string> {
  const cached = await cache.tool.check('get_weather', { city });
  if (cached.hit) {
    console.log(`  [tool cache HIT] get_weather("${city}")`);
    return cached.response!;
  }

  console.log(`  [tool cache MISS] get_weather("${city}") — calling API`);

  // Simulate an expensive API call
  const result = JSON.stringify({
    city,
    temperature: Math.round(15 + Math.random() * 15),
    condition: ['sunny', 'cloudy', 'rainy'][Math.floor(Math.random() * 3)],
  });

  await cache.tool.store('get_weather', { city }, result);
  return result;
}

// ── 5. Helpers ──────────────────────────────────────────────────────

async function askSimple(prompt: string) {
  console.log(`\nUser: ${prompt}`);
  const start = Date.now();

  const response = await model.invoke([new HumanMessage(prompt)]);

  const elapsed = Date.now() - start;
  console.log(`Assistant: ${response.content}`);
  console.log(`  (${elapsed}ms)`);
}

// ── 6. Run the demo ─────────────────────────────────────────────────
async function main() {
  console.log('═══ Part 1: LLM Response Caching ═══');
  console.log('Same prompt twice — second call returns from Valkey.');

  await askSimple('What is the capital of Bulgaria?');
  await askSimple('What is the capital of Bulgaria?');

  console.log('\n═══ Part 2: Tool Result Caching ═══');
  console.log('Same tool calls twice — second call skips the API.');

  console.log();
  await getWeather('Sofia');
  await getWeather('Berlin');
  console.log('  (first round done)');

  console.log();
  await getWeather('Sofia');
  await getWeather('Berlin');
  console.log('  (second round done — both from cache)');

  // Print cache stats
  const stats = await cache.stats();
  console.log('\n── Cache Stats ──');
  console.log(`LLM tier:   ${stats.llm.hits} hits / ${stats.llm.misses} misses (${(stats.llm.hitRate * 100).toFixed(0)}% hit rate)`);
  console.log(`Tool tier:  ${stats.tool.hits} hits / ${stats.tool.misses} misses (${(stats.tool.hitRate * 100).toFixed(0)}% hit rate)`);
  console.log(`Cost saved: $${(stats.costSavedMicros / 1_000_000).toFixed(6)}`);

  // Cleanup
  await cache.shutdown();
  await valkey.quit();
}

main().catch(console.error);
