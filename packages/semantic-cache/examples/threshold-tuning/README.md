# Threshold effectiveness tuning example

Demonstrates `thresholdEffectiveness()` analyzing the rolling similarity score window and recommending whether to tighten or loosen the threshold.

No API key required - uses a built-in mock embedder with controlled noise.

## Prerequisites

- Valkey 8.0+ with valkey-search at localhost:6399 (or set `VALKEY_HOST`/`VALKEY_PORT`)

## Run

```bash
pnpm install && pnpm start
```

## Expected output

```
=== Threshold effectiveness tuning example ===

WARNING: Flushing cache - deletes all existing cache data.
Cache initialized. Threshold: 0.15

-- Seeding cache with 5 entries --
  Seeding complete.

-- Running 12 queries to build similarity window --
  HIT  (0.021) - "What is machine learning?"
  HIT~ (0.143) - "Explain machine learning simply"
  MISS (0.187) - "What is ML?"
  ...

-- Threshold Effectiveness Analysis --
Category: all
Sample count: 12
Current threshold: 0.15
Hit rate: 50.0%
Uncertain hit rate: 33.3%
Recommendation: TIGHTEN_THRESHOLD
Recommended threshold: 0.1425
Reasoning: 33.3% of hits are in the uncertainty band - tighten the threshold...
```
