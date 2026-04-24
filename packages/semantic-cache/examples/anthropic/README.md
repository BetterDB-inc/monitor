# Anthropic Messages API example

Demonstrates semantic caching for Anthropic Messages API using `prepareSemanticParams()` from the Anthropic adapter. Uses OpenAI embeddings because Anthropic does not provide an embedding API.

## Prerequisites

- Valkey 8.0+ with valkey-search at localhost:6399 (or set `VALKEY_HOST`/`VALKEY_PORT`)
- `ANTHROPIC_API_KEY` environment variable set
- `OPENAI_API_KEY` environment variable set (for embeddings)

## Run

```bash
pnpm install && pnpm start
```

## Expected output

```
=== Anthropic Messages + SemanticCache example ===

WARNING: Flushing cache - deletes all existing cache data.
Cache initialized and flushed.

-- Round 1: Seeding the cache --
User: What is the capital of Japan?
  [cache MISS] calling Anthropic API...
Assistant: Tokyo is the capital of Japan.

-- Round 2: Semantic cache hit --
User: Which city is the capital of Japan?
  [cache HIT] similarity=0.0915 confidence=uncertain
Assistant: The capital of Japan is Tokyo.

-- Cache Stats --
Hits: 1 | Misses: 1 | Hit rate: 50%
Cost saved: $0.000064
```
