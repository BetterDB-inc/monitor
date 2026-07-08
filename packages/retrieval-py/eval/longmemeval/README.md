# LongMemEval harness — `betterdb-retrieval`

An evaluation harness that measures how well `betterdb-retrieval` (Valkey Search)
recalls the right conversation history on the
[LongMemEval](https://github.com/xiaowu0162/LongMemEval) long-term-memory
benchmark, and — optionally — how accurately a reader model answers from what was
retrieved. This is the Python port of the TypeScript harness in
`packages/retrieval/eval/longmemeval`.

Each benchmark record is a question plus a "haystack" of past chat sessions. The
harness indexes the haystack into a fresh Valkey Search index, runs the question
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
| **1 — real recall** | `OPENAI_API_KEY` set (real 1536-d embeddings) and/or reachable Valkey | OpenAI `text-embedding-3-small` | Valkey Search | real recall@k over real embeddings |
| **2 — retrieval + QA** | Tier 1 + `LONGMEMEVAL_QA=1` | OpenAI | Valkey Search | end-to-end recall **and** answer accuracy |

The store and embedder degrade gracefully: if Valkey is unreachable the run
falls back to the mock store; without an API key it uses the mock embedder.

## Installing

The offline Tier 0 path (mock store + hashed embedder) needs nothing beyond the
package; OpenAI calls use the stdlib. The `eval` extra only adds the Valkey
client for the real-store tier:

```bash
# from packages/retrieval-py
pip install -e '.[eval]'
```

## Running

Run it as a module from `packages/retrieval-py`:

```bash
# Tier 0 — offline, deterministic, uses the bundled fixture
python -m eval.longmemeval

# Tier 1 — real embeddings + real Valkey
OPENAI_API_KEY=sk-... VALKEY_URL=redis://localhost:6379 python -m eval.longmemeval

# Tier 2 — add reader + judge for QA accuracy
OPENAI_API_KEY=sk-... LONGMEMEVAL_QA=1 python -m eval.longmemeval

# Full dataset instead of the fixture
LONGMEMEVAL_DATA=/path/to/longmemeval_s.json LONGMEMEVAL_LIMIT=500 python -m eval.longmemeval
```

## Configuration

All configuration is via environment variables.

| Variable | Default | Meaning |
|----------|---------|---------|
| `OPENAI_API_KEY` | — | Enables real OpenAI embeddings (Tier 1) and, with `LONGMEMEVAL_QA=1`, the real reader/judge (Tier 2). Absent → mock embedder. |
| `VALKEY_URL` | `redis://:devpassword@localhost:6384` | Valkey Search connection. Unreachable → mock store. |
| `LONGMEMEVAL_DATA` | bundled `fixture.json` | Path to a LongMemEval JSON array (`longmemeval_s` / `_m` / `_oracle`). Loaded fully into memory. |
| `LONGMEMEVAL_LIMIT` | `20` | Max records to evaluate. |
| `LONGMEMEVAL_K` | `10` | Top-k retrieved per question. |
| `LONGMEMEVAL_CHUNK` | `session` | `session` = one chunk per session (over-long sessions are token-split, all keeping the same `session_id`); `turn` = one chunk per turn. |
| `LONGMEMEVAL_QA` | off | `1` runs the reader + judge (Tier 2). |
| `LONGMEMEVAL_READER_MODEL` | `gpt-5.4` | Reader chat model (Tier 2). |
| `LONGMEMEVAL_JUDGE_MODEL` | `gpt-5.5` | Judge chat model (Tier 2). |

> Note: unlike the TypeScript harness, this port does not implement hybrid
> reranking (`LONGMEMEVAL_RERANK_POOL`); it queries plain top-k.

## How it works

`run.py` wires four swappable seams (each with a mock and a real implementation)
and hands them to `run_eval` in `runner.py`:

- **Embedder** (`embed.py`) — mock hashed bag-of-words, or OpenAI
  `text-embedding-3-small` with an on-disk content-addressed cache
  (`.cache/embeddings.json`) so re-runs aren't re-billed.
- **Store** (`store.py`) — a real Valkey Search client, or an in-memory mock that
  implements the exact subset of `FT.*`/`HSET` commands the `Retriever` uses
  (deterministic).
- **Reader** (`reader.py`) — Tier 2 only; answers the question from retrieved
  excerpts.
- **Judge** (`judge.py`) — Tier 2 only; grades the answer vs. gold.

Per record, `runner.py`:

1. Chunks the haystack (`adapter.py` — token-budgeted so no chunk exceeds the
   embedder's input limit; every chunk carries a `session_id` tag and, when
   present, a `date` tag).
2. Creates a fresh index, upserts the chunks, and (real store only) polls
   `health()` until every chunk is indexed so recall isn't measured on a
   half-built HNSW graph.
3. Queries the question and takes the top `k`.
4. Scores recall@k (`record_is_hit`: any hit's `session_id` ∈ `answer_session_ids`).
5. Tier 2: prefixes each excerpt with its session `date`, anchors the question
   with `question_date`, asks the reader, grades with the judge.
6. Deletes the chunks and drops the index (each record is isolated).
7. Prints a progress heartbeat every 10 records (and on the last).

Results are aggregated per `question_type` and printed as a recall@k (and, in
Tier 2, QA-accuracy) table.

## Files

- `__main__.py` — module entry (`python -m eval.longmemeval`).
- `run.py` — selects tier and wires the seams.
- `runner.py` — the eval loop and summary formatting.
- `dataset.py` — dataset loader (`fixture.json` fallback).
- `adapter.py` — haystack → token-budgeted chunks; recall-hit check.
- `embed.py` — mock + OpenAI embedders (on-disk content-addressed cache).
- `store.py` — mock + real Valkey Search stores.
- `reader.py` / `judge.py` — Tier 2 reader and judge (mock + OpenAI).
- `openai_http.py` — thin OpenAI HTTP helper (stdlib, rate-limit retry).
- `types.py` — shared types and the four seam protocols.
- `fixture.json` — tiny bundled LongMemEval-shaped dataset for Tier 0.

## Getting the full dataset

The bundled `fixture.json` is only a handful of records for offline smoke
testing. Download the real `longmemeval_s` / `longmemeval_m` / `longmemeval_oracle`
JSON from the [LongMemEval repo](https://github.com/xiaowu0162/LongMemEval) and
point `LONGMEMEVAL_DATA` at it.
