# @betterdb/agent-memory

[![npm version](https://img.shields.io/npm/v/@betterdb%2Fagent-memory)](https://www.npmjs.com/package/@betterdb/agent-memory)
[![total downloads](https://img.shields.io/npm/dt/@betterdb%2Fagent-memory)](https://www.npmjs.com/package/@betterdb/agent-memory)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![types](https://img.shields.io/npm/types/@betterdb%2Fagent-memory)](https://www.npmjs.com/package/@betterdb/agent-memory)
[![GitHub stars](https://img.shields.io/github/stars/BetterDB-inc/monitor?style=social)](https://github.com/BetterDB-inc/monitor)

Standalone agent memory for [Valkey](https://valkey.io/): the short-term caching tiers from [`@betterdb/agent-cache`](../agent-cache/) plus a semantic long-term `MemoryStore` backed by [Valkey Search](https://valkey.io/topics/search/) (`FT.*`). Store memories with `remember()`, retrieve the most relevant ones with `recall()` (semantic similarity blended with recency and importance), and keep stores bounded with TTLs, capacity eviction, and `consolidate()`.

## See it live in BetterDB Monitor

[BetterDB Monitor](https://github.com/BetterDB-inc/monitor) auto-discovers every `@betterdb/agent-memory` instance on your Valkey - zero configuration, the library already registers itself - and turns its stats into live dashboards:

- **AI Cache & Memory** - hit rate, cost saved, evictions, and index size across all your caches and memory stores, with history.
- **AI Traces** - OpenTelemetry waterfalls for each request, correlated with live Valkey state to explain every cache hit and miss.

![AI Cache & Memory tab in BetterDB Monitor](https://raw.githubusercontent.com/BetterDB-inc/monitor/master/.github/assets/ai-cache-memory.png)

![AI Traces waterfall in BetterDB Monitor](https://raw.githubusercontent.com/BetterDB-inc/monitor/master/.github/assets/ai-traces.png)

Run it self-hosted (`docker run -p 3001:3001 betterdb/monitor`), or use [BetterDB Cloud](https://betterdb.com) - which can also **provision a managed, TLS-enabled Valkey instance with the Search module in one click** - exactly what this library needs.

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
- `consolidate(options)` — one method, two explicit modes. Select candidates by scope, tags, `olderThanSeconds`, or `maxImportance`. **Choose the mode that matches your corpus:**
  - **`mode: 'summary'`** — *accumulation.* A `summarize(items)` callback folds the candidates into **one** new digest memory, optionally deleting the sources. Lossy — use it to compress volume. Items are passed **oldest→newest with their dates**, so the summarizer can respect recency. ⚠️ It does **not** resolve updates: it summarizes whatever it's given. For a corpus where later statements supersede earlier ones, use `mode: 'facts'` instead, or you may get conflated/stale summaries.
  - **`mode: 'facts'`** — *updates/supersession.* An `extractFacts(items)` LLM seam returns `Fact[]` (`subject`, `statement`, optional `date`, optional `tombstone`); the store reconciles them by `subject` (newest `date` wins, tombstones drop a subject), writes each **additively keeping the source memories** (recall preserved), and preserves each fact's date in its content. Reconciliation is **stateful across runs**: a re-run over unchanged sources rewrites nothing (idempotent), a newer statement supersedes (deletes) the prior fact memory, and a tombstone retracts it. A tombstone that matches no live fact is surfaced in `unmatchedTombstones` (and a metric) rather than silently dropped. The result reports `created`, `deleted`, `facts`, and `unmatchedTombstones`. Prior fact memories are excluded from the source scan so a run never re-distills its own output. Customize the fact `source` tag / default importance via the store's `consolidation` option (`{ factSource?, factImportance? }`).
- `consolidateFacts(options)` — **deprecated** thin alias for `consolidate({ mode: 'facts', ... })`; prefer the merged method.
- `currentConfig()` / `refreshConfig()` — read the live recall/eviction tunables; with `configRefresh` enabled the store periodically re-reads them from `{name}:__mem_config`.
- `close()` — stop the config-refresh timer and tear down discovery heartbeats.

### Scoring & capacity

Recall ranks by `compositeScore` — a weighted blend of similarity, recency (true half-life decay), and importance. Defaults are tunable via `MemoryStoreOptions` (`weights`, `halfLifeSeconds`, `defaultThreshold`) or live via config refresh. Set `maxItemsPerScope` to cap memories per scope; over-capacity writes evict the lowest-scoring items (importance + recency).

`recall` only returns candidates whose cosine **distance** is within a threshold (default `0.33`, i.e. similarity ≥ ~0.835). The default is deliberately loose enough to admit mainstream embedding models, whose correct matches can land near ~0.3 (e.g. Qwen3-Embedding-8B); tighten it for higher precision. When a recall returns **zero** hits but the nearest candidate sat just past the threshold (within 2×), the store flags a near-miss — a one-time `console.warn`, a `recall.zero_hits_near_threshold` span attribute, and the `..._recall_near_miss_total` metric — so a mis-set threshold surfaces instead of silently yielding nothing. Adjust it per call (`recall(query, { threshold })`) or globally (`defaultThreshold`).

## Observability

Set `telemetry: { registry }` to register Prometheus metrics (`agent_memory_*`: items, recall total/hits/empty/latency, embedding calls, evictions, consolidations) and OpenTelemetry spans for each operation. With `discovery` enabled (default in the facade), the store publishes a marker to the shared `__betterdb:caches` registry so Monitor can auto-discover it.

## License

MIT
