# Vercel AI SDK + @betterdb/agent-cache

A minimal example demonstrating two caching tiers with the Vercel AI SDK.

## What it shows

1. **LLM response caching** — the `createAgentCacheMiddleware` middleware wraps your model so identical prompts (without tool calls) return cached responses instantly from Valkey with zero tokens used.
2. **Tool result caching** — the `get_weather` tool checks `cache.tool` before calling the (simulated) API, so repeated tool calls with the same arguments are free.
3. **Cost tracking** — the `costTable` option tracks estimated savings from cache hits per model.
4. **Stats** — `cache.stats()` returns hit rates, miss counts, and cumulative cost savings.

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
═══ Part 1: LLM Response Caching ═══
Same prompt twice — second call returns from Valkey, zero tokens.

User: What is the capital of Bulgaria?
Assistant: The capital of Bulgaria is Sofia.
  (1032ms | tokens: 14 in / 7 out)

User: What is the capital of Bulgaria?
Assistant: The capital of Bulgaria is Sofia.
  (1ms | tokens: 0 in / 0 out)

═══ Part 2: Tool Result Caching ═══
Same tool calls twice — second call skips the API.

User: What is the weather in Sofia and Berlin?
  [tool cache MISS] get_weather("Sofia") — calling API
  [tool cache MISS] get_weather("Berlin") — calling API
Assistant: The weather is as follows:

- **Sofia**: 30°C with rainy conditions.
- **Berlin**: 28°C with rainy conditions.
  (3016ms | tokens: 154 in / 32 out)

User: What is the weather in Sofia and Berlin?
  [tool cache HIT] get_weather("Sofia")
  [tool cache HIT] get_weather("Berlin")
Assistant: The current weather is as follows:

- **Sofia**: 30°C, rainy.
- **Berlin**: 28°C, rainy.
  (2933ms | tokens: 154 in / 31 out)

── Cache Stats ──
LLM tier:   1 hits / 5 misses (17% hit rate)
Tool tier:  2 hits / 2 misses (50% hit rate)
Cost saved: $0.000006
```

Part 1 shows the full cache benefit: the second simple call completes in ~1ms with zero tokens.

Part 2 shows tool caching: the second call reuses cached tool results (skipping the API), though the LLM is still called because multi-step tool-calling flows produce different message sequences per invocation.
