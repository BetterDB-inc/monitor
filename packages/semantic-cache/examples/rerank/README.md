# Rerank hook example

Demonstrates the `rerank` option which retrieves top-k candidates and selects the best one using a custom ranking function. Shows how reranking differs from simple top-1 selection.

No API key required.

## Prerequisites

- Valkey 8.0+ with valkey-search at localhost:6399 (or set `VALKEY_HOST`/`VALKEY_PORT`)

## Run

```bash
pnpm install && pnpm start
```

## Expected output

```
=== Rerank hook example ===

-- Without rerank (top-1 by similarity): "Tell me about machine learning" --
  HIT: "ML is a subset of AI."
  Similarity: 0.1234

-- With rerank (longest response wins): "Tell me about machine learning" --
  HIT: "Machine learning enables computers to learn from experience..."

-- With strict quality rerank (reject similarity > 0.2): "Tell me about machine learning" --
  MISS - no candidate passed the quality threshold.
```
