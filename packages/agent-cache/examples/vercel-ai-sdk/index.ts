/**
 * Vercel AI SDK + @betterdb/agent-cache example
 *
 * Demonstrates two caching tiers:
 *   1. LLM response caching — identical prompts return instantly from Valkey
 *   2. Tool result caching  — repeated tool calls skip the API
 *
 * Usage (standalone):
 *   docker run -d --name valkey -p 6379:6379 valkey/valkey:8
 *   export OPENAI_API_KEY=sk-...
 *   npx tsx index.ts
 *
 * Usage (cluster):
 *   export VALKEY_CLUSTER=1   # uses localhost:6401,6402,6403 by default
 *   export OPENAI_API_KEY=sk-...
 *   npx tsx index.ts
 */
import Valkey, { Cluster } from 'iovalkey';
import { generateText, tool, jsonSchema, stepCountIs } from 'ai';
import { wrapLanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { AgentCache } from '@betterdb/agent-cache';
import { createAgentCacheMiddleware } from '@betterdb/agent-cache/ai';

// ── 1. Connect to Valkey (standalone or cluster) ─────────────────────
let valkey: Valkey;
if (process.env.VALKEY_CLUSTER) {
  const clusterNodes = (process.env.VALKEY_CLUSTER_NODES ?? 'localhost:6401,localhost:6402,localhost:6403')
    .split(',').map(hp => {
      const [host, portStr] = hp.trim().split(':');
      const port = parseInt(portStr, 10);
      if (!host || isNaN(port)) throw new Error(`Invalid cluster node: "${hp}"`);
      return { host, port };
    });
  console.log(`Cluster mode — nodes: ${clusterNodes.map(n => `${n.host}:${n.port}`).join(', ')}`);
  valkey = new Cluster(clusterNodes) as unknown as Valkey;
} else {
  console.log('Standalone mode — localhost:6379');
  valkey = new Valkey({ host: 'localhost', port: 6379 });
}

// ── 2. Create a cache with cost tracking ────────────────────────────
const cache = new AgentCache({
  client: valkey,
  tierDefaults: {
    llm: { ttl: 3600 },   // LLM responses cached for 1 hour
    tool: { ttl: 300 },    // tool results cached for 5 minutes
  },
  costTable: {
    'gpt-4o-mini': { inputPer1k: 0.00015, outputPer1k: 0.0006 },
    'gpt-4o':      { inputPer1k: 0.0025,  outputPer1k: 0.01 },
  },
});

// ── 3. Wrap the model with the cache middleware ─────────────────────
const openai = createOpenAI({});

const model = wrapLanguageModel({
  model: openai.chat('gpt-4o-mini'),
  middleware: createAgentCacheMiddleware({ cache }),
});

// ── 4. Define a tool with caching ───────────────────────────────────
const getWeather = tool({
  description: 'Get the current weather for a city',
  inputSchema: jsonSchema<{ city: string }>({
    type: 'object',
    properties: { city: { type: 'string', description: 'City name' } },
    required: ['city'],
  }),
  execute: async ({ city }) => {
    // Check cache first
    const cached = await cache.tool.check('get_weather', { city });
    if (cached.hit) {
      console.log(`  [tool cache HIT] get_weather("${city}")`);
      return JSON.parse(cached.response!);
    }

    console.log(`  [tool cache MISS] get_weather("${city}") — calling API`);

    // Simulate an expensive API call
    const result = {
      city,
      temperature: Math.round(15 + Math.random() * 15),
      condition: ['sunny', 'cloudy', 'rainy'][Math.floor(Math.random() * 3)],
    };

    // Store in cache for next time
    await cache.tool.store('get_weather', { city }, JSON.stringify(result));
    return result;
  },
});

// ── 5. Helpers ──────────────────────────────────────────────────────

/** Simple prompt (no tools) — demonstrates LLM response caching */
async function askSimple(prompt: string) {
  console.log(`\nUser: ${prompt}`);
  const start = Date.now();

  const { text, usage } = await generateText({ model, prompt });

  const elapsed = Date.now() - start;
  console.log(`Assistant: ${text}`);
  console.log(`  (${elapsed}ms | tokens: ${usage.inputTokens ?? 0} in / ${usage.outputTokens ?? 0} out)`);
}

/** Tool-calling prompt — demonstrates tool result caching */
async function askWithTools(prompt: string) {
  console.log(`\nUser: ${prompt}`);
  const start = Date.now();

  const { text, usage } = await generateText({
    model,
    tools: { getWeather },
    stopWhen: stepCountIs(3),
    prompt,
  });

  const elapsed = Date.now() - start;
  console.log(`Assistant: ${text}`);
  console.log(`  (${elapsed}ms | tokens: ${usage.inputTokens ?? 0} in / ${usage.outputTokens ?? 0} out)`);
}

// ── 6. Run the demo ─────────────────────────────────────────────────
async function main() {
  console.log('═══ Part 1: LLM Response Caching ═══');
  console.log('Same prompt twice — second call returns from Valkey, zero tokens.');

  await askSimple('What is the capital of Bulgaria?');
  await askSimple('What is the capital of Bulgaria?');

  console.log('\n═══ Part 2: Tool Result Caching ═══');
  console.log('Same tool calls twice — second call skips the API.');

  await askWithTools('What is the weather in Sofia and Berlin?');
  await askWithTools('What is the weather in Sofia and Berlin?');

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
