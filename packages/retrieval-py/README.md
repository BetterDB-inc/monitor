# @betterdb/retrieval (Python)

[![PyPI version](https://img.shields.io/pypi/v/betterdb-retrieval)](https://pypi.org/project/betterdb-retrieval/)
[![total downloads](https://static.pepy.tech/badge/betterdb-retrieval)](https://pepy.tech/project/betterdb-retrieval)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![python](https://img.shields.io/pypi/pyversions/betterdb-retrieval)](https://pypi.org/project/betterdb-retrieval/)
[![GitHub stars](https://img.shields.io/github/stars/BetterDB-inc/monitor?style=social)](https://github.com/BetterDB-inc/monitor)

`betterdb-retrieval` — developer-facing retrieval SDK over [Valkey Search](https://valkey.io/topics/search/) (`FT.*`): typed index schema, idempotent index lifecycle, upsert/delete, and vector + filtered + hybrid query. This is the Python equivalent of the TypeScript `@betterdb/retrieval` package, built on [`betterdb-valkey-search-kit`](../valkey-search-kit-py/).

## See it live in BetterDB Monitor

[BetterDB Monitor](https://github.com/BetterDB-inc/monitor) auto-discovers every `betterdb-retrieval` instance on your Valkey - zero configuration, the library already registers itself - and turns its stats into live dashboards:

- **AI Cache & Memory** - hit rate, cost saved, evictions, and index size across all your caches and memory stores, with history.
- **AI Traces** - OpenTelemetry waterfalls for each request, correlated with live Valkey state to explain every cache hit and miss.

![AI Cache & Memory tab in BetterDB Monitor](https://raw.githubusercontent.com/BetterDB-inc/monitor/master/.github/assets/ai-cache-memory.png)

![AI Traces waterfall in BetterDB Monitor](https://raw.githubusercontent.com/BetterDB-inc/monitor/master/.github/assets/ai-traces.png)

Run it self-hosted (`docker run -p 3001:3001 betterdb/monitor`), or use [BetterDB Cloud](https://betterdb.com) - which can also **provision a managed, TLS-enabled Valkey instance with the Search module in one click** - exactly what this library needs.

## Installation

```bash
pip install betterdb-retrieval valkey
```

Requires a Valkey server with the [Valkey Search](https://valkey.io/topics/search/) module loaded.

## Quick start

```python
from valkey.asyncio import Valkey

from betterdb_retrieval import Retriever, UpsertEntry

client = Valkey.from_url("redis://localhost:6379")


async def embed(text: str) -> list[float]:
    ...  # return an embedding


retriever = Retriever(
    client=client,
    name="docs",
    schema={
        "fields": {
            "category": {"type": "tag"},
            "year": {"type": "numeric", "sortable": True},
        },
        "vector": {"algorithm": "hnsw", "metric": "cosine"},
    },
    embed_fn=embed,
)

# Create the index if it doesn't exist (idempotent; dims resolved from embed_fn).
await retriever.create_index()

await retriever.upsert([
    UpsertEntry(
        id="doc1",
        text="Valkey is a high-performance key-value store",
        fields={"category": "db", "year": 2024},
    ),
])

hits = await retriever.query(
    text="fast in-memory database",
    k=5,
    filter={"category": "db"},
)
```

## Retriever API

- `create_index()` — create the index if absent (idempotent). Vector dimension is taken from `schema["vector"]["dims"]` or resolved by probing `embed_fn`.
- `upsert(entries)` — embed each entry's `text` and write it as a hash with its `fields`.
- `delete(ids)` — delete documents by id.
- `query(*, k, text=None, vector=None, filter=None, hybrid=None)` — KNN search. Provide `text` (embedded for you) or a precomputed `vector`, a positive `k`, an optional `filter` (tag/numeric fields), and `hybrid="rerank"` to post-process hits through a `rerank_fn`. Returns `list[QueryHit]`.
- `describe_index()` / `health()` — index stats: doc count, indexing state, dimension, percent indexed, and an optional estimated recall.
- `drop_index()` — drop the index (no-op if it doesn't exist).
- `register()` / `unregister()` — publish/remove a discovery marker in the shared `__betterdb:caches` registry, ownership-checked so it never clobbers a foreign cache type.

> `QueryHit.score` is the raw KNN vector **distance** (lower is closer), not a similarity — rank ascending.

## Observability

Pass `metrics` (a `RetrievalMetrics`) and/or `tracer` (a `RetrievalTracer`) to instrument every operation. `create_prometheus_metrics()` provides a ready-made [prometheus-client](https://github.com/prometheus/client_python) implementation.

## Development

```bash
uv run --extra dev pytest tests -q
```

## License

MIT
