# LlamaIndex example

Demonstrates semantic caching for LlamaIndex `ChatMessage` arrays using `prepareSemanticParams()` to extract the last user message as the cache key.

## Prerequisites

- Valkey 8.0+ with valkey-search at localhost:6399 (or set `VALKEY_HOST`/`VALKEY_PORT`)
- `OPENAI_API_KEY` environment variable set (for embeddings)

## Run

```bash
pnpm install && pnpm start
```

## Expected output

```
=== LlamaIndex + SemanticCache example ===

-- Seeding cache --
  Stored: "What is the speed of light?" -> "The speed of light in vacuum is app..."

-- Check 1: Exact match --
  [cache HIT] similarity=0.0000 confidence=high
  Response: The speed of light in vacuum is approximately 299,792 km/s.

-- Check 2: Paraphrase --
  Extracted key: "How fast does light travel?"
  [cache HIT] similarity=0.0421 confidence=high
  Response: The speed of light in vacuum is approximately 299,792 km/s.

-- Stats --
Hits: 2 | Misses: 0
```
