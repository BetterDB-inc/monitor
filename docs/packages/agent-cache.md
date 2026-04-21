---
layout: default
title: Agent Cache
parent: Packages
nav_order: 2
---

# Agent Cache

`@betterdb/agent-cache` is a standalone, framework-agnostic, multi-tier exact-match cache for AI agent workloads backed by Valkey. Three cache tiers behind one connection: LLM responses, tool results, and session state. Every cache operation emits an OpenTelemetry span and updates Prometheus metrics, giving teams full production observability without additional instrumentation. No modules required — works on vanilla Valkey 7+, ElastiCache, Memorystore, MemoryDB, and any Redis-compatible endpoint.

## Prerequisites

- **Valkey 7+** or Redis 6.2+ (no modules, no RediSearch, no RedisJSON)
- Or **Amazon ElastiCache for Valkey / Redis**
- Or **Google Cloud Memorystore for Valkey**
- Or **Amazon MemoryDB**
- Node.js >= 20

## Installation

```bash
npm install @betterdb/agent-cache iovalkey
```

`iovalkey` is a peer dependency — you must install it alongside the package.

## Quick start

```typescript
import Valkey from 'iovalkey';
import { AgentCache } from '@betterdb/agent-cache';

const client = new Valkey({ host: 'localhost', port: 6379 });

const cache = new AgentCache({
  client,
  tierDefaults: {
    llm:     { ttl: 3600 },
    tool:    { ttl: 300 },
    session: { ttl: 1800 },
  },
});

// LLM response caching
const params = {
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'What is Valkey?' }],
  temperature: 0,
};

const result = await cache.llm.check(params);

if (!result.hit) {
  const response = await callLlm(params);
  await cache.llm.store(params, response);
}

// Tool result caching
const weather = await cache.tool.check('get_weather', { city: 'Sofia' });
if (!weather.hit) {
  const data = await getWeather({ city: 'Sofia' });
  await cache.tool.store('get_weather', { city: 'Sofia' }, JSON.stringify(data));
}

// Session state
await cache.session.set('thread-1', 'last_intent', 'book_flight');
const intent = await cache.session.get('thread-1', 'last_intent');
```

## Why agent-cache

As of 2026, no existing caching solution for AI agents provides all three of the following: **multi-tier caching** (LLM responses, tool results, and session state in one package), **built-in observability** (OpenTelemetry spans and Prometheus metrics at the cache operation level), and **no module requirements** (works on vanilla Valkey without RedisJSON or RediSearch).

| Capability | @betterdb/agent-cache | LangChain RedisCache | LangGraph checkpoint-redis | AutoGen RedisStore | LiteLLM Redis | Upstash + Vercel AI SDK |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| Multi-tier (LLM + Tool + State) | ✅ | ❌ LLM only | ❌ State only | ❌ LLM only | ❌ LLM only | ❌ LLM only |
| Built-in OTel + Prometheus | ✅ | ❌ | ❌ | ❌ | ⚠️ Partial | ❌ |
| No modules required | ✅ | ✅ | ❌ Redis 8 + modules | ✅ | ✅ | ❌ Upstash only |
| Framework adapters | ✅ LC, LG, AI SDK | ❌ LC only | ❌ LG only | ❌ AutoGen only | ❌ LiteLLM only | ❌ AI SDK only |

## Configuration reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `client` | `Valkey` | *required* | An `iovalkey` client instance. The caller owns the connection lifecycle |
| `name` | `string` | `'betterdb_ac'` | Key prefix for all Valkey keys |
| `defaultTtl` | `number` | `undefined` | Default TTL in seconds. `undefined` means no expiry |
| `tierDefaults.llm.ttl` | `number` | `undefined` | Default TTL for LLM cache entries |
| `tierDefaults.tool.ttl` | `number` | `undefined` | Default TTL for tool cache entries |
| `tierDefaults.session.ttl` | `number` | `undefined` | Default TTL for session entries |
| `costTable` | `Record<string, ModelCost>` | `undefined` | Model pricing for cost savings tracking. Optional. Merges with built-in default table from LiteLLM (overrides default entries for matching keys). Set useDefaultCostTable: false to disable the default. |
| `useDefaultCostTable` | `boolean` | `true` | Use bundled default cost table sourced from LiteLLM. Set to `false` to disable. |
| `telemetry.tracerName` | `string` | `'@betterdb/agent-cache'` | OpenTelemetry tracer name |
| `telemetry.metricsPrefix` | `string` | `'agent_cache'` | Prefix for all Prometheus metric names |
| `telemetry.registry` | `Registry` | prom-client default | prom-client `Registry` to register metrics on |

### ModelCost format

```typescript
{
  'gpt-4o': { inputPer1k: 0.0025, outputPer1k: 0.01 },
  'gpt-4o-mini': { inputPer1k: 0.00015, outputPer1k: 0.0006 },
}
```

### Default cost table

A default cost table sourced from LiteLLM's `model_prices_and_context_window.json` is bundled with the package and refreshed on every release. Cost tracking works out of the box for common models (GPT-4o, Claude, Gemini, and 100+ others).

To override a specific model's pricing without losing the defaults for others:

```typescript
const cache = new AgentCache({
  client,
  costTable: {
    'gpt-4o': { inputPer1k: 0.002, outputPer1k: 0.008 },
  },
});
```

To disable the default table entirely:

```typescript
const cache = new AgentCache({
  client,
  useDefaultCostTable: false,
  costTable: { /* your exact table */ },
});
```

## Cache tiers

### LLM cache

Caches LLM responses by exact match on model, messages, temperature, top_p, max_tokens, and tools.

**Key format:** `{name}:llm:{sha256_hash}`

**TTL precedence:** per-call `ttl` > `tierDefaults.llm.ttl` > `defaultTtl`

```typescript
// Check for cached response
const result = await cache.llm.check({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello' }],
  temperature: 0,
});

// Store a response with token counts for cost tracking
await cache.llm.store(params, response, {
  ttl: 3600,
  tokens: { input: 10, output: 50 },
});

// Invalidate all entries for a specific model
const deleted = await cache.llm.invalidateByModel('gpt-4o');
```

Cache keys are computed by serializing parameters with recursively sorted object keys before SHA-256 hashing. This means `{ city: 'Sofia', units: 'metric' }` and `{ units: 'metric', city: 'Sofia' }` produce the same cache key.

### Tool cache

Caches tool/function call results by tool name and argument hash.

**Key format:** `{name}:tool:{toolName}:{sha256_hash}`

**TTL precedence:** per-call `ttl` > tool policy > `tierDefaults.tool.ttl` > `defaultTtl`

```typescript
// Check for cached result
const result = await cache.tool.check('get_weather', { city: 'Sofia' });

// Store a result with API cost tracking
await cache.tool.store('get_weather', { city: 'Sofia' }, jsonResult, {
  ttl: 300,
  cost: 0.001,
});

// Set a persistent per-tool TTL policy
await cache.tool.setPolicy('get_weather', { ttl: 600 });

// Invalidate all results for a tool
const deleted = await cache.tool.invalidateByTool('get_weather');

// Invalidate a specific tool+args combination
const existed = await cache.tool.invalidate('get_weather', { city: 'Sofia' });
```

### Session store

Key-value storage for agent session state with sliding window TTL. Fields are stored as individual Valkey keys (not Redis HASHes), enabling per-field TTL.

**Key format:** `{name}:session:{threadId}:{field}`

**TTL behavior:** `get()` refreshes TTL on hit (sliding window). `set()` sets TTL. `touch()` refreshes TTL on all fields.

```typescript
// Get/set individual fields
await cache.session.set('thread-1', 'last_intent', 'book_flight');
const intent = await cache.session.get('thread-1', 'last_intent');

// Get all fields for a thread
const all = await cache.session.getAll('thread-1');

// Delete a field
await cache.session.delete('thread-1', 'last_intent');

// Destroy entire thread (including LangGraph checkpoints)
const deleted = await cache.session.destroyThread('thread-1');

// Refresh TTL on all fields
await cache.session.touch('thread-1');
```

## Stats and self-optimization

### stats()

Returns aggregate statistics for all tiers:

```typescript
const stats = await cache.stats();
// {
//   llm: { hits: 150, misses: 50, total: 200, hitRate: 0.75 },
//   tool: { hits: 300, misses: 100, total: 400, hitRate: 0.75 },
//   session: { reads: 1000, writes: 500 },
//   costSavedMicros: 12500000, // $12.50 in microdollars
//   perTool: {
//     get_weather: { hits: 200, misses: 50, hitRate: 0.8, ttl: 300 },
//   }
// }
```

### toolEffectiveness()

Returns per-tool effectiveness rankings with TTL recommendations:

```typescript
const effectiveness = await cache.toolEffectiveness();
// [
//   { tool: 'get_weather', hitRate: 0.85, costSaved: 5.00, recommendation: 'increase_ttl' },
//   { tool: 'search', hitRate: 0.6, costSaved: 2.50, recommendation: 'optimal' },
//   { tool: 'rare_api', hitRate: 0.1, costSaved: 0.10, recommendation: 'decrease_ttl_or_disable' },
// ]
```

| Recommendation | Criteria |
|---|---|
| `increase_ttl` | Hit rate > 80% and current TTL < 1 hour |
| `optimal` | Hit rate 40–80% |
| `decrease_ttl_or_disable` | Hit rate < 40% |

## Framework adapters

Three optional adapters are available as subpath exports. They do not add framework dependencies to the base package — only install the adapter's peer dependency if you use it.

### LangChain

Import from `@betterdb/agent-cache/langchain`. Requires `@langchain/core` >= 0.3.0 as a peer dependency.

```typescript
import { ChatOpenAI } from '@langchain/openai';
import { BetterDBLlmCache } from '@betterdb/agent-cache/langchain';

const model = new ChatOpenAI({
  model: 'gpt-4o',
  cache: new BetterDBLlmCache({ cache }),
});
```

The adapter implements LangChain's `BaseCache` interface.

### Vercel AI SDK

Import from `@betterdb/agent-cache/ai`. Requires `ai` ^6.0.135 as a peer dependency.

```typescript
import { wrapLanguageModel } from 'ai';
import { openai } from '@ai-sdk/openai';
import { createAgentCacheMiddleware } from '@betterdb/agent-cache/ai';

const model = wrapLanguageModel({
  model: openai('gpt-4o'),
  middleware: createAgentCacheMiddleware({ cache }),
});
```

The middleware intercepts non-streaming `doGenerate` calls. On a cache hit, the model is not called and the response includes `providerMetadata: { agentCache: { hit: true } }` so consumers can distinguish cached responses from real zero-token calls. Responses containing tool-call parts are not cached to avoid breaking tool-calling workflows.

### LangGraph

Import from `@betterdb/agent-cache/langgraph`. Requires `@langchain/langgraph-checkpoint` >= 0.1.0 as a peer dependency.

Works on vanilla Valkey 7+ with no modules. Unlike `langgraph-checkpoint-redis`, this does not require Redis 8.0+, RedisJSON, or RediSearch.

```typescript
import { StateGraph } from '@langchain/langgraph';
import { BetterDBSaver } from '@betterdb/agent-cache/langgraph';

const checkpointer = new BetterDBSaver({ cache });

const graph = new StateGraph({ channels: schema })
  .addNode('agent', agentNode)
  .compile({ checkpointer });
```

The saver implements the full LangGraph checkpoint protocol including `pendingWrites` reconstruction, supporting interrupt/resume workflows, human-in-the-loop patterns, and parallel node execution.

**Storage layout:**

| Key pattern | Contents |
|---|---|
| `{name}:session:{thread_id}:checkpoint:{id}` | JSON-serialized `CheckpointTuple` |
| `{name}:session:{thread_id}:checkpoint:latest` | Pointer to the most recent checkpoint |
| `{name}:session:{thread_id}:writes:{checkpoint_id}\|{task_id}\|{channel}\|{idx}` | JSON-serialized pending write value |

## Observability

### OpenTelemetry

Every public method emits a span via the `@opentelemetry/api` tracer. Spans require an OpenTelemetry SDK to be configured in the host application — this package does not bundle an SDK.

| Span name | Key attributes |
|-----------|----------------|
| `agent_cache.llm.check` | `cache.key`, `cache.model`, `cache.hit` |
| `agent_cache.llm.store` | `cache.key`, `cache.model`, `cache.ttl`, `cache.bytes` |
| `agent_cache.llm.invalidateByModel` | `cache.model`, `cache.deleted_count` |
| `agent_cache.tool.check` | `cache.key`, `cache.tool_name`, `cache.hit` |
| `agent_cache.tool.store` | `cache.key`, `cache.tool_name`, `cache.ttl`, `cache.bytes` |
| `agent_cache.tool.invalidateByTool` | `cache.tool_name`, `cache.deleted_count` |
| `agent_cache.session.get` | `cache.key`, `cache.thread_id`, `cache.field`, `cache.hit` |
| `agent_cache.session.set` | `cache.key`, `cache.thread_id`, `cache.field`, `cache.ttl`, `cache.bytes` |
| `agent_cache.session.getAll` | `cache.thread_id`, `cache.field_count` |
| `agent_cache.session.destroyThread` | `cache.thread_id`, `cache.deleted_count` |
| `agent_cache.session.touch` | `cache.thread_id`, `cache.touched_count` |

### Prometheus

All metric names are prefixed with the configured `telemetry.metricsPrefix` (default: `agent_cache`).

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `{prefix}_requests_total` | Counter | `cache_name`, `tier`, `result`, `tool_name` | Total cache requests. `result` is `hit` or `miss` |
| `{prefix}_operation_duration_seconds` | Histogram | `cache_name`, `tier`, `operation` | Duration of cache operations in seconds |
| `{prefix}_cost_saved_total` | Counter | `cache_name`, `tier`, `model`, `tool_name` | Estimated cost saved in dollars from cache hits |
| `{prefix}_stored_bytes_total` | Counter | `cache_name`, `tier` | Total bytes stored in cache |
| `{prefix}_active_sessions` | Gauge | `cache_name` | Approximate number of active session threads |

## BetterDB Monitor integration

Connect [BetterDB Monitor](https://betterdb.com) to the same Valkey instance and it will automatically detect the agent cache stats hash (`{name}:__stats`) and surface hit rates, cost savings, and per-tool effectiveness in the dashboard. No additional configuration is required.

## Design tradeoffs

### Individual keys vs Redis hashes for session state

Session fields are stored as individual Valkey keys, not as fields inside a single Redis HASH per thread. This allows per-field TTL and atomic operations on individual fields. The trade-off is that `getAll()` and `destroyThread()` require a SCAN + pipeline instead of a single `HGETALL` or `DEL`. For typical agent sessions with dozens of fields, this is negligible. For sessions with thousands of fields, a HASH-based approach would be faster for bulk reads.

### Plain JSON strings vs RedisJSON for LangGraph checkpoints

The LangGraph adapter stores checkpoints as plain JSON strings via `SET`/`GET`, not via RedisJSON path operations. This is what makes the adapter work on vanilla Valkey 7+ and every managed service without module configuration. The trade-off is that `list()` with filtering requires SCAN + parse instead of indexed queries. For typical checkpoint volumes (hundreds to low thousands per thread), this is fast enough. `langgraph-checkpoint-redis` uses RedisJSON + RediSearch for O(1) indexed lookups — if you have millions of checkpoints per thread, use that instead.

### Counter-based stats vs event streams

Cache statistics are stored as atomic counters in a single Valkey hash (`HINCRBY`), not as event streams. BetterDB Monitor computes rates by diffing counter values over time windows. The trade-off is no per-request event detail — you get aggregate hit rates and cost savings, not a log of every cache operation. Event streams are planned for a future release.

### Approximate active session tracking

The `active_sessions` Prometheus gauge is approximate — it tracks threads seen via an in-memory LRU (bounded at 10k entries), incremented on first write, decremented on `destroyThread()`. It does not survive process restarts and may drift if threads expire via TTL without an explicit destroy. For accurate session counts, query Valkey directly with `SCAN`.

### Cluster mode

Cluster support works by running SCAN on each master node sequentially and merging results. When an iovalkey `Cluster` client is passed, `destroyThread()`, `invalidateByModel()`, `invalidateByTool()`, `flush()`, `getAll()`, `touch()`, and `scanFieldsByPrefix()` automatically iterate all master nodes. The trade-off is N sequential SCAN loops (one per master) instead of 1. For typical deployments with 3–6 masters, this is negligible — the operations were already O(n) over all keys. No API or configuration changes are needed; pass a `Cluster` instance and everything works correctly.

## Known limitations

### Streaming

Streaming LLM responses are not cached by the Vercel AI SDK adapter. Accumulate the full response before caching. The cached response is always returned as a complete string, not re-streamed token-by-token.

### LangGraph list() memory usage

The `list()` method loads all checkpoint data for a thread into memory before filtering and applying the limit. For typical agent deployments with hundreds of checkpoints per thread, this is acceptable. The `limit: 1` fast path short-circuits by reading `checkpoint:latest` directly. For threads with thousands of large checkpoints, consider using `langgraph-checkpoint-redis` with Redis 8+ instead.

### Self-healing corrupt entries

Corrupt (unparseable JSON) cache entries in the LLM and tool tiers are deleted on first detection and treated as misses. This prevents repeated re-fetching of bad data until TTL expiry.
