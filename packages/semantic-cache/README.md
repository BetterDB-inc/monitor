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
  defaultThreshold: 0.15,       // loosen slightly to catch paraphrases with high confidence
  defaultTtl: 3600,
});

await cache.initialize();

// Store with cost tracking
await cache.store('What is the capital of France?', 'Paris', {
  model: 'gpt-4o-mini',
  inputTokens: 20,
  outputTokens: 5,
});

// Exact match - always high confidence
const exact = await cache.check('What is the capital of France?');
// exact.hit === true
// exact.confidence === 'high'
// exact.similarity === 0.0000
// exact.costSaved === 0.0000085

// Paraphrase - typically 'uncertain' at threshold 0.1, 'high' at threshold 0.15
const paraphrase = await cache.check('What city is the capital of France?');
// paraphrase.hit === true
// paraphrase.confidence === 'high'    // at threshold 0.15
// paraphrase.similarity ~= 0.087      // observed with text-embedding-3-small
// paraphrase.costSaved === 0.0000085
```

## Threshold and Confidence

This library uses **cosine distance** (0-2 scale, lower = more similar):

| Distance | Meaning |
|----------|---------|
| 0.00 | Identical vectors |
| 0.05-0.10 | Strong paraphrase |
| 0.10-0.20 | Loose paraphrase / related topic |
| 1.00 | Orthogonal (unrelated) |

A lookup is a **hit** when `score <= threshold`. The default threshold is `0.1`.

### Confidence levels

| `confidence` | When | What to do |
|---|---|---|
| `high` | `score <= threshold - uncertaintyBand` (e.g. `<= 0.05`) | Return the cached response directly |
| `uncertain` | `threshold - band < score <= threshold` (e.g. `0.05–0.10`) | Return the response but consider flagging for review |
| `miss` | `score > threshold` | No hit - call the LLM |

**With real embeddings (`text-embedding-3-small`):**
- Exact same phrasing: `~0.000` - always `high`
- Close paraphrase ("Which city is the capital of France?"): `~0.08–0.09` - `uncertain` at default `0.1` threshold, `high` at `0.15`
- Loose paraphrase ("France's capital?"): `~0.10–0.15` - typically `miss` at `0.1`, `uncertain` at `0.15`

**Recommended thresholds by use case:**

| Use case | Threshold | Notes |
|---|---|---|
| FAQ / exact match only | `0.05` | Very strict, near-zero false positives |
| Standard Q&A | `0.10` | Default - paraphrases land as `uncertain` |
| Conversational / RAG | `0.15` | Paraphrases hit as `high` confidence |
| Broad search / recall | `0.20` | High hit rate, review uncertain hits |

## Configuration Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | `string` | `'betterdb_scache'` | Key prefix |
| `client` | `Valkey` | - | iovalkey client (required) |
| `embedFn` | `EmbedFn` | - | Embedding function (required) |
| `defaultThreshold` | `number` | `0.1` | Cosine distance threshold (0-2) |
| `defaultTtl` | `number` | `undefined` | Default TTL in seconds |
| `categoryThresholds` | `Record<string, number>` | `{}` | Per-category threshold overrides |
| `uncertaintyBand` | `number` | `0.05` | Width of uncertainty band below threshold |
| `costTable` | `Record<string, ModelCost>` | `undefined` | Per-model pricing overrides |
| `useDefaultCostTable` | `boolean` | `true` | Use bundled LiteLLM price table (1,971 models) |
| `normalizer` | `BinaryNormalizer` | `defaultNormalizer` | Binary content normalizer |
| `embeddingCache.enabled` | `boolean` | `true` | Cache computed embeddings in Valkey |
| `embeddingCache.ttl` | `number` | `86400` | Embedding cache TTL (seconds) |
| `telemetry.tracerName` | `string` | `'@betterdb/semantic-cache'` | OTel tracer name |
| `telemetry.metricsPrefix` | `string` | `'semantic_cache'` | Prometheus prefix |
| `telemetry.registry` | `Registry` | default | prom-client Registry |

## Cost Tracking

Store token counts at cache-time to get per-hit cost savings:

```typescript
await cache.store('What is the capital of France?', 'Paris', {
  model: 'claude-haiku-4-5',   // looked up in bundled LiteLLM price table
  inputTokens: 42,
  outputTokens: 12,
});

const result = await cache.check('Capital of France?');
console.log(result.costSaved);  // e.g. 0.000064 (dollars saved on this hit)

const stats = await cache.stats();
console.log(stats.costSavedMicros); // cumulative microdollars saved
```

Cost savings scale with the model. Observed values from live examples:
- `gpt-4o-mini`: ~`$0.000006` per hit (cheap model, short responses)
- `claude-haiku-4-5`: ~`$0.000064` per hit (~10x more expensive)
- `gpt-4o`: ~`$0.000100` per hit at 20 input / 5 output tokens

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

| Import | Default model | Dimensions |
|---|---|---|
| `@betterdb/semantic-cache/embed/openai` | `text-embedding-3-small` | 1536 |
| `@betterdb/semantic-cache/embed/bedrock` | `amazon.titan-embed-text-v2:0` | 1024 |
| `@betterdb/semantic-cache/embed/voyage` | `voyage-3-lite` | 512 |
| `@betterdb/semantic-cache/embed/cohere` | `embed-english-v3.0` | 1024 |
| `@betterdb/semantic-cache/embed/ollama` | `nomic-embed-text` | 768 |

## API

### `cache.initialize()`

Creates or reconnects to the Valkey search index. Must be called before `check()` or `store()`. Safe to call multiple times.

### `cache.check(prompt, options?)`

`prompt` is `string | ContentBlock[]`. Returns `CacheCheckResult`:

| Field | Description |
|---|---|
| `hit` | Whether the nearest neighbour's distance was `<= threshold` |
| `response` | Cached response text. Present on hit |
| `similarity` | Cosine distance (0-2). Present when a candidate was found |
| `confidence` | `'high'` / `'uncertain'` / `'miss'` |
| `costSaved` | Dollars saved on this hit. Present when cost was recorded at store time |
| `contentBlocks` | Structured response blocks. Present when stored via `storeMultipart()` |
| `nearestMiss` | On miss with a candidate: `{ similarity, deltaToThreshold }` |

**Options:** `threshold`, `category`, `filter`, `k`, `staleAfterModelChange`, `currentModel`, `rerank`

### `cache.store(prompt, response, options?)`

`prompt` is `string | ContentBlock[]`. Returns the Valkey key.

**Options:** `ttl`, `category`, `model`, `metadata`, `inputTokens`, `outputTokens`, `temperature`, `topP`, `seed`

### `cache.storeMultipart(prompt, blocks, options?)`

Stores structured `ContentBlock[]` as the response. On hit, `check()` returns `contentBlocks`.

### `cache.checkBatch(prompts[], options?)`

Pipelined multi-prompt lookups. ~50-70% faster than sequential `check()` calls. Returns results in input order.

### `cache.invalidate(filter)`

Delete entries matching a `valkey-search` filter (e.g. `'@model:{gpt-4o}'`).

### `cache.invalidateByModel(model)` / `cache.invalidateByCategory(category)`

Convenience wrappers around `invalidate()`.

### `cache.stats()`

Returns `{ hits, misses, total, hitRate, costSavedMicros }`.

### `cache.indexInfo()`

Returns `{ name, numDocs, dimension, indexingState }`.

### `cache.flush()`

Drops the index and all keys. Call `initialize()` again to rebuild.

### `cache.thresholdEffectiveness(options?)`

Analyzes the rolling similarity score window (last 10,000 entries, up to 7 days) and returns:

```typescript
{
  recommendation: 'tighten_threshold' | 'loosen_threshold' | 'optimal' | 'insufficient_data',
  recommendedThreshold?: number,  // present when recommendation is tighten/loosen
  reasoning: string,              // human-readable explanation
  hitRate: number,
  uncertainHitRate: number,       // >20% triggers tighten recommendation
  nearMissRate: number,           // >30% with avg delta <0.03 triggers loosen
  // ...
}
```

### `cache.thresholdEffectivenessAll(options?)`

Returns one result per category seen in the window, plus one aggregate `'all'` result.

## Observability

### Prometheus Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `{prefix}_requests_total` | Counter | `cache_name`, `result`, `category` | `result`: `hit`, `miss`, `uncertain_hit` |
| `{prefix}_similarity_score` | Histogram | `cache_name`, `category` | Cosine distance per lookup |
| `{prefix}_operation_duration_seconds` | Histogram | `cache_name`, `operation` | End-to-end latency |
| `{prefix}_embedding_duration_seconds` | Histogram | `cache_name` | Time in `embedFn` |
| `{prefix}_cost_saved_total` | Counter | `cache_name`, `category` | Dollars saved from hits |
| `{prefix}_embedding_cache_total` | Counter | `cache_name`, `result` | Embedding cache hit/miss |
| `{prefix}_stale_model_evictions_total` | Counter | `cache_name` | Evictions from `staleAfterModelChange` |

### OpenTelemetry

Every public method emits an OTel span. Requires an OpenTelemetry SDK in the host application.

## Examples

Runnable examples in [examples/](./examples/). All examples connect to `localhost:6399` by default (override via `VALKEY_HOST` / `VALKEY_PORT`).

| Example | API key needed | What it shows |
|---|---|---|
| `basic/` | Voyage AI (or `--mock`) | Core store/check/invalidate |
| `openai/` | OpenAI | Chat Completions + cost tracking |
| `openai-responses/` | OpenAI | Responses API adapter |
| `anthropic/` | Anthropic + OpenAI | Messages API, high cost savings (~$0.000064/hit) |
| `llamaindex/` | OpenAI | ChatMessage[] adapter |
| `langchain/` | OpenAI | BetterDBSemanticCache + ChatOpenAI |
| `vercel-ai-sdk/` | OpenAI | createSemanticCacheMiddleware |
| `langgraph/` | None | BetterDBSemanticStore memory |
| `multimodal/` | None | ContentBlock[] with text + image |
| `cost-tracking/` | None | Cost savings with mock embedder |
| `threshold-tuning/` | None | thresholdEffectiveness() |
| `embedding-cache/` | None | Embedding cache on/off comparison |
| `batch-check/` | None | checkBatch() vs sequential |
| `rerank/` | None | Top-k rerank hook |

## Client Lifecycle

SemanticCache does **not** own the iovalkey client:

```typescript
const client = new Valkey({ host: 'localhost', port: 6399 });
const cache = new SemanticCache({ client, embedFn });
// ... use cache ...
await client.quit();
```

## Known Limitations

### Cluster mode

`flush()` fans out via `clusterScan()` across all master nodes. `FT.SEARCH` routes correctly via hash slots. `FT.CREATE` only creates the index on the receiving node - in a full cluster, create the index on each node separately.

### Streaming

`store()` requires a complete response string. The Vercel AI SDK adapter does not implement `wrapStream`. Accumulate the full streamed response before calling `store()`.

### Schema migration (v0.1 -> v0.2)

v0.2.0 added `binary_refs`, `temperature`, `top_p`, `seed` fields to the index schema. Existing v0.1.0 indexes operate in text-only mode until `flush()` + `initialize()` rebuilds the schema.

## License

MIT
