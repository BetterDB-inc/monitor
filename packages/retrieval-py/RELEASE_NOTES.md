# betterdb-retrieval v0.1.0

Python port of `@betterdb/retrieval`. Developer-facing retrieval SDK over
Valkey Search — typed schema, idempotent index lifecycle, upsert/delete, and
vector + filtered + hybrid query, with built-in observability seams.

Requires Valkey 8+ with the **valkey-search** module (vector index support).
Works with ElastiCache for Valkey, Memorystore for Valkey, and MemoryDB.

Built on [`betterdb-valkey-search-kit`](https://pypi.org/project/betterdb-valkey-search-kit/).

---

## Installation

```sh
pip install betterdb-retrieval
```

---

## What's included

### Retriever

| Method | Description |
|---|---|
| `create_index()` | Create or attach to the vector index (idempotent) |
| `upsert(...)` | Insert or update a document with its vector and fields |
| `delete(id)` | Delete a document by id |
| `query(...)` | Vector, filtered, and hybrid (vector + filter) search |
| `health()` | Index name, doc count, vector dimension |

### Schema & fields

Typed `RetrievalSchema` with TAG / NUMERIC / vector field builders, validated
against the live `FT.INFO` to tolerate version skew.

### Discovery

Shared discovery registry with atomic register/unregister (EVAL compare-and-set).

### Observability

- `RetrievalMetrics` / `RetrievalTracer` instrumentation seams
- Prometheus metrics for query latency and result counts

---

## Full changelog

See the repository history for detailed changes.
