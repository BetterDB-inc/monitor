# LongMemEval harness — `@betterdb/retrieval`

An evaluation harness that measures how well `@betterdb/retrieval` (valkey-search
over Valkey) recalls the right conversation history on the
[LongMemEval](https://github.com/xiaowu0162/LongMemEval) long-term-memory
benchmark, and — optionally — how accurately a reader model answers from what was
retrieved.

Each benchmark record is a question plus a "haystack" of past chat sessions. The
harness indexes the haystack into a fresh valkey-search index, runs the question
as a vector query, and scores the result two ways:

- **recall@k** — did any retrieved chunk come from a session that actually holds
  the evidence (`answer_session_ids`)?
- **QA accuracy** (Tier 2) — feed the retrieved excerpts to a reader model, then
  grade its answer against the gold answer with a judge model.

## Tiers

The harness auto-selects a tier from what's available (API key, reachable
Valkey, `LONGMEMEVAL_QA`). No flags to remember — set the env and it prints the
tier it ran.

| Tier | When | Embedder | Store | What it proves |
|------|------|----------|-------|----------------|
| **0 — offline** | no `OPENAI_API_KEY`, Valkey unreachable | mock hashed bag-of-words (256-d) | in-memory mock | ranking/plumbing work; fully deterministic, no network |
| **1 — real recall** | `OPENAI_API_KEY` set (real 1536-d embeddings) and/or reachable Valkey | OpenAI `text-embedding-3-small` | valkey-search | real recall@k over real embeddings |
| **2 — retrieval + QA** | Tier 1 + `LONGMEMEVAL_QA=1` | OpenAI | valkey-search | end-to-end recall **and** answer accuracy |

The store and embedder degrade gracefully: if Valkey is unreachable the run
falls back to the mock store; without an API key it uses the mock embedder.

## Running

From `packages/retrieval`:

```bash
# Tier 0 — offline, deterministic, uses the bundled fixture
pnpm eval:longmemeval

# Tier 1 — real embeddings + real Valkey
OPENAI_API_KEY=sk-... VALKEY_URL=redis://localhost:6379 pnpm eval:longmemeval

# Tier 2 — add reader + judge for QA accuracy
OPENAI_API_KEY=sk-... LONGMEMEVAL_QA=1 pnpm eval:longmemeval

# Full dataset instead of the fixture
LONGMEMEVAL_DATA=/path/to/longmemeval_s.json LONGMEMEVAL_LIMIT=500 pnpm eval:longmemeval
```

The script is `tsx eval/longmemeval/run.ts`.

## Configuration

All configuration is via environment variables.

| Variable | Default | Meaning |
|----------|---------|---------|
| `OPENAI_API_KEY` | — | Enables real OpenAI embeddings (Tier 1) and, with `LONGMEMEVAL_QA=1`, the real reader/judge (Tier 2). Absent → mock embedder. |
| `VALKEY_URL` | `redis://:devpassword@localhost:6384` | valkey-search connection. Unreachable → mock store. |
| `LONGMEMEVAL_DATA` | bundled `fixture.json` | Path to a LongMemEval JSON array (`longmemeval_s` / `_m` / `_oracle`). Streamed record-by-record, so multi-GB files are fine. |
| `LONGMEMEVAL_LIMIT` | `20` | Max records to evaluate. |
| `LONGMEMEVAL_K` | `10` | Top-k retrieved per question. |
| `LONGMEMEVAL_CHUNK` | `session` | `session` = one chunk per session (over-long sessions are token-split, all keeping the same `session_id`); `turn` = one chunk per turn. |
| `LONGMEMEVAL_QA` | off | `1` runs the reader + judge (Tier 2). |
| `LONGMEMEVAL_RERANK_POOL` | `=k` (off) | Over-fetch this many candidates and hybrid (dense + lexical) rerank them down to `k`. Set `> k` to enable; `=k` is baseline top-k. |
| `LONGMEMEVAL_READER_MODEL` | `gpt-5.4` | Reader chat model (Tier 2). |
| `LONGMEMEVAL_JUDGE_MODEL` | `gpt-5.5` | Judge chat model (Tier 2). |

## How it works

`run.ts` wires four swappable seams (each with a mock and a real implementation)
and hands them to `runEval` in `runner.ts`:

- **Embedder** (`embed.ts`) — mock hashed bag-of-words, or OpenAI
  `text-embedding-3-small` with an on-disk content-addressed cache
  (`.cache/embeddings.json`) so re-runs aren't re-billed. Chunks are batch-embedded
  up front (`prewarm`) so per-entry upsert calls hit the warm cache.
- **Store** (`store.ts`) — a real `iovalkey` valkey-search client, or an in-memory
  mock that implements the exact subset of `FT.*`/`HSET` commands the `Retriever`
  uses (FLAT-exact cosine, deterministic).
- **Reader** (`reader.ts`) — Tier 2 only; answers the question from retrieved
  excerpts.
- **Judge** (`judge.ts`) — Tier 2 only; grades the answer vs. gold.

Per record, `runner.ts`:

1. Chunks the haystack (`adapter.ts` — token-budgeted so no chunk exceeds the
   embedder's input limit; every chunk carries a `session_id` tag and, when
   present, a `date` tag).
2. Creates a fresh index, upserts the chunks, and (real store only) polls
   `health()` until every chunk is indexed so recall isn't measured on a
   half-built HNSW graph.
3. Queries the question, optionally hybrid-reranks the over-fetched pool
   (`rerank.ts`) and slices back to `k`.
4. Scores recall@k (`recordIsHit`: any hit's `session_id` ∈ `answer_session_ids`).
5. Tier 2: prefixes each excerpt with its session `date`, anchors the question
   with `question_date`, asks the reader, grades with the judge.
6. Deletes the chunks and drops the index (each record is isolated).

Results are aggregated per `question_type` and printed as a recall@k (and, in
Tier 2, QA-accuracy) table.

## Files

- `run.ts` — entry point / CLI; selects tier and wires the seams.
- `runner.ts` — the eval loop and summary formatting.
- `dataset.ts` — streaming loader (`fixture.json` fallback).
- `adapter.ts` — haystack → token-budgeted chunks; recall-hit check.
- `embed.ts` — mock + OpenAI embedders (cache, batching, rate-limit retry).
- `store.ts` — mock + real valkey-search stores.
- `reader.ts` / `judge.ts` — Tier 2 reader and judge (mock + OpenAI).
- `rerank.ts` — hybrid dense + lexical reranker.
- `types.ts` — shared types and the four seam interfaces.
- `fixture.json` — tiny bundled LongMemEval-shaped dataset for Tier 0.

## Getting the full dataset

The bundled `fixture.json` is only a handful of records for offline smoke
testing. Download the real `longmemeval_s` / `longmemeval_m` / `longmemeval_oracle`
JSON from the [LongMemEval repo](https://github.com/xiaowu0162/LongMemEval) and
point `LONGMEMEVAL_DATA` at it.
