# @betterdb/agent-memory

Standalone agent memory for [Valkey](https://valkey.io/): the short-term caching tiers from [`@betterdb/agent-cache`](../agent-cache/) plus a semantic long-term `MemoryStore` backed by [Valkey Search](https://valkey.io/topics/search/) (`FT.*`). Store memories with `remember()`, retrieve the most relevant ones with `recall()` (semantic similarity blended with recency and importance), and keep stores bounded with TTLs, capacity eviction, and `consolidate()`.

## Installation

```bash
npm install @betterdb/agent-memory iovalkey
```

Requires a Valkey server with the [Valkey Search](https://valkey.io/topics/search/) module loaded (for the `FT.*` commands), and an embedding function you provide.

## Quick start

The `AgentMemory` facade wires the short-term cache tiers and the long-term memory store together over a single client and name:

```ts
import Valkey from 'iovalkey';
import { AgentMemory } from '@betterdb/agent-memory';

const client = new Valkey('redis://localhost:6379');

const agent = new AgentMemory({
  client,
  name: 'my_agent',
  embedFn: async (text) => embed(text), // returns number[]
});

// Create the vector index and register discovery markers (idempotent).
await agent.initialize();

// Long-term memory:
await agent.memory.remember('User prefers dark mode', {
  agentId: 'assistant',
  importance: 0.8,
  tags: ['preferences'],
});

const hits = await agent.memory.recall('what theme does the user like?', {
  agentId: 'assistant',
  k: 5,
});

// Short-term cache tiers (from @betterdb/agent-cache):
agent.llm;
agent.tool;
agent.session;

await agent.close();
```

You can also use the `MemoryStore` directly, without the cache tiers:

```ts
import { MemoryStore } from '@betterdb/agent-memory';

const memory = new MemoryStore({ client, name: 'my_agent', embedFn });
await memory.ensureIndex();
```

## MemoryStore API

- `ensureIndex()` — create the `{name}:mem:idx` vector index if absent (idempotent). Resolves the vector dimension from `embedFn`.
- `remember(content, options?)` — embed and store a memory; returns its id. Options: `importance` (0..1), `tags`, `ttl` (seconds), and scope (`threadId`, `agentId`, `namespace`).
- `recall(query, options?)` — semantic search scoped by `threadId`/`agentId`/`namespace`/`tags`, ranked by a composite of similarity, recency (half-life decay), and importance. Returns `MemoryHit[]`. Recalled memories are reinforced (last-access + access-count bumped) unless `reinforce: false`.
- `forget(id)` — delete a single memory by id.
- `forgetByScope(scope)` — delete all memories matching a scope and/or tags.
- `consolidate(options)` — summarize a set of memories (via a `summarize` callback) into one new memory and optionally delete the sources. Select candidates by scope, tags, `olderThanSeconds`, or `maxImportance`.
- `consolidateFacts(options)` — distill a set of memories into atomic, deduplicated facts and write each as its own memory, **keeping the source memories** (additive, so recall is preserved). You supply an `extractFacts(items)` LLM seam that returns `Fact[]` (`subject`, `statement`, optional `date`, optional `tombstone`); the store reconciles them by `subject` (newest `date` wins, tombstones drop a subject) and preserves each fact's date in its content. Reconciliation is **stateful across runs**: each fact memory persists its `subject`, so a later run loads the stored facts and reconciles against them — a re-run over unchanged sources rewrites nothing (idempotent), a newer statement supersedes (deletes) the prior fact memory, and a tombstone retracts it. The result reports `created` (ids written) and `deleted` (prior fact memories superseded or retracted). Off by default — construct the store with `consolidation: true` (or `{ enabled: true, factSource?, factImportance? }`) to enable it, otherwise it throws. Select sources by scope, tags, `olderThanSeconds`, or `maxImportance`; prior fact memories are excluded from the source scan so a run never re-distills its own output.
- `currentConfig()` / `refreshConfig()` — read the live recall/eviction tunables; with `configRefresh` enabled the store periodically re-reads them from `{name}:__mem_config`.
- `close()` — stop the config-refresh timer and tear down discovery heartbeats.

### Scoring & capacity

Recall ranks by `compositeScore` — a weighted blend of similarity, recency (true half-life decay), and importance. Defaults are tunable via `MemoryStoreOptions` (`weights`, `halfLifeSeconds`, `defaultThreshold`) or live via config refresh. Set `maxItemsPerScope` to cap memories per scope; over-capacity writes evict the lowest-scoring items (importance + recency).

`recall` only returns candidates whose cosine **distance** is within a threshold (default `0.25`, i.e. similarity ≥ ~0.875) — tuned for real semantic embeddings, where a relevant memory lands well inside it. A weak or non-semantic `embedFn` can push every candidate past the threshold and yield no hits; raise it per call (`recall(query, { threshold })`) or globally (`defaultThreshold`) if that happens.

## Observability

Set `telemetry: { registry }` to register Prometheus metrics (`agent_memory_*`: items, recall total/hits/empty/latency, embedding calls, evictions, consolidations) and OpenTelemetry spans for each operation. With `discovery` enabled (default in the facade), the store publishes a marker to the shared `__betterdb:caches` registry so Monitor can auto-discover it.

## License

MIT
