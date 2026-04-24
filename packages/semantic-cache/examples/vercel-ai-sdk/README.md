# Vercel AI SDK example

Demonstrates `createSemanticCacheMiddleware()` wired into `wrapLanguageModel()` from the Vercel AI SDK. Similar prompts return from the semantic cache without calling the LLM.

## Prerequisites

- Valkey 8.0+ with valkey-search at localhost:6399 (or set `VALKEY_HOST`/`VALKEY_PORT`)
- `OPENAI_API_KEY` environment variable set

## Run

```bash
pnpm install && pnpm start
```

## Expected output

```
=== Vercel AI SDK + createSemanticCacheMiddleware example ===

=== Round 1: First call (cache miss) ===
User: What is the capital of Portugal?
Assistant: The capital of Portugal is Lisbon.
  (1187ms)

=== Round 2: Same prompt (cache hit) ===
User: What is the capital of Portugal?
Assistant: The capital of Portugal is Lisbon.
  (38ms)

=== Round 3: Paraphrase (semantic hit) ===
User: Which city serves as Portugal's capital?
Assistant: The capital of Portugal is Lisbon.
  (41ms)

-- Cache Stats --
Hits: 2 | Misses: 1 | Hit rate: 67%
```
