# LangGraph + @betterdb/agent-cache

A minimal example demonstrating all three caching tiers with LangGraph.

## What it shows

1. **Graph state persistence** — `BetterDBSaver` stores LangGraph checkpoints in Valkey so conversation threads resume across invocations without re-running earlier steps.
2. **LLM response caching** — `BetterDBLlmCache` caches LLM calls so identical prompts on a new thread return from Valkey instantly.
3. **Tool result caching** — the `get_weather` tool checks `cache.tool` before calling the (simulated) API.
4. **Cost tracking** — the `costTable` option tracks estimated savings from LLM cache hits.

Works on vanilla Valkey 7+ with no modules. Unlike `langgraph-checkpoint-redis`, this does not require Redis 8.0+, RedisJSON, or RediSearch.

## Prerequisites

- Node.js >= 20
- A running Valkey (or Redis) instance
- An OpenAI API key

## Run

```bash
# Start Valkey locally
docker run -d --name valkey -p 6379:6379 valkey/valkey:8

# Set your OpenAI key
export OPENAI_API_KEY=sk-...

# Install and run
npm install
npm start
```

## Expected output

```
═══ Part 1: Graph State Persistence ═══
Two separate messages on the same thread — graph resumes from checkpoint.

User [demo-thread-1]: What is the weather in Sofia?
  [tool cache MISS] get_weather("Sofia") — calling API
Assistant: The weather in Sofia is currently sunny with a temperature of 18°C.
  (2328ms)

User [demo-thread-1]: And in Berlin?
  [tool cache MISS] get_weather("Berlin") — calling API
Assistant: The weather in Berlin is currently sunny with a temperature of 27°C.
  (1649ms)

═══ Part 2: LLM + Tool Caching ═══
Same questions on a new thread — LLM and tool results served from cache.

User [demo-thread-2]: What is the weather in Sofia?
Assistant:
  (7ms)

User [demo-thread-2]: And in Berlin?
  [tool cache HIT] get_weather("Sofia")
  [tool cache HIT] get_weather("Berlin")
Assistant: The current weather is as follows:

- **Sofia**: 18°C, sunny
- **Berlin**: 27°C, sunny
  (2871ms)

── Cache Stats ──
LLM tier:   1 hits / 6 misses (14% hit rate)
Tool tier:  2 hits / 2 misses (50% hit rate)
Cost saved: $0.000017
```

Part 1 shows graph state persistence: the second message (`And in Berlin?`) resumes the thread from the existing checkpoint — the graph already knows the Sofia result from the first turn.

Part 2 shows caching: the same questions on a new thread are served from Valkey. The first question (`What is the weather in Sofia?`) returns in 7ms with zero LLM tokens — a pure cache hit. The second question triggers tool cache hits for both cities, skipping the API entirely.
