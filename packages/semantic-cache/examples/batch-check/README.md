# Batch check example

Demonstrates `checkBatch()` which pipelines multiple FT.SEARCH calls to Valkey, and compares timing against sequential `check()` calls.

No API key required.

## Prerequisites

- Valkey 8.0+ with valkey-search at localhost:6399 (or set `VALKEY_HOST`/`VALKEY_PORT`)

## Run

```bash
pnpm install && pnpm start
```

## Expected output

```
=== Batch check example ===

-- Sequential check() x5 --
-- checkBatch() x5 --

-- Results comparison --
Query                                        Sequential    Batch
---------------------------------------------------------------------------
What is the capital of France?               HIT(high)     HIT(high)
Capital of Germany?                          MISS          MISS
Who invented the telephone?                  MISS          MISS
What is the capital of Italy?                HIT(high)     HIT(high)
What is the best programming language?       MISS          MISS

Sequential: 8.3ms | Batch: 4.1ms
Batch was 51% faster.
```
