# betterdb-agent-memory v0.1.0

Python port of `@betterdb/agent-memory`. Long-term memory tier for AI agents
backed by Valkey Search — semantic recall with recency/importance ranking,
scoped capacity eviction, and consolidation. Pairs with `betterdb-agent-cache`.

Requires Valkey 8+ with the **valkey-search** module (vector index support).
Works with ElastiCache for Valkey, Memorystore for Valkey, and MemoryDB.

Built on [`betterdb-valkey-search-kit`](https://pypi.org/project/betterdb-valkey-search-kit/)
and [`betterdb-agent-cache`](https://pypi.org/project/betterdb-agent-cache/).

---

## Installation

```sh
pip install betterdb-agent-memory
```

---

## What's included

### MemoryStore (long-term tier)

| Method | Description |
|---|---|
| `ensure_index()` | Create or attach to the memory vector index |
| `remember(...)` | Persist a memory with embedding, scope, tags, and importance |
| `recall(...)` | Semantic recall ranked by similarity, recency, and importance |
| `recall_by_vector(...)` | KNN recall from a precomputed vector |
| `reinforce(id)` | Bump importance / recency on an existing memory |
| `forget(...)` | Delete memories by id or filter |
| `consolidate(...)` | Merge and summarize related memories |
| `get(id)` / `list(...)` | Read-only fetch and scoped, paginated listing |
| `stats()` | Doc count, evictions, and live config |

Scoped capacity eviction, live config refresh, and discovery are built in.

### AgentMemory facade

Convenience facade over `betterdb-agent-cache` combining the exact-match cache
tier with the long-term memory tier.

### Observability

- OpenTelemetry spans on every memory operation
- Prometheus metrics for recall latency and eviction counts

---

## Full changelog

See the repository history for detailed changes.
