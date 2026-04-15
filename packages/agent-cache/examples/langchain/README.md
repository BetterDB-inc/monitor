# LangChain + @betterdb/agent-cache

A minimal example demonstrating two caching tiers with LangChain.

## What it shows

1. **LLM response caching** — `BetterDBLlmCache` plugs into LangChain's native `cache` option so identical prompts return cached responses instantly from Valkey.
2. **Tool result caching** — the `get_weather` function checks `cache.tool` before calling the (simulated) API, so repeated tool calls with the same arguments are free.
3. **Cost tracking** — the `costTable` option tracks estimated savings from LLM cache hits per model.
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
Same prompt twice — second call returns from Valkey.

User: What is the capital of Bulgaria?
Assistant: The capital of Bulgaria is Sofia.
  (1032ms)

User: What is the capital of Bulgaria?
Assistant: The capital of Bulgaria is Sofia.
  (1ms)

═══ Part 2: Tool Result Caching ═══
Same tool calls twice — second call skips the API.

  [tool cache MISS] get_weather("Sofia") — calling API
  [tool cache MISS] get_weather("Berlin") — calling API
  (first round done)

  [tool cache HIT] get_weather("Sofia")
  [tool cache HIT] get_weather("Berlin")
  (second round done — both from cache)

── Cache Stats ──
LLM tier:   1 hits / 1 misses (50% hit rate)
Tool tier:  2 hits / 2 misses (50% hit rate)
Cost saved: $0.000006
```

Part 1 shows the full cache benefit: the second call completes in ~1ms from Valkey.

Part 2 shows tool caching: the second round reuses cached tool results, skipping the simulated API entirely.
