/**
 * LangGraph + @betterdb/agent-cache example
 *
 * Demonstrates three caching tiers working together:
 *   1. Graph state persistence — BetterDBSaver stores checkpoints in Valkey,
 *      so a conversation thread can be resumed across process restarts
 *   2. LLM response caching  — identical LLM calls return from Valkey
 *   3. Tool result caching   — repeated tool calls skip the API
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
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import { StateGraph, Annotation, END } from '@langchain/langgraph';
import { z } from 'zod';
import { AgentCache } from '@betterdb/agent-cache';
import { BetterDBSaver } from '@betterdb/agent-cache/langgraph';
import { BetterDBLlmCache } from '@betterdb/agent-cache/langchain';

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

// ── 2. Create the cache ─────────────────────────────────────────────
const cache = new AgentCache({
  client: valkey,
  tierDefaults: {
    llm:     { ttl: 3600 },
    tool:    { ttl: 300 },
    session: { ttl: 86400 }, // checkpoints kept for 24 hours
  },
  costTable: {
    'gpt-4o-mini': { inputPer1k: 0.00015, outputPer1k: 0.0006 },
  },
});

// ── 3. Model with LLM cache ─────────────────────────────────────────
const model = new ChatOpenAI({
  model: 'gpt-4o-mini',
  temperature: 0,
  cache: new BetterDBLlmCache({ cache }),
});

// ── 4. Checkpoint saver backed by Valkey ────────────────────────────
const checkpointer = new BetterDBSaver({ cache });

// ── 5. Cached tool ──────────────────────────────────────────────────
const weatherSchema = z.object({ city: z.string().describe('City name') });

async function getWeather(args: { city: string }): Promise<string> {
  const cached = await cache.tool.check('get_weather', args);
  if (cached.hit) {
    console.log(`  [tool cache HIT] get_weather("${args.city}")`);
    return cached.response!;
  }

  console.log(`  [tool cache MISS] get_weather("${args.city}") — calling API`);
  const result = JSON.stringify({
    city: args.city,
    temperature: Math.round(15 + Math.random() * 15),
    condition: ['sunny', 'cloudy', 'rainy'][Math.floor(Math.random() * 3)],
  });

  await cache.tool.store('get_weather', args, result);
  return result;
}

// ── 6. Define the graph ─────────────────────────────────────────────
const GraphState = Annotation.Root({
  messages: Annotation<Array<HumanMessage | AIMessage | ToolMessage>>({
    reducer: (x, y) => x.concat(y),
  }),
});

const tools = [{ type: 'function' as const, function: {
  name: 'get_weather',
  description: 'Get the current weather for a city',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
}}];

const modelWithTools = model.bindTools(tools);

async function callModel(state: typeof GraphState.State) {
  const response = await modelWithTools.invoke(state.messages);
  return { messages: [response] };
}

async function callTools(state: typeof GraphState.State) {
  const last = state.messages.at(-1) as AIMessage;
  const results: ToolMessage[] = [];

  for (const toolCall of last.tool_calls ?? []) {
    if (toolCall.name === 'get_weather') {
      const parsed = weatherSchema.parse(toolCall.args);
      const result = await getWeather(parsed);
      results.push(new ToolMessage({ content: result, tool_call_id: toolCall.id! }));
    }
  }

  return { messages: results };
}

function shouldContinue(state: typeof GraphState.State): 'tools' | typeof END {
  const last = state.messages.at(-1) as AIMessage;
  return last.tool_calls?.length ? 'tools' : END;
}

const graph = new StateGraph(GraphState)
  .addNode('agent', callModel)
  .addNode('tools', callTools)
  .addEdge('__start__', 'agent')
  .addConditionalEdges('agent', shouldContinue)
  .addEdge('tools', 'agent')
  .compile({ checkpointer });

// ── 7. Run the demo ─────────────────────────────────────────────────
async function runThread(threadId: string, message: string) {
  console.log(`\nUser [${threadId}]: ${message}`);
  const start = Date.now();

  const result = await graph.invoke(
    { messages: [new HumanMessage(message)] },
    { configurable: { thread_id: threadId } },
  );

  const elapsed = Date.now() - start;
  const last = result.messages.at(-1) as AIMessage;
  console.log(`Assistant: ${last.content}`);
  console.log(`  (${elapsed}ms)`);
}

async function main() {
  const THREAD_ID = 'demo-thread-1';

  console.log('═══ Part 1: Graph State Persistence ═══');
  console.log('Two separate messages on the same thread — graph resumes from checkpoint.');

  await runThread(THREAD_ID, 'What is the weather in Sofia?');
  await runThread(THREAD_ID, 'And in Berlin?');

  console.log('\n═══ Part 2: LLM + Tool Caching ═══');
  console.log('Same questions on a new thread — LLM and tool results served from cache.');

  const THREAD_ID_2 = 'demo-thread-2';
  await runThread(THREAD_ID_2, 'What is the weather in Sofia?');
  await runThread(THREAD_ID_2, 'And in Berlin?');

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
