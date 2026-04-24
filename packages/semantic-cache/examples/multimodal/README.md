# Multi-modal caching example

Demonstrates caching prompts that contain both text and binary content (images). Shows that prompts with the same text but different images are treated as cache misses, while prompts with the same text AND the same image produce cache hits.

No API key required - uses a built-in mock embedder.

## Prerequisites

- Valkey 8.0+ with valkey-search at localhost:6399 (or set `VALKEY_HOST`/`VALKEY_PORT`)

## Run

```bash
pnpm install && pnpm start
```

## Expected output

```
=== Multi-modal caching example ===

WARNING: Flushing cache - deletes all existing cache data.
Cache initialized and flushed.

-- Storing: "Describe the color..." + red image --
  Stored entry with red image.

-- Check 1: Same text + same image --
  HIT - response: "The image is red." | similarity: 0.0000

-- Check 2: Same text + different image (blue) --
  MISS - different image ref, no cache hit.

-- Check 3: Same text, no image (text-only) --
  MISS - text-only prompt does not match image-tagged entry.

-- Cache Stats --
Hits: 1 | Misses: 2
```
