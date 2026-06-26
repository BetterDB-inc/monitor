# betterdb-agent-memory v0.3.0

Long-term memory tier for AI agents backed by Valkey Search — semantic recall
with recency/importance ranking, scoped capacity eviction, and consolidation.
Pairs with `betterdb-agent-cache`.

## What's new in v0.3.0

- Product analytics now start on the first data-path call (`remember`,
  `recall`, `recall_by_vector`, `get`, `list`, `stats`, `forget`,
  `forget_by_scope`, `consolidate`), not only on `ensure_index`. Apps that
  attach to an existing index now report usage analytics as expected. Opt out
  with `BETTERDB_TELEMETRY=false`.

## Analytics (since v0.2.0)

- Opt-out anonymous usage analytics (PostHog). Disable with
  `BETTERDB_TELEMETRY=false` (or `0`/`no`/`off`), or per-instance via options.
  Instance id is an anonymous UUID persisted in Valkey; no payload data is sent.

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
