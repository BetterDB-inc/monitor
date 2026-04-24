# LangGraph semantic memory store example

Demonstrates `BetterDBSemanticStore` as a LangGraph-compatible memory store. Supports `put()`, `get()`, `search()`, and `delete()` with similarity-based retrieval.

**When to use this vs agent-cache/langgraph:**
- Use `BetterDBSemanticStore` (this) for similarity-based memory retrieval.
- Use agent-cache `BetterDBSaver` for exact-match checkpoint persistence.

No API key required.

## Prerequisites

- Valkey 8.0+ with valkey-search at localhost:6399 (or set `VALKEY_HOST`/`VALKEY_PORT`)

## Run

```bash
pnpm install && pnpm start
```

## Expected output

```
=== LangGraph BetterDBSemanticStore example ===

WARNING: Flushing cache - deletes all existing cache data.
Cache initialized and flushed.

-- Storing memories --
  Stored 3 memories.

-- Get by key (mem1) --
  Found: key=mem1 value={"content":"Alice lives in Paris and loves museums.","type":"location"}

-- Semantic search: "What does Alice do for work?" --
  Found 1 result(s):
  - [mem2] "Alice is a software engineer who works on AI projects."...

-- Batch write --
  Batch write complete.
```
