---
layout: default
title: Semantic Cache
parent: Packages
nav_order: 1
---

# Semantic Cache

`@betterdb/semantic-cache` is a standalone, framework-agnostic semantic cache library for LLM applications backed by Valkey. It uses the `valkey-search` module's vector similarity search to match incoming prompts against previously cached responses, returning hits when the cosine distance falls below a configurable threshold. Every cache operation emits an OpenTelemetry span and updates Prometheus metrics, giving teams running Valkey full production observability over their cache layer without additional instrumentation.

## Prerequisites

- **Valkey 8.0+** with the `valkey-search` module loaded (self-hosted via the `valkey/valkey-bundle` Docker image)
- Or **Amazon ElastiCache for Valkey** (8.0+)
- Or **Google Cloud Memorystore for Valkey**
- Node.js >= 20

## Installation

```bash
npm install @betterdb/semantic-cache iovalkey
```

`iovalkey` is a peer dependency — you must install it alongside the package.

## Quick start

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
  defaultThreshold: 0.1,
  defaultTtl: 3600,
});

await cache.initialize();

// Store a response
await cache.store('What is the capital of France?', 'Paris', {
  category: 'geography',
  model: 'gpt-4o',
});

// Check for a semantically similar prompt
const result = await cache.check('Capital city of France?');
console.log(result.hit);        // true
console.log(result.response);   // 'Paris'
console.log(result.confidence); // 'high'
console.log(result.similarity); // ~0.02 (cosine distance)
```

The `embedFn` parameter is caller-supplied — any embedding provider works (OpenAI, Cohere, a local model via Ollama, or a custom inference endpoint).

## Configuration reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | `string` | `'betterdb_scache'` | Index name prefix used for all Valkey keys (`{name}:idx`, `{name}:entry:*`, `{name}:__stats`) |
| `client` | `Valkey` | *required* | An `iovalkey` client instance. The caller owns the connection lifecycle |
| `embedFn` | `(text: string) => Promise<number[]>` | *required* | Async function returning a float embedding vector for a text string |
| `defaultThreshold` | `number` | `0.1` | Cosine distance threshold (0–2). A lookup is a hit when `score <= threshold` |
| `defaultTtl` | `number` | `undefined` | Default TTL in seconds for stored entries. `undefined` means no expiry |
| `categoryThresholds` | `Record<string, number>` | `{}` | Per-category threshold overrides. Applied when `CacheCheckOptions.category` matches a key |
| `uncertaintyBand` | `number` | `0.05` | Width of the uncertainty band below the threshold. Hits within `[threshold - band, threshold]` are flagged `confidence: 'uncertain'` |
| `telemetry.tracerName` | `string` | `'@betterdb/semantic-cache'` | OpenTelemetry tracer name |
| `telemetry.metricsPrefix` | `string` | `'semantic_cache'` | Prefix for all Prometheus metric names |
| `telemetry.registry` | `Registry` | prom-client default | prom-client `Registry` to register metrics on. Pass a custom `Registry` in library or multi-tenant contexts to avoid polluting the host application's default registry |

## Threshold tuning

This library uses **cosine distance** (0–2 scale), not cosine similarity (0–1). The relationship is `distance = 1 - similarity`. Lower distance means more similar:

| Distance | Meaning |
|----------|---------|
| 0 | Identical vectors |
| 1 | Orthogonal (unrelated) |
| 2 | Opposite vectors |

A cache lookup is a **hit** when the nearest neighbour's cosine distance is `<= threshold`. Choose your threshold based on the precision/recall trade-off:

| `defaultThreshold` | Behaviour |
|---|---|
| `0.05` | Very strict — only near-identical phrasings hit |
| `0.10` | Default — balanced precision/recall |
| `0.15` | Looser — catches more paraphrases, higher false-positive risk |
| `0.20+` | Very loose — use per-category overrides instead |

### Uncertainty band

When a hit's cosine distance falls within `[threshold - uncertaintyBand, threshold]`, the result is flagged `confidence: 'uncertain'` rather than `'high'`. This lets you handle borderline matches differently in your application — for example, by serving the cached response but also triggering a background refresh.

### Per-category thresholds

For mixed workloads, use `categoryThresholds` to set different thresholds per query category rather than loosening the global default:

```typescript
const cache = new SemanticCache({
  client,
  embedFn,
  defaultThreshold: 0.10,
  categoryThresholds: {
    faq: 0.08,    // strict — FAQs have canonical phrasings
    search: 0.15, // looser — search queries vary more
  },
});
```

Pass `{ category: 'faq' }` in `check()` and `store()` options to activate the override.

## Observability

### OpenTelemetry

Every public method emits a span via the `@opentelemetry/api` tracer. Spans require an OpenTelemetry SDK to be configured in the host application — this package does not bundle an SDK.

| Span name | Key attributes |
|-----------|----------------|
| `semantic_cache.initialize` | `cache.name` |
| `semantic_cache.check` | `cache.hit`, `cache.similarity`, `cache.threshold`, `cache.confidence`, `cache.category`, `cache.matched_key`, `embedding_latency_ms`, `search_latency_ms` |
| `semantic_cache.store` | `cache.name`, `cache.key`, `cache.ttl`, `cache.category`, `cache.model`, `embedding_latency_ms` |
| `semantic_cache.invalidate` | `cache.name`, `cache.filter`, `cache.deleted_count` |

### Prometheus

All metric names are prefixed with the configured `telemetry.metricsPrefix` (default: `semantic_cache`).

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `{prefix}_requests_total` | Counter | `cache_name`, `result`, `category` | Total cache lookups. `result` is `hit`, `miss`, or `uncertain_hit` |
| `{prefix}_similarity_score` | Histogram | `cache_name`, `category` | Cosine distance of the nearest neighbour (0–2). Recorded on hit and near-miss |
| `{prefix}_operation_duration_seconds` | Histogram | `cache_name`, `operation` | End-to-end duration per operation (`check`, `store`, `invalidate`, `initialize`) |
| `{prefix}_embedding_duration_seconds` | Histogram | `cache_name` | Time spent in the caller-supplied `embedFn` |

If you use [BetterDB Monitor](https://betterdb.com), connect it to the same Valkey instance and it will automatically detect the cache index and surface these metrics alongside your other Valkey observability data.

## BetterDB Monitor integration

BetterDB Monitor polls the `{name}:__stats` Valkey hash written by this package on every `check()` call and surfaces hit rate, similarity score distribution, and cache growth rate in the dashboard. Connect Monitor to the same Valkey instance used by the cache — no additional configuration is required. See [betterdb.com](https://betterdb.com) for details.

## Framework adapters

Two optional adapters are available as subpath exports. They do not add framework dependencies to the base package — only install the adapter's peer dependency if you use it.

### LangChain

Import from `@betterdb/semantic-cache/langchain`. Requires `@langchain/core` >= 0.3.0 as a peer dependency.

```typescript
import { ChatOpenAI } from '@langchain/openai';
import { BetterDBSemanticCache } from '@betterdb/semantic-cache/langchain';

const llm = new ChatOpenAI({
  modelName: 'gpt-4o',
  cache: new BetterDBSemanticCache({ cache }), // pass your SemanticCache instance
});
```

The adapter implements LangChain's `BaseCache` interface. Set `filterByModel: true` to scope cache lookups by the LLM configuration string.

### Vercel AI SDK

Import from `@betterdb/semantic-cache/ai`. Requires `ai` >= 4.0.0 as a peer dependency.

```typescript
import { wrapLanguageModel } from 'ai';
import { openai } from '@ai-sdk/openai';
import { createSemanticCacheMiddleware } from '@betterdb/semantic-cache/ai';

const model = wrapLanguageModel({
  model: openai('gpt-4o'),
  middleware: createSemanticCacheMiddleware({ cache }),
});
```

The middleware intercepts `doGenerate` calls. On a cache hit, the model is not called. Streaming (`wrapStream`) is not supported in v0.1.

## Valkey Search 1.2 compatibility notes

The following divergences from Redis/RediSearch were discovered during live verification and are handled in the implementation:

1. **`FT.INFO` error message** — Valkey Search 1.2 returns `"Index with name '...' not found in database 0"` rather than `"Unknown Index name"` (Redis/RediSearch convention) or `"no such index"`. The code matches all three patterns for cross-compatibility.
2. **`FT.DROPINDEX DD`** — The `DD` (Delete Documents) flag is not supported in Valkey Search 1.2. Key cleanup is done separately via `SCAN` + `DEL` after dropping the index.
3. **`FT.SEARCH` KNN score aliases** — KNN score aliases (`__score`) cannot be used in `RETURN` or `SORTBY` clauses. Results are returned automatically (without a `RETURN` clause) and pre-sorted by distance.
4. **`FT.INFO` dimension parsing** — The vector field dimension is nested inside an `"index"` sub-array (as `"dimensions"`) rather than exposed at the top-level `DIM` key used by RediSearch.

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

## API reference

### `cache.initialize(): Promise<void>`

Creates or reconnects to the Valkey search index. If the index already exists, reads the vector dimension from `FT.INFO` and marks the instance as initialized. If the index does not exist, calls `embedFn('probe')` to determine the embedding dimension, then creates the index via `FT.CREATE`.

Must be called before `check()` or `store()`. Safe to call multiple times.

**Throws:** `EmbeddingError` if `embedFn('probe')` fails, `ValkeyCommandError` if `FT.CREATE` or `FT.INFO` fails for a reason other than a missing index.

### `cache.check(prompt: string, options?: CacheCheckOptions): Promise<CacheCheckResult>`

Searches the cache for a semantically similar prompt using KNN vector search. Returns a `CacheCheckResult`:

| Field | Type | Description |
|-------|------|-------------|
| `hit` | `boolean` | Whether the nearest neighbour's cosine distance was `<= threshold` |
| `response` | `string \| undefined` | The cached response text. Present on hit |
| `similarity` | `number \| undefined` | Cosine distance (0–2). Present when a nearest neighbour was found |
| `confidence` | `'high' \| 'uncertain' \| 'miss'` | `'uncertain'` if the hit falls within the uncertainty band |
| `matchedKey` | `string \| undefined` | The Valkey key of the matched entry. Present on hit |
| `nearestMiss` | `{ similarity, deltaToThreshold } \| undefined` | Present on miss when a candidate existed but didn't clear the threshold |

**Options** (`CacheCheckOptions`):

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `threshold` | `number` | — | Per-request threshold override (highest priority) |
| `category` | `string` | — | Category tag for per-category threshold lookup and metric labels |
| `filter` | `string` | — | Additional `valkey-search` pre-filter expression (e.g. `'@model:{gpt-4o}'`) |
| `k` | `number` | `1` | Number of nearest neighbours to fetch before threshold check |

On a hit, refreshes the entry's TTL if `defaultTtl` is configured (sliding window).

**Throws:** `SemanticCacheUsageError` if `initialize()` was not called, `EmbeddingError` if `embedFn` fails, `ValkeyCommandError` if `FT.SEARCH` fails.

### `cache.store(prompt: string, response: string, options?: CacheStoreOptions): Promise<string>`

Stores a prompt/response pair with its embedding vector. Returns the Valkey key of the stored entry (format: `{name}:entry:{uuid}`).

**Options** (`CacheStoreOptions`):

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `ttl` | `number` | `defaultTtl` | Per-entry TTL in seconds |
| `category` | `string` | `''` | Category tag |
| `model` | `string` | `''` | Model name tag (e.g. `'gpt-4o'`) |
| `metadata` | `Record<string, string \| number>` | `{}` | Arbitrary metadata stored as JSON |

**Throws:** `SemanticCacheUsageError` if `initialize()` was not called, `EmbeddingError` if `embedFn` fails, `SemanticCacheUsageError` if the embedding dimension doesn't match the index (usually means the embedding model changed — call `flush()` then `initialize()` to rebuild), `ValkeyCommandError` if `HSET` fails.

### `cache.invalidate(filter: string): Promise<InvalidateResult>`

Deletes all entries matching a `valkey-search` filter expression. Fetches up to 1000 matching keys via `FT.SEARCH`, then deletes them in a single `DEL` call. Returns `{ deleted: number, truncated: boolean }`. If `truncated` is true, call again with the same filter until it returns false.

```typescript
const { deleted, truncated } = await cache.invalidate('@model:{gpt-4o}');
```

**Throws:** `SemanticCacheUsageError` if `initialize()` was not called, `ValkeyCommandError` if `FT.SEARCH` or `DEL` fails.

### `cache.stats(): Promise<CacheStats>`

Returns cumulative hit/miss statistics from the `{name}:__stats` Valkey hash:

```typescript
interface CacheStats {
  hits: number;
  misses: number;
  total: number;
  hitRate: number; // hits / total, or 0 if total is 0
}
```

### `cache.indexInfo(): Promise<IndexInfo>`

Returns index metadata parsed from `FT.INFO`:

```typescript
interface IndexInfo {
  name: string;        // e.g. 'betterdb_scache:idx'
  numDocs: number;     // number of indexed entries
  dimension: number;   // embedding vector dimension
  indexingState: string; // e.g. 'ready' or 'unknown'
}
```

**Throws:** `ValkeyCommandError` if `FT.INFO` fails.

### `cache.flush(): Promise<void>`

Drops the FT index via `FT.DROPINDEX` and deletes all entry keys and the stats hash via `SCAN` + `DEL`. Resets the instance to uninitialized — call `initialize()` again to rebuild.

The caller owns the `iovalkey` client lifecycle — call `client.quit()` or `client.disconnect()` yourself when the application shuts down.
