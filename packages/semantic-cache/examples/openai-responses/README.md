# OpenAI Responses API example

Demonstrates semantic caching for the OpenAI Responses API using `prepareSemanticParams()` from the `openai-responses` adapter.

## Prerequisites

- Valkey 8.0+ with valkey-search at localhost:6399 (or set `VALKEY_HOST`/`VALKEY_PORT`)
- `OPENAI_API_KEY` environment variable set

## Run

```bash
pnpm install && pnpm start
```

## Expected output

```
=== OpenAI Responses API + SemanticCache example ===

-- Round 1: Seeding --
User: What is the capital of Australia?
  [cache MISS] calling OpenAI Responses API...
Assistant: The capital of Australia is Canberra.

-- Round 2: Semantic hit --
User: Which city is the capital of Australia?
  [cache HIT] similarity=0.0810 confidence=uncertain
Assistant: The capital of Australia is Canberra.

-- Cache Stats --
Hits: 1 | Misses: 1
```
