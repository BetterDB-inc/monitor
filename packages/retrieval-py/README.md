# @betterdb/retrieval (Python)

`betterdb-retrieval` — developer-facing retrieval SDK over [Valkey Search](https://valkey.io/topics/search/) (`FT.*`): typed index schema, idempotent index lifecycle, upsert/delete, and vector + filtered + hybrid query. This is the Python equivalent of the TypeScript `@betterdb/retrieval` package, built on [`betterdb-valkey-search-kit`](../valkey-search-kit-py/).

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
