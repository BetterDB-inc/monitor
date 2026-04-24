# Cost tracking example

Demonstrates recording LLM token costs at store time and reporting cost savings per cache hit. Uses the bundled default cost table (1,971 models from LiteLLM).

No API key required - uses a built-in mock embedder.

## Prerequisites

- Valkey 8.0+ with valkey-search at localhost:6399 (or set `VALKEY_HOST`/`VALKEY_PORT`)

## Run

```bash
pnpm install && pnpm start
```

## Expected output

```
=== Cost tracking example ===

WARNING: Flushing cache - deletes all existing cache data.
Cache initialized and flushed.

-- Seeding cache with cost-annotated entries --
  Stored: "What is the capital of France?..."
  Stored: "What is the capital of Germany?..."
  Stored: "Who wrote Romeo and Juliet?..."

-- Running 5 cache lookups --
  HIT: "What is the capital city of France..." | saved $0.000013
  HIT: "What is France's capital?..." | saved $0.000013
  HIT: "Capital of Germany?..." | saved $0.000013
  HIT: "Who is the author of Romeo and Juli..." | saved $0.000013
  HIT: "Who wrote the play Romeo and Juliet..." | saved $0.000013

-- Cost Summary --
Hits: 5 / Requests: 5
Total cost saved: $0.000065
```
