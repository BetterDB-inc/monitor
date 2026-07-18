# @betterdb/agent-memory (Python)

[![PyPI version](https://img.shields.io/pypi/v/betterdb-agent-memory)](https://pypi.org/project/betterdb-agent-memory/)
[![total downloads](https://static.pepy.tech/badge/betterdb-agent-memory)](https://pepy.tech/project/betterdb-agent-memory)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![python](https://img.shields.io/pypi/pyversions/betterdb-agent-memory)](https://pypi.org/project/betterdb-agent-memory/)
[![GitHub stars](https://img.shields.io/github/stars/BetterDB-inc/monitor?style=social)](https://github.com/BetterDB-inc/monitor)

`betterdb-agent-memory` is the long-term memory tier for AI agents, backed by
[Valkey Search](https://valkey.io/topics/search/). It is the Python port of
[`@betterdb/agent-memory`](https://www.npmjs.com/package/@betterdb/agent-memory)
and pairs with [`betterdb-agent-cache`](https://pypi.org/project/betterdb-agent-cache/)
(the short-term llm/tool/session cache tiers).

Where the cache tiers are exact-match and ephemeral, the memory tier is
semantic and durable: it embeds content, stores it in an HNSW vector index, and
recalls it by meaning with a composite score that blends **similarity**,
**recency** (half-life decay), and **importance**.

## See it live in BetterDB Monitor

[BetterDB Monitor](https://github.com/BetterDB-inc/monitor) auto-discovers every `betterdb-agent-memory` instance on your Valkey - zero configuration, the library already registers itself - and turns its stats into live dashboards:

- **AI Cache & Memory** - hit rate, cost saved, evictions, and index size across all your caches and memory stores, with history.
- **AI Traces** - OpenTelemetry waterfalls for each request, correlated with live Valkey state to explain every cache hit and miss.

![AI Cache & Memory tab in BetterDB Monitor](https://raw.githubusercontent.com/BetterDB-inc/monitor/master/.github/assets/ai-cache-memory.png)

![AI Traces waterfall in BetterDB Monitor](https://raw.githubusercontent.com/BetterDB-inc/monitor/master/.github/assets/ai-traces.png)

Run it self-hosted (`docker run -p 3001:3001 betterdb/monitor`), or use [BetterDB Cloud](https://betterdb.com) - which can also **provision a managed, TLS-enabled Valkey instance with the Search module in one click** - exactly what this library needs.

## Features

- **Semantic recall** — KNN vector search with a tunable composite score.
- **Scoping** — memories carry `thread_id` / `agent_id` / `namespace` / `tags`;
  recall, forget, and consolidation all filter by scope.
- **Reinforcement** — recalled memories bump `last_accessed_at` + `access_count`,
  so frequently-used memories stay recallable.
- **Capacity eviction** — `max_items_per_scope` evicts the lowest-scoring
  memories (importance + recency) once a scope exceeds its cap.
- **Consolidation** — fold a set of older/low-importance memories into a single
  summary memory.
- **Live config** — re-read `recall.threshold` / weights / `halfLifeSeconds` /
  `maxItemsPerScope` from a Valkey hash without a restart.
- **Observability** — OpenTelemetry spans + Prometheus metrics.
- **Discovery** — registers a marker so BetterDB Monitor can enumerate the tier.

## Installation

```bash
pip install betterdb-agent-memory
```

You also need a Valkey server with the Search module loaded (e.g.
`valkey/valkey-bundle`) and the [`valkey`](https://pypi.org/project/valkey/)
async client.

## Quick start

```python
import valkey.asyncio as valkey
from betterdb_agent_memory import AgentMemory, AgentMemoryOptions

async def embed(text: str) -> list[float]:
    # Replace with a real embedding model (OpenAI, sentence-transformers, ...).
    ...

async def main() -> None:
    client = valkey.Valkey(host="localhost", port=6379)
    agent = AgentMemory(AgentMemoryOptions(client=client, embed_fn=embed))
    await agent.initialize()

    await agent.memory.remember(
        "User prefers dark mode and concise answers.",
        importance=0.8,
        tags=["preference", "ui"],
        thread_id="t1",
    )

    hits = await agent.memory.recall("what UI settings does the user like?", thread_id="t1")
    for hit in hits:
        print(hit.score, hit.item.content)

    # Short-term cache tiers remain available:
    # agent.llm, agent.tool, agent.session

    await agent.close()
```

## Using the memory tier standalone

If you only need the memory tier, construct `MemoryStore` directly:

```python
from betterdb_agent_memory import MemoryStore

store = MemoryStore(client=client, name="myapp", embed_fn=embed)
await store.ensure_index()
await store.remember("hello", thread_id="t1")
hits = await store.recall("hi", thread_id="t1")
```

## API

### `MemoryStore`

- `await ensure_index()` — create the `{name}:mem:idx` HNSW index if absent.
- `await remember(content, *, importance=None, tags=None, source=None, ttl=None, thread_id=None, agent_id=None, namespace=None) -> str`
- `await recall(query, *, k=None, threshold=None, tags=None, weights=None, reinforce=None, thread_id=None, agent_id=None, namespace=None) -> list[MemoryHit]`
- `await forget(id) -> bool`
- `await forget_by_scope(*, thread_id=None, agent_id=None, namespace=None, tags=None) -> int`
- `await consolidate(*, mode, summarize=None, extract_facts=None, older_than_seconds=None, max_importance=None, delete_sources=None, summary_importance=None, fact_importance=None, tags=None, thread_id=None, agent_id=None, namespace=None) -> ConsolidateResult | ConsolidateFactsResult` - one method, two explicit modes; select candidates by scope, tags, `older_than_seconds`, or `max_importance`:
  - **`mode="summary"`** - *accumulation.* `summarize(items)` folds the candidates into **one** new digest memory, optionally deleting the sources. Lossy - use it to compress volume. Items are passed **oldest→newest with their dates**, so the summarizer can respect recency. It does **not** resolve updates; for a corpus where later statements supersede earlier ones, use `mode="facts"` or you may get conflated/stale summaries.
  - **`mode="facts"`** - *updates/supersession.* An `extract_facts(items)` LLM seam returns `list[Fact]` (`subject`, `statement`, optional `date`, optional `tombstone`); facts are reconciled by `subject` (newest `date` wins, tombstones drop a subject), written **additively keeping the source memories** (recall preserved), and each fact's date is preserved in its content. Reconciliation is **stateful across runs**: a re-run over unchanged sources rewrites nothing (idempotent), a newer statement supersedes (deletes) the prior fact memory, and a tombstone retracts it. A tombstone that matches no live fact is surfaced in `unmatched_tombstones` (and a metric) rather than silently dropped. The result reports `created`, `deleted`, `facts`, and `unmatched_tombstones`; prior fact memories are excluded from the source scan so a run never re-distills its own output. Customize the fact `source` tag / default importance via the store's `consolidation` option (`ConsolidationConfig(fact_source=..., fact_importance=...)`).
- `await consolidate_facts(*, extract_facts, ...) -> ConsolidateFactsResult` - **deprecated** thin alias for `consolidate(mode="facts", ...)`; prefer the merged method.
- `current_config() -> MemoryConfigSnapshot`
- `await refresh_config()`
- `await ensure_discovery_ready()`
- `await close()`

### `AgentMemory`

The batteries-included facade: an `AgentCache` (llm/tool/session) plus a
`MemoryStore` sharing one client and name. `initialize()` creates the index and
readies discovery for both tiers; `close()` tears both down.

## Scoring

`composite_score = w.similarity * similarity + w.recency * recency + w.importance * importance`

where `similarity = 1 - distance / 2` (cosine distance → 0..1) and `recency`
decays with a true half-life (`0.5` at one `half_life_seconds`). Default weights
are `{similarity: 0.6, recency: 0.25, importance: 0.15}`, default threshold
`0.33` (similarity ≥ ~0.835 — loose enough to admit mainstream embedding models,
whose correct matches can land near ~0.3), default half-life 7 days. When a recall
returns **zero** hits but the nearest candidate sat just past the threshold
(within 2×), the store flags a near-miss (a one-time warning + the
`..._recall_near_miss_total` metric) so a mis-set threshold surfaces instead of
silently yielding nothing.

## License

MIT
