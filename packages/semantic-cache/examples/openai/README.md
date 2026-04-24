# OpenAI Chat Completions example

Demonstrates semantic caching for OpenAI Chat Completions using `prepareSemanticParams()` to extract the cache key and `createOpenAIEmbed()` as the embedding function.

## Prerequisites

- Valkey 8.0+ with valkey-search running at localhost:6399 (or set `VALKEY_HOST`/`VALKEY_PORT`)
- `OPENAI_API_KEY` environment variable set

## Run

```bash
pnpm install && pnpm start
```

## Expected output

```
=== OpenAI Chat Completions + SemanticCache example ===

WARNING: Flushing cache - deletes all existing cache data.
Cache initialized and flushed.

-- Round 1: Seeding the cache --
User: What is the capital of France?
  [cache MISS] calling OpenAI API...
Assistant: The capital of France is Paris.

-- Round 2: Semantic cache hit --
User: What city is the capital of France?
  [cache HIT] similarity=0.0868 confidence=uncertain
  [cost saved] $0.000006
Assistant: The capital of France is Paris.

-- Cache Stats --
Hits: 1 | Misses: 1 | Hit rate: 50%
Cost saved: $0.000006
```
