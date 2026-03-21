# Basic example — @betterdb/semantic-cache

A runnable example demonstrating core semantic cache operations against a live Valkey instance.

## Prerequisites

- Docker
- Node.js 20+

## Quick start (no API key needed)

Start Valkey with `valkey-search`:

```bash
docker-compose up -d
```

Install dependencies and run in mock mode:

```bash
npm install
npm start -- --mock
```

Expected output (abbreviated):

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  MOCK MODE — no OpenAI API key needed

  ⚠️  Uses WORD OVERLAP, not semantic understanding.
  ...
  Threshold: 0.25 (mock) vs 0.10 (real mode default)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[check 1] "What is the capital of France?"
  hit: true | confidence: high | similarity: 0.0000 | response: Paris
  (mock: shared words — capital, france)

[check 2] "Capital city of France?"
  hit: true | confidence: high | similarity: 0.1835 | response: Paris
  (mock: shared words — capital, france)

[check 3] "Who wrote Hamlet?"
  hit: false | nearest miss: 0.5918 (delta: +0.3418)
  (mock: no shared words with stored prompts)

[check 4] "What is the best pizza topping?"
  hit: false | nearest miss: 1.0000 (delta: +0.7500)
  (mock: no shared words with stored prompts)

Cache stats: 2 hits / 4 lookups (50.0% hit rate)
```

## With OpenAI (real semantic similarity)

```bash
OPENAI_API_KEY=sk-... npm start
```

## Mock mode vs real embeddings

Mock mode uses **word overlap** (TF-IDF), not semantic understanding. Results differ from a real embedding model:

| Query | Mock result | Real embedder result | Reason |
|-------|-------------|----------------------|--------|
| "Capital city of France?" | ✅ hit | ✅ hit | Both: shares `capital`, `france` |
| "Where does the French government sit?" | ❌ miss | ✅ hit | Mock: no shared words. Real: semantically equivalent |
| "France capital budget 2024" | ✅ hit | ❌ miss | Mock: shares `france`, `capital`. Real: different meaning |
| "Who wrote Hamlet?" | ❌ miss | ✅ hit | Mock: no shared words. Real: same author as Romeo and Juliet |

Mock mode is useful for verifying the cache plumbing works end-to-end without an API key.
Use a real embedding model to evaluate actual semantic cache effectiveness.

The mock threshold is also set higher (`0.25`) than the real mode default (`0.10`) to
account for the coarser word-overlap distances. This is not representative of production behaviour.

## What it demonstrates

1. **Exact match** — looking up a prompt identical to one that was stored; returns a hit with `confidence: 'high'`
2. **Paraphrase** — looking up a rephrased version of a stored prompt; hits because key content words overlap
3. **Related but different** — "Who wrote Hamlet?" vs stored "Who wrote Romeo and Juliet?"; misses in mock mode
4. **Unrelated prompt** — a completely unrelated query; returns a miss with `nearestMiss` diagnostics

The example also prints cache statistics (`hits`, `misses`, `hitRate`) and index metadata (`numDocs`, `dimension`).

## Using a different Valkey port

```bash
VALKEY_URL=redis://localhost:6390 npm start -- --mock
```
