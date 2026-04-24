# Embedding cache example

Demonstrates that repeated `check()` calls on the same text skip the `embedFn` call when the embedding cache is enabled, saving API costs and latency.

No API key required.

## Prerequisites

- Valkey 8.0+ with valkey-search at localhost:6399 (or set `VALKEY_HOST`/`VALKEY_PORT`)

## Run

```bash
pnpm install && pnpm start
```

## Expected output

```
=== Embedding cache example ===

-- With embedding cache ENABLED --
  After 1st call (same text):  3 embedFn call(s)
  After 2nd call (same text):  3 embedFn call(s) [cached!]
  After 3rd call (diff text):  4 embedFn call(s)

-- With embedding cache DISABLED --
  After 1st call (same text):  3 embedFn call(s)
  After 2nd call (same text):  4 embedFn call(s)
  After 3rd call (diff text):  5 embedFn call(s)

Key insight: when enabled, repeated check() on the same text
reads the cached Float32 vector from Valkey instead of calling embedFn.
```
