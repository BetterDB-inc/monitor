# @betterdb/semantic-cache

A standalone, framework-agnostic semantic cache for LLM applications backed by [Valkey](https://valkey.io/) (or Redis). Uses Valkey's vector search (`valkey-search` module) for similarity matching with built-in [OpenTelemetry](https://opentelemetry.io/) tracing and [Prometheus](https://prometheus.io/) metrics via `prom-client`. The first semantic cache library designed to work natively with Valkey and BetterDB Monitor.

## Prerequisites

- **Valkey 8.0+** with the `valkey-search` module loaded
- Or **Amazon ElastiCache for Valkey** (8.0+)
- Or **Google Cloud Memorystore for Valkey**
- Node.js >= 20.0.0

## Installation

```bash
npm install @betterdb/semantic-cache
```

You must also have `iovalkey` installed (it is a peer dependency):

```bash
npm install iovalkey
```

## Why @betterdb/semantic-cache

As of 2026, no existing semantic cache library simultaneously satisfies all three of the following properties: **Valkey-native** support (explicitly handling `valkey-search` API differences rather than assuming Redis wire compatibility), **standalone** operation (no coupling to LangChain, LiteLLM, AWS, or any other orchestration layer), and **built-in observability** (OpenTelemetry spans and Prometheus metrics emitted at the cache operation level, not just at the HTTP or LLM call level). This package was built to fill that gap.

| Library / Service | Valkey-native | Standalone | Built-in OTel + Prometheus |
|---|---|---|---|
| **@betterdb/semantic-cache** | ✅ | ✅ | ✅ |
| RedisVL `SemanticCache` | ❌ Redis only | ✅ | ❌ |
| LangChain `RedisSemanticCache` | ❌ Redis only | ❌ Requires LangChain | ❌ |
| LiteLLM `redis-semantic` | ❌ Redis only | ❌ Requires LiteLLM | ❌ Partial (no cache metrics) |
| `langgraph-checkpoint-aws` `ValkeyCache` | ✅ | ❌ Requires AWS + LangGraph | ❌ |
| Mem0 + Valkey | ✅ | ❌ Full memory framework | ❌ |
| Redis LangCache | ❌ Redis Cloud only | ❌ Managed service | ✅ Dashboard only |
| Upstash `semantic-cache` | ❌ Upstash Vector only | ✅ | ❌ |
| GPTCache | ❌ Abandoned (2023) | ✅ | ❌ |

- **Valkey-native**: `valkey-search` has API differences from Redis's RediSearch that require explicit handling (see [Valkey Search 1.2 compatibility notes](#valkey-search-12-compatibility-notes) in the changelog). Libraries targeting Redis are not guaranteed to work correctly against self-hosted Valkey or managed Valkey services (ElastiCache, Memorystore).
- **Standalone**: no dependency on a specific AI framework means you can use this with any LLM client — OpenAI SDK, Anthropic SDK, a local model, or a custom inference endpoint — and swap it out without changing your cache layer.
- **Built-in OTel + Prometheus**: every `check()` and `store()` call emits a span and increments counters. You get hit rate, similarity score distribution, and latency percentiles in Grafana or any OTel-compatible backend without writing any instrumentation code. If you use [BetterDB Monitor](https://betterdb.com), these metrics are surfaced automatically alongside your other Valkey observability data.

## Quick Start

```typescript
import Valkey from 'iovalkey';
import { SemanticCache } from '@betterdb/semantic-cache';

const client = new Valkey({ host: 'localhost', port: 6399 });

const cache = new SemanticCache({
  client,
  embedFn: async (text) => {
    // Any embedding provider works — OpenAI, Voyage AI, Cohere, a local model, etc.
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.VOYAGE_API_KEY}` },
      body: JSON.stringify({ model: 'voyage-3-lite', input: [text] }),
    });
    const json = await res.json();
    return json.data[0].embedding;
  },
});

await cache.initialize();

// Store a response
await cache.store('What is the capital of France?', 'Paris');

// Check for a semantically similar prompt
const result = await cache.check('Capital city of France?');
// result.hit === true, result.response === 'Paris'
```

## Client Lifecycle

SemanticCache does **not** own the iovalkey client. You create it, you close it:

```typescript
const client = new Valkey({ host: 'localhost', port: 6399 });
const cache = new SemanticCache({ client, embedFn });

// ... use cache ...

// When shutting down, close the client yourself:
await client.quit();
```

## Threshold: Cosine Distance vs Cosine Similarity

This library uses **cosine distance** (0–2 scale), not cosine similarity (0–1 scale):

| Distance | Meaning |
|----------|---------|
| 0 | Identical vectors |
| 1 | Orthogonal (unrelated) |
| 2 | Opposite vectors |

A cache lookup is a **hit** when `score <= threshold`. The default threshold of `0.1` is strict — it matches only very similar prompts. Increase to `0.15–0.2` for broader matching.

The relationship is: `distance = 1 - similarity`. A cosine similarity of 0.95 corresponds to a distance of 0.05.

### Handling uncertain hits

When `confidence` is `'uncertain'`, the cached response is technically above
the similarity threshold but close to the boundary. Three common patterns:

**Accept and monitor** — return the cached response but track uncertain hits
separately via the `result: 'uncertain_hit'` Prometheus label. Review them
periodically to decide if the threshold needs adjustment.

**Fall back to LLM** — treat uncertain hits as misses, call the LLM, then
update the cache entry with `store()` using the fresh response.

**Prompt for feedback** — in user-facing applications, show the cached
response but collect a thumbs up/down signal to identify false positives.

A high rate of uncertain hits (visible in the `{prefix}_requests_total`
metric) indicates the threshold may be too loose for the query distribution.

## Configuration Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | `string` | `'betterdb_scache'` | Index name prefix for Valkey keys |
| `client` | `Valkey` | — | iovalkey client instance (required) |
| `embedFn` | `(text: string) => Promise<number[]>` | — | Embedding function (required) |
| `defaultThreshold` | `number` | `0.1` | Cosine distance threshold (0–2) |
| `defaultTtl` | `number` | `undefined` | Default TTL in seconds for entries |
| `categoryThresholds` | `Record<string, number>` | `{}` | Per-category threshold overrides |
| `uncertaintyBand` | `number` | `0.05` | Width of the uncertainty band below threshold |
| `telemetry.tracerName` | `string` | `'@betterdb/semantic-cache'` | OpenTelemetry tracer name |
| `telemetry.metricsPrefix` | `string` | `'semantic_cache'` | Prometheus metric name prefix |
| `telemetry.registry` | `Registry` | default registry | prom-client Registry for metrics |

## Observability

### Prometheus Metrics

All metric names are prefixed with `semantic_cache_` by default (configurable via `telemetry.metricsPrefix`).

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `semantic_cache_requests_total` | Counter | `cache_name`, `result`, `category` | Total cache requests. `result` is `hit`, `miss`, or `uncertain_hit` |
| `semantic_cache_similarity_score` | Histogram | `cache_name`, `category` | Cosine distance scores for lookups with candidates |
| `semantic_cache_operation_duration_seconds` | Histogram | `cache_name`, `operation` | Duration of cache operations (`check`, `store`, `invalidate`, `initialize`) |
| `semantic_cache_embedding_duration_seconds` | Histogram | `cache_name` | Duration of embedding function calls |

### OpenTelemetry Tracing

Every public method emits an OTel span with relevant attributes (`cache.hit`, `cache.similarity`, `cache.threshold`, `cache.confidence`, etc.). Spans require an OpenTelemetry SDK to be configured in the host application — this library uses `@opentelemetry/api` and does not bundle an SDK.

## BetterDB Monitor Integration

If you connect [BetterDB Monitor](https://github.com/KIvanow/monitor) to the same Valkey instance, it will automatically detect the semantic cache index and surface:

- Hit rate and miss rate over time
- Similarity score distribution
- Cache entry count and memory usage
- Cost savings estimates based on cache hit rates

## API

### `cache.initialize()`

Creates or reconnects to the Valkey search index. Must be called before `check()` or `store()`. Safe to call multiple times.

### `cache.check(prompt, options?)`

Searches for a semantically similar cached prompt. Returns `{ hit, response, similarity, confidence, matchedKey, nearestMiss }`.

### `cache.store(prompt, response, options?)`

Stores a prompt/response pair with its embedding vector. Returns the Valkey key.

### `cache.invalidate(filter)`

Deletes entries matching a valkey-search filter expression. Example: `cache.invalidate('@model:{gpt-4o}')`.

### `cache.stats()`

Returns `{ hits, misses, total, hitRate }` from the Valkey stats hash.

### `cache.indexInfo()`

Returns index metadata: `{ name, numDocs, dimension, indexingState }`.

### `cache.flush()`

Drops the index and all entries. Call `initialize()` again to rebuild.

## Known limitations

### Cluster mode

`@betterdb/semantic-cache` works with single-node Valkey instances and managed
single-endpoint services (Amazon ElastiCache for Valkey, Google Cloud Memorystore
for Valkey). It does not fully support Valkey in cluster mode.

The specific issue is `flush()`: it uses `SCAN` to find and delete entry keys,
but `SCAN` in cluster mode only iterates keys on the node it is sent to. In a
multi-node cluster, `flush()` will silently leave entry keys on other nodes
(the FT index itself is dropped correctly).

`check()`, `store()`, `invalidate()`, and `stats()` are unaffected — these use
`FT.SEARCH`, `HSET`, `DEL`, and `HINCRBY` which route correctly in cluster mode
via the key hash slot.

If you need cluster support, either avoid `flush()` or implement a cluster-aware
key sweep using the iovalkey cluster client's per-node scan capability.
Cluster mode support is planned for a future release.

### Streaming

Streaming LLM responses are not supported. `store()` expects a complete response
string. If your application uses streaming, accumulate the full response before
calling `store()`. The cached response is always returned as a complete string,
not re-streamed token-by-token.

## License

MIT
