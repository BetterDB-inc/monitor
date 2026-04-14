# @betterdb/agent-cache

A standalone, framework-agnostic, multi-tier exact-match cache for AI agent workloads backed by [Valkey](https://valkey.io/) (or Redis). Three cache tiers behind one connection: LLM responses, tool results, and session state. Built-in [OpenTelemetry](https://opentelemetry.io/) tracing and [Prometheus](https://prometheus.io/) metrics via `prom-client`. No modules required - works on vanilla Valkey 7+, ElastiCache, Memorystore, MemoryDB, and any Redis-compatible endpoint.

## Prerequisites

- **Valkey 7+** or Redis 6.2+ (no modules, no RediSearch, no RedisJSON)
- Or **Amazon ElastiCache for Valkey / Redis**
- Or **Google Cloud Memorystore for Valkey**
- Or **Amazon MemoryDB**
- Node.js >= 20

## Installation

```bash
npm install @betterdb/agent-cache
```

You must also have `iovalkey` installed (it is a peer dependency):

```bash
npm install iovalkey
```

## Why @betterdb/agent-cache

As of 2026, no existing caching solution for AI agents provides all three of the following: **multi-tier caching** (LLM responses, tool results, and session state in one package), **built-in observability** (OpenTelemetry spans and Prometheus metrics at the cache operation level), and **no module requirements** (works on vanilla Valkey without RedisJSON or RediSearch). This package fills that gap.

| Solution | Multi-tier (LLM + Tool + State) | Built-in OTel + Prometheus | No modules required | Framework adapters |
|----------|--------------------------------|---------------------------|--------------------|--------------------|
| **@betterdb/agent-cache** | ✅ | ✅ | ✅ | ✅ LangChain, LangGraph, Vercel AI |
| LangChain RedisCache | ❌ LLM only | ❌ | ✅ | ❌ LangChain only |
| LangGraph checkpoint-redis | ❌ State only | ❌ | ❌ Requires Redis 8 + modules | ❌ LangGraph only |
| AutoGen RedisStore | ❌ LLM only | ❌ | ✅ | ❌ AutoGen only |
| LiteLLM Redis | ❌ LLM only | ⚠️ Partial (hit/miss only) | ✅ | ❌ LiteLLM proxy only |
| Upstash + Vercel AI SDK | ❌ LLM only (manual) | ❌ | ❌ Upstash only | ❌ Vercel AI only |

## Design tradeoffs

### Individual keys vs Redis hashes for session state

Session fields are stored as individual Valkey keys (`{name}:session:{threadId}:{field}`), not as fields inside a single Redis HASH per thread. This allows per-field TTL and atomic operations on individual fields, which matters when different parts of agent state have different freshness requirements. The trade-off is that `getAll()` and `destroyThread()` require a SCAN + pipeline instead of a single `HGETALL` or `DEL`. For typical agent sessions with dozens of fields, this is negligible. For sessions with thousands of fields, a HASH-based approach would be faster for bulk reads.

### Plain JSON strings vs RedisJSON for LangGraph checkpoints

The LangGraph adapter stores checkpoints as plain JSON strings via `SET`/`GET`, not via RedisJSON path operations. This is the decision that makes the adapter work on vanilla Valkey 7+ and every managed service without module configuration. The trade-off is that `list()` with filtering requires SCAN + parse instead of indexed queries. For typical checkpoint volumes (hundreds to low thousands per thread), this is fast enough. `langgraph-checkpoint-redis` uses RedisJSON + RediSearch for O(1) indexed lookups - if you have millions of checkpoints per thread and need filtered listing performance, use that instead. Most agent deployments don't.

### Counter-based stats vs event streams

Cache statistics are stored as atomic counters in a single Valkey hash (`HINCRBY`), not as event streams. This means BetterDB Monitor computes rates by diffing counter values over time windows rather than reading individual events. The trade-off is no per-request event detail - you get aggregate hit rates and cost savings, not a log of every cache operation. For v1, counters are sufficient and simpler to operate. Event streams are planned for a future release for teams that need per-request audit trails.

### Sorted-key canonical JSON for cache key hashing

Tool args and LLM params are serialized with recursively sorted object keys before SHA-256 hashing. This means `{ city: 'Sofia', units: 'metric' }` and `{ units: 'metric', city: 'Sofia' }` produce the same cache key. The trade-off is that serialization is slightly slower than a naive `JSON.stringify`. For the sub-millisecond cost of key computation relative to the seconds saved by a cache hit, this is the right default. If you have a use case where arg order is semantically meaningful (rare), hash the args yourself and pass the hash as `args`.

### Approximate active session tracking

The `active_sessions` Prometheus gauge is approximate - it tracks threads seen via an in-memory Set, incremented on first write, decremented on `destroyThread()`. It does not survive process restarts and may drift if threads expire via TTL without an explicit destroy. For accurate session counts, query Valkey directly with `SCAN`. The gauge is useful for dashboards and alerting on trends, not for precise accounting.

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

## Configuration reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `client` | `Valkey` | — | iovalkey client instance (required) |
| `name` | `string` | `'betterdb_ac'` | Key prefix for all Valkey keys |
| `defaultTtl` | `number` | `undefined` | Default TTL in seconds. `undefined` = no expiry |
| `tierDefaults.llm.ttl` | `number` | `undefined` | Default TTL for LLM cache entries |
| `tierDefaults.tool.ttl` | `number` | `undefined` | Default TTL for tool cache entries |
| `tierDefaults.session.ttl` | `number` | `undefined` | Default TTL for session entries |
| `costTable` | `Record<string, ModelCost>` | `undefined` | Model pricing for cost savings tracking |
| `telemetry.tracerName` | `string` | `'@betterdb/agent-cache'` | OpenTelemetry tracer name |
| `telemetry.metricsPrefix` | `string` | `'agent_cache'` | Prometheus metric name prefix |
| `telemetry.registry` | `Registry` | default registry | prom-client Registry for metrics |

### ModelCost format

```typescript
{
  'gpt-4o': { inputPer1k: 0.0025, outputPer1k: 0.01 },
  'gpt-4o-mini': { inputPer1k: 0.00015, outputPer1k: 0.0006 },
}
```

## Cache tiers

### LLM cache

Caches LLM responses by exact match on model, messages, temperature, top_p, max_tokens, and tools.

**Key format:** `{name}:llm:{hash}`

**API:**

```typescript
// Check for cached response
const result = await cache.llm.check({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello' }],
  temperature: 0,
});

// Store a response
await cache.llm.store(params, response, {
  ttl: 3600,
  tokens: { input: 10, output: 50 }, // For cost tracking
});

// Invalidate by model
const deleted = await cache.llm.invalidateByModel('gpt-4o');
```

**TTL precedence:** per-call `ttl` > `tierDefaults.llm.ttl` > `defaultTtl`

### Tool cache

Caches tool/function call results by tool name and argument hash.

**Key format:** `{name}:tool:{toolName}:{hash}`

**API:**

```typescript
// Check for cached result
const result = await cache.tool.check('get_weather', { city: 'Sofia' });

// Store a result
await cache.tool.store('get_weather', { city: 'Sofia' }, jsonResult, {
  ttl: 300,
  cost: 0.001, // API call cost in dollars
});

// Set per-tool TTL policy
await cache.tool.setPolicy('get_weather', { ttl: 600 });

// Invalidate all results for a tool
const deleted = await cache.tool.invalidateByTool('get_weather');

// Invalidate specific call
const existed = await cache.tool.invalidate('get_weather', { city: 'Sofia' });
```

**TTL precedence:** per-call `ttl` > tool policy > `tierDefaults.tool.ttl` > `defaultTtl`

### Session store

Key-value storage for agent session state with sliding window TTL.

**Key format:** `{name}:session:{threadId}:{field}`

**API:**

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

**TTL behavior:** `get()` refreshes TTL on hit (sliding window). `set()` sets TTL. `touch()` refreshes TTL on all fields.

## Stats and self-optimization

### stats()

Returns aggregate statistics for all tiers:

```typescript
const stats = await cache.stats();
// {
//   llm: { hits: 150, misses: 50, total: 200, hitRate: 0.75 },
//   tool: { hits: 300, misses: 100, total: 400, hitRate: 0.75 },
//   session: { reads: 1000, writes: 500 },
//   costSavedCents: 1250,
//   perTool: {
//     get_weather: { hits: 200, misses: 50, hitRate: 0.8, ttl: 300 },
//     search: { hits: 100, misses: 50, hitRate: 0.67, ttl: undefined },
//   }
// }
```

### toolEffectiveness()

Returns per-tool effectiveness rankings with recommendations:

```typescript
const effectiveness = await cache.toolEffectiveness();
// [
//   { tool: 'get_weather', hitRate: 0.85, costSaved: 5.00, recommendation: 'increase_ttl' },
//   { tool: 'search', hitRate: 0.6, costSaved: 2.50, recommendation: 'optimal' },
//   { tool: 'rare_api', hitRate: 0.1, costSaved: 0.10, recommendation: 'decrease_ttl_or_disable' },
// ]
```

**Recommendations:**
- `increase_ttl`: Hit rate > 80% and current TTL < 1 hour. Consider longer caching.
- `optimal`: Hit rate 40-80%. Current configuration is working well.
- `decrease_ttl_or_disable`: Hit rate < 40%. Caching may not be effective for this tool.

## Framework adapters

### LangChain

```typescript
import { ChatOpenAI } from '@langchain/openai';
import { BetterDBLlmCache } from '@betterdb/agent-cache/langchain';

const model = new ChatOpenAI({
  model: 'gpt-4o',
  cache: new BetterDBLlmCache({ cache }),
});
```

### Vercel AI SDK

```typescript
import { wrapLanguageModel } from 'ai';
import { openai } from '@ai-sdk/openai';
import { createAgentCacheMiddleware } from '@betterdb/agent-cache/ai';

const model = wrapLanguageModel({
  model: openai('gpt-4o'),
  middleware: createAgentCacheMiddleware({ cache }),
});
```

Note: Streaming responses are not cached. The middleware only caches non-streaming `generate()` calls.

### LangGraph

Works on vanilla Valkey 7+ with no modules. Unlike `langgraph-checkpoint-redis`, this does not require Redis 8.0+, RedisJSON, or RediSearch.

```typescript
import { StateGraph } from '@langchain/langgraph';
import { BetterDBSaver } from '@betterdb/agent-cache/langgraph';

const checkpointer = new BetterDBSaver({ cache });

const graph = new StateGraph({ channels: schema })
  .addNode('agent', agentNode)
  .compile({ checkpointer });
```

## Prometheus metrics

All metric names are prefixed with `agent_cache_` by default (configurable via `telemetry.metricsPrefix`).

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `agent_cache_requests_total` | Counter | `cache_name`, `tier`, `result`, `tool_name` | Total cache requests. `result` is `hit` or `miss` |
| `agent_cache_operation_duration_seconds` | Histogram | `cache_name`, `tier`, `operation` | Duration of cache operations in seconds |
| `agent_cache_cost_saved_total` | Counter | `cache_name`, `tier`, `model`, `tool_name` | Estimated cost saved in dollars from cache hits |
| `agent_cache_stored_bytes_total` | Counter | `cache_name`, `tier` | Total bytes stored in cache |
| `agent_cache_active_sessions` | Gauge | `cache_name` | Approximate number of active session threads |

## OpenTelemetry tracing

Every public method emits an OTel span. Spans require an OpenTelemetry SDK to be configured in the host application.

| Span name | Attributes |
|-----------|------------|
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

## BetterDB Monitor integration

Connect [BetterDB Monitor](https://github.com/BetterDB-inc/monitor) to the same Valkey instance and it will automatically detect the agent cache stats hash and surface hit rates, cost savings, and per-tool effectiveness in the dashboard.

## Known limitations

- **Streaming responses:** Not cached by the Vercel AI SDK adapter. Accumulate the full response before caching.
- **LangGraph `list()` memory usage:** The `list()` method loads all checkpoint data for a thread into memory before filtering and applying the limit. For typical agent deployments with hundreds of checkpoints per thread, this is acceptable. For threads with thousands of large checkpoints, this causes memory pressure even when requesting `limit: 1`. If you have millions of checkpoints per thread, consider using `langgraph-checkpoint-redis` with Redis 8+ instead.
- **Session `getAll()`:** SCAN-based. Fine for dozens of fields, consider Redis HASH if you have thousands per thread.
- **`active_sessions` gauge:** Approximate and does not survive process restarts.
- **Cluster mode:** SCAN operations in session and tool invalidation only iterate the node they're sent to. Use the iovalkey cluster client's per-node scan for full coverage.

## License

MIT
