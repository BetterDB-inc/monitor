# @betterdb/semantic-cache

A standalone, framework-agnostic semantic cache for LLM applications backed by [Valkey](https://valkey.io/). Uses Valkey's vector search (`valkey-search` module) for similarity matching with built-in [OpenTelemetry](https://opentelemetry.io/) tracing and [Prometheus](https://prometheus.io/) metrics. Full adapter parity with [`@betterdb/agent-cache`](../agent-cache/).

## Prerequisites

- **Valkey 8.0+** with the `valkey-search` module loaded
- Or **Amazon ElastiCache for Valkey** (8.0+)
- Or **Google Cloud Memorystore for Valkey**
- Node.js >= 20.0.0

## Installation

```bash
npm install @betterdb/semantic-cache iovalkey
```

`iovalkey` is a required peer dependency.

## Why @betterdb/semantic-cache

The only semantic cache library that is simultaneously Valkey-native (explicit handling of `valkey-search` API differences), standalone (no coupling to any AI framework), and has built-in OpenTelemetry + Prometheus instrumentation at the cache operation level.

## Quick Start

```typescript
import Valkey from 'iovalkey';
import { SemanticCache } from '@betterdb/semantic-cache';
import { createOpenAIEmbed } from '@betterdb/semantic-cache/embed/openai';

const client = new Valkey({ host: 'localhost', port: 6399 });

const cache = new SemanticCache({
  client,
  embedFn: createOpenAIEmbed(), // or createVoyageEmbed(), createOllamaEmbed(), etc.
  defaultThreshold: 0.1,
  defaultTtl: 3600,
});

await cache.initialize();

// Store with cost tracking
await cache.store('What is the capital of France?', 'Paris', {
  model: 'gpt-4o',
  inputTokens: 20,
  outputTokens: 5,
});

// Semantic check - hits on similar phrasing
const result = await cache.check('Capital city of France?');
// result.hit === true
// result.response === 'Paris'
// result.costSaved === 0.000105
// result.confidence === 'high'
```

## Client Lifecycle

SemanticCache does **not** own the iovalkey client. You create it, you close it:

```typescript
const client = new Valkey({ host: 'localhost', port: 6399 });
const cache = new SemanticCache({ client, embedFn });
// ... use cache ...
await client.quit();
```

## Threshold: Cosine Distance

This library uses **cosine distance** (0-2 scale, lower = more similar):

| Distance | Meaning |
|----------|---------|
| 0 | Identical vectors |
| 1 | Orthogonal (unrelated) |
| 2 | Opposite vectors |

A lookup is a **hit** when `score <= threshold`. The default threshold `0.1` is strict.

## Configuration Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | `string` | `'betterdb_scache'` | Key prefix |
| `client` | `Valkey` | - | iovalkey client (required) |
| `embedFn` | `EmbedFn` | - | Embedding function (required) |
| `defaultThreshold` | `number` | `0.1` | Cosine distance threshold (0-2) |
| `defaultTtl` | `number` | `undefined` | Default TTL in seconds |
| `categoryThresholds` | `Record<string, number>` | `{}` | Per-category threshold overrides |
| `uncertaintyBand` | `number` | `0.05` | Width of uncertainty band |
| `costTable` | `Record<string, ModelCost>` | `undefined` | Per-model pricing |
| `useDefaultCostTable` | `boolean` | `true` | Use bundled LiteLLM price table |
| `normalizer` | `BinaryNormalizer` | `defaultNormalizer` | Binary content normalizer |
| `embeddingCache.enabled` | `boolean` | `true` | Cache computed embeddings |
| `embeddingCache.ttl` | `number` | `86400` | Embedding cache TTL (seconds) |
| `telemetry.tracerName` | `string` | `'@betterdb/semantic-cache'` | OTel tracer name |
| `telemetry.metricsPrefix` | `string` | `'semantic_cache'` | Prometheus prefix |
| `telemetry.registry` | `Registry` | default | prom-client Registry |

## Adapters

| Import | Class/Function | Description |
|---|---|---|
| `@betterdb/semantic-cache/langchain` | `BetterDBSemanticCache` | LangChain `BaseCache` |
| `@betterdb/semantic-cache/ai` | `createSemanticCacheMiddleware` | Vercel AI SDK middleware |
| `@betterdb/semantic-cache/openai` | `prepareSemanticParams` | OpenAI Chat Completions |
| `@betterdb/semantic-cache/openai-responses` | `prepareSemanticParams` | OpenAI Responses API |
| `@betterdb/semantic-cache/anthropic` | `prepareSemanticParams` | Anthropic Messages API |
| `@betterdb/semantic-cache/llamaindex` | `prepareSemanticParams` | LlamaIndex ChatMessage[] |
| `@betterdb/semantic-cache/langgraph` | `BetterDBSemanticStore` | LangGraph BaseStore |

## Embedding Helpers

| Import | Default model |
|---|---|
| `@betterdb/semantic-cache/embed/openai` | `text-embedding-3-small` (1536-dim) |
| `@betterdb/semantic-cache/embed/bedrock` | `amazon.titan-embed-text-v2:0` (1024-dim) |
| `@betterdb/semantic-cache/embed/voyage` | `voyage-3-lite` (512-dim) |
| `@betterdb/semantic-cache/embed/cohere` | `embed-english-v3.0` (1024-dim) |
| `@betterdb/semantic-cache/embed/ollama` | `nomic-embed-text` (768-dim) |

## API

### `cache.initialize()`

Creates or reconnects to the Valkey search index. Must be called before `check()` or `store()`. Safe to call multiple times.

### `cache.check(prompt, options?)`

`prompt` is `string | ContentBlock[]`. Returns `CacheCheckResult` with `hit`, `response`, `similarity`, `confidence`, `matchedKey`, `nearestMiss`, `costSaved`, `contentBlocks`.

**Options:** `threshold`, `category`, `filter`, `k`, `staleAfterModelChange`, `currentModel`, `rerank`

### `cache.store(prompt, response, options?)`

`prompt` is `string | ContentBlock[]`. Returns the Valkey key.

**Options:** `ttl`, `category`, `model`, `metadata`, `inputTokens`, `outputTokens`, `temperature`, `topP`, `seed`

### `cache.storeMultipart(prompt, blocks, options?)`

Stores structured `ContentBlock[]` as the response. On hit, `check()` returns `contentBlocks`.

### `cache.checkBatch(prompts[], options?)`

Pipelined multi-prompt lookups. Returns results in input order.

### `cache.invalidate(filter)`

Delete entries matching a `valkey-search` filter expression (e.g. `'@model:{gpt-4o}'`).

### `cache.invalidateByModel(model)` / `cache.invalidateByCategory(category)`

Convenience wrappers around `invalidate()`.

### `cache.stats()`

Returns `{ hits, misses, total, hitRate, costSavedMicros }`.

### `cache.indexInfo()`

Returns `{ name, numDocs, dimension, indexingState }`.

### `cache.flush()`

Drops the index and all keys. Call `initialize()` again to rebuild.

### `cache.thresholdEffectiveness(options?)`

Analyzes the rolling similarity score window and returns a `ThresholdEffectivenessResult` with `recommendation` (`tighten_threshold` | `loosen_threshold` | `optimal` | `insufficient_data`), `recommendedThreshold`, and `reasoning`.

### `cache.thresholdEffectivenessAll(options?)`

Returns one `ThresholdEffectivenessResult` per category plus one aggregate `'all'` result.

## Observability

### Prometheus Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `{prefix}_requests_total` | Counter | `cache_name`, `result`, `category` |
| `{prefix}_similarity_score` | Histogram | `cache_name`, `category` |
| `{prefix}_operation_duration_seconds` | Histogram | `cache_name`, `operation` |
| `{prefix}_embedding_duration_seconds` | Histogram | `cache_name` |
| `{prefix}_cost_saved_total` | Counter | `cache_name`, `category` |
| `{prefix}_embedding_cache_total` | Counter | `cache_name`, `result` |
| `{prefix}_stale_model_evictions_total` | Counter | `cache_name` |

### OpenTelemetry

Every public method emits an OTel span. Requires an OpenTelemetry SDK in the host application.

## Examples

Runnable examples are in [examples/](./examples/):

```
examples/basic/           - Core store/check/invalidate with Voyage AI
examples/openai/          - OpenAI Chat Completions adapter
examples/openai-responses/ - OpenAI Responses API adapter
examples/anthropic/       - Anthropic Messages adapter
examples/llamaindex/      - LlamaIndex ChatMessage adapter
examples/langchain/       - BetterDBSemanticCache wired into ChatOpenAI
examples/vercel-ai-sdk/   - createSemanticCacheMiddleware with wrapLanguageModel
examples/langgraph/       - BetterDBSemanticStore as LangGraph memory
examples/multimodal/      - ContentBlock[] with text + image
examples/cost-tracking/   - Cost savings tracking
examples/threshold-tuning/ - thresholdEffectiveness() recommendations
examples/embedding-cache/ - Embedding cache on/off
examples/batch-check/     - checkBatch() vs sequential timing
examples/rerank/          - Rerank hook for top-k selection
```

## Known Limitations

### Cluster mode

`flush()` uses cluster-aware SCAN via `clusterScan()` (fans out to all master nodes). `FT.CREATE` and `FT.SEARCH` work correctly in cluster mode via key hash routing, but `FT.CREATE` only creates the index on the receiving node - in a full cluster, create the index on each node separately.

### Streaming

`store()` requires a complete response string. The Vercel AI SDK adapter does not implement `wrapStream`. Accumulate the full streamed response before calling `store()`.

### Schema migration

v0.2.0 adds `binary_refs`, `temperature`, `top_p`, `seed` to the index schema. Existing v0.1.0 indexes operate in text-only mode until `flush()` + `initialize()` rebuilds the schema.

## License

MIT
