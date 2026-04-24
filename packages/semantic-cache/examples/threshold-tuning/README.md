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
  HIT  (0.002) - "What is machine learning?"
  HIT  (0.035) - "Explain machine learning simply"
  HIT~ (0.119) - "What is ML?"
  ...

-- Threshold Effectiveness Analysis --
Category: all
Sample count: 12
Current threshold: 0.15
Hit rate: 100.0%
Uncertain hit rate: 8.3%
Near-miss rate: 0.0%
Recommendation: OPTIMAL
Reasoning: Hit rate is 100.0% with 8.3% uncertain hits - threshold appears well-calibrated.
```
