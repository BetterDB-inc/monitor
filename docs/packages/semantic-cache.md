---
layout: default
title: Semantic Cache
parent: Packages
nav_order: 1
---

# Semantic Cache

`@betterdb/semantic-cache` is a standalone, framework-agnostic semantic cache library for LLM applications backed by Valkey. It uses the `valkey-search` module's vector similarity search to match incoming prompts against previously cached responses, returning hits when the cosine distance falls below a configurable threshold.

**v0.2.0** adds full adapter parity with `agent-cache`: OpenAI, Anthropic, LlamaIndex, LangGraph, multi-modal prompt support, cost tracking, threshold effectiveness recommendations, embedding caching, batch lookups, and more.

## Prerequisites

- **Valkey 8.0+** with the `valkey-search` module loaded
- Or **Amazon ElastiCache for Valkey** (8.0+)
- Or **Google Cloud Memorystore for Valkey**
- Node.js >= 20

## Installation

```bash
npm install @betterdb/semantic-cache iovalkey
```

`iovalkey` is a peer dependency - you must install it alongside the package.

## Quick start

```typescript
import Valkey from 'iovalkey';
import { SemanticCache } from '@betterdb/semantic-cache';
import { createOpenAIEmbed } from '@betterdb/semantic-cache/embed/openai';

const client = new Valkey({ host: 'localhost', port: 6399 });

const cache = new SemanticCache({
  client,
  embedFn: createOpenAIEmbed(), // text-embedding-3-small by default
  defaultThreshold: 0.1,
  defaultTtl: 3600,
});

await cache.initialize();

await cache.store('What is the capital of France?', 'Paris', {
  model: 'gpt-4o',
  inputTokens: 20,
  outputTokens: 5,
});

const result = await cache.check('Capital city of France?');
// result.hit === true
// result.response === 'Paris'
// result.costSaved === 0.000105 (based on bundled LiteLLM prices)
```

## Configuration reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | `string` | `'betterdb_scache'` | Index name prefix for all Valkey keys |
| `client` | `Valkey` | *required* | An `iovalkey` client instance |
| `embedFn` | `(text: string) => Promise<number[]>` | *required* | Embedding function |
| `defaultThreshold` | `number` | `0.1` | Cosine distance threshold (0-2) |
| `defaultTtl` | `number` | `undefined` | Default TTL in seconds |
| `categoryThresholds` | `Record<string, number>` | `{}` | Per-category threshold overrides |
| `uncertaintyBand` | `number` | `0.05` | Width of the uncertainty band below threshold |
| `costTable` | `Record<string, ModelCost>` | `undefined` | Custom model pricing overrides |
| `useDefaultCostTable` | `boolean` | `true` | Merge bundled LiteLLM price table |
| `normalizer` | `BinaryNormalizer` | `defaultNormalizer` | Binary content normalizer for multi-modal prompts |
| `embeddingCache.enabled` | `boolean` | `true` | Cache computed embeddings in Valkey |
| `embeddingCache.ttl` | `number` | `86400` | Embedding cache TTL in seconds |
| `telemetry.tracerName` | `string` | `'@betterdb/semantic-cache'` | OTel tracer name |
| `telemetry.metricsPrefix` | `string` | `'semantic_cache'` | Prometheus metric name prefix |
| `telemetry.registry` | `Registry` | prom-client default | Custom prom-client Registry |

## Adapters

All adapters are subpath exports with optional peer dependencies.

### LangChain

```typescript
import { BetterDBSemanticCache } from '@betterdb/semantic-cache/langchain';
const llm = new ChatOpenAI({ cache: new BetterDBSemanticCache({ cache }) });
```

### Vercel AI SDK

```typescript
import { createSemanticCacheMiddleware } from '@betterdb/semantic-cache/ai';
const model = wrapLanguageModel({ model: openai('gpt-4o'), middleware: createSemanticCacheMiddleware({ cache }) });
```

### OpenAI Chat Completions

```typescript
import { prepareSemanticParams } from '@betterdb/semantic-cache/openai';
const { text, model } = await prepareSemanticParams(params);
const result = await cache.check(text);
```

### OpenAI Responses API

```typescript
import { prepareSemanticParams } from '@betterdb/semantic-cache/openai-responses';
const { text } = await prepareSemanticParams(params);
```

### Anthropic Messages

```typescript
import { prepareSemanticParams } from '@betterdb/semantic-cache/anthropic';
const { text } = await prepareSemanticParams(params);
```

### LlamaIndex

```typescript
import { prepareSemanticParams } from '@betterdb/semantic-cache/llamaindex';
const { text } = await prepareSemanticParams(messages, { model: 'gpt-4o' });
```

### LangGraph (semantic memory store)

```typescript
import { BetterDBSemanticStore } from '@betterdb/semantic-cache/langgraph';
const store = new BetterDBSemanticStore({ cache });
await store.put(['user', 'alice', 'memories'], 'mem1', { content: 'Alice lives in Paris.' });
const results = await store.search(['user', 'alice', 'memories'], { query: 'Where does Alice live?' });
```

Use `BetterDBSemanticStore` for similarity-based memory retrieval. For exact-match checkpoint persistence, use `@betterdb/agent-cache/langgraph`.

## Embedding helpers

Pre-built `EmbedFn` factories for common providers:

```typescript
import { createOpenAIEmbed } from '@betterdb/semantic-cache/embed/openai';
import { createBedrockEmbed } from '@betterdb/semantic-cache/embed/bedrock';
import { createVoyageEmbed } from '@betterdb/semantic-cache/embed/voyage';
import { createCohereEmbed } from '@betterdb/semantic-cache/embed/cohere';
import { createOllamaEmbed } from '@betterdb/semantic-cache/embed/ollama';
```

| Helper | Model default | Dimensions |
|---|---|---|
| `createOpenAIEmbed` | `text-embedding-3-small` | 1536 |
| `createBedrockEmbed` | `amazon.titan-embed-text-v2:0` | 1024 |
| `createVoyageEmbed` | `voyage-3-lite` | 512 |
| `createCohereEmbed` | `embed-english-v3.0` | 1024 |
| `createOllamaEmbed` | `nomic-embed-text` | 768 |

## Cost tracking

Store token counts alongside responses to enable cost savings reporting:

```typescript
await cache.store('What is the capital of France?', 'Paris', {
  model: 'gpt-4o',
  inputTokens: 25,
  outputTokens: 5,
});

const result = await cache.check('Capital of France?');
// result.costSaved === 0.000105 on hit

const stats = await cache.stats();
// stats.costSavedMicros === 105 (microdollars)
```

Cost is computed using the bundled LiteLLM price table (1,971 models). Override or extend with `costTable` option.

## Multi-modal prompts

Use `ContentBlock[]` to cache prompts with binary content:

```typescript
import { hashBase64, type ContentBlock } from '@betterdb/semantic-cache';

const prompt: ContentBlock[] = [
  { type: 'text', text: 'Describe this image.' },
  { type: 'binary', kind: 'image', mediaType: 'image/png', ref: hashBase64(imageBase64) },
];

await cache.store(prompt, 'A red square.');
const result = await cache.check(prompt); // hit only if text AND image match
```

Use `storeMultipart()` to store structured response blocks:

```typescript
const blocks: ContentBlock[] = [
  { type: 'text', text: 'The answer is 42.' },
  { type: 'reasoning', text: 'By my calculation...' },
];
await cache.storeMultipart(prompt, blocks);

const result = await cache.check(prompt);
// result.contentBlocks === blocks
```

## Threshold effectiveness recommendations

Analyze the rolling similarity score window for threshold tuning guidance:

```typescript
const analysis = await cache.thresholdEffectiveness({ minSamples: 100 });
// analysis.recommendation: 'tighten_threshold' | 'loosen_threshold' | 'optimal' | 'insufficient_data'
// analysis.recommendedThreshold: 0.085 (present when recommendation is not optimal/insufficient)
// analysis.reasoning: 'Human-readable explanation'

// Per-category analysis
const allCategories = await cache.thresholdEffectivenessAll();
```

## Batch check

Pipeline multiple lookups in a single round-trip:

```typescript
const results = await cache.checkBatch([
  'What is the capital of France?',
  'Who wrote Hamlet?',
  'What is 2 + 2?',
]);
// results[0].hit === true, etc.
```

## Stale model eviction

Automatically evict cache entries when the model changes:

```typescript
const result = await cache.check('What is 2+2?', {
  staleAfterModelChange: true,
  currentModel: 'gpt-4o',
});
// If the cached entry was stored with model='gpt-3.5-turbo', it's evicted and treated as miss
```

## Rerank hook

Retrieve top-k candidates and select the best with a custom function:

```typescript
const result = await cache.check(prompt, {
  rerank: {
    k: 5,
    rerankFn: async (query, candidates) => {
      // Return index of best candidate, or -1 to reject all
      return candidates.findIndex((c) => c.response.length > 50);
    },
  },
});
```

## Params-aware filtering

Store sampling parameters as indexed NUMERIC fields for opt-in filtering:

```typescript
await cache.store(prompt, response, { temperature: 0.7, topP: 0.9, seed: 42 });
const result = await cache.check(prompt, { filter: '@temperature:[0 0]' });
```

## Invalidation helpers

```typescript
await cache.invalidateByModel('gpt-4o');       // delete all entries for a model
await cache.invalidateByCategory('geography'); // delete all entries for a category
```

## Observability

### Prometheus metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `{prefix}_requests_total` | Counter | `cache_name`, `result`, `category` | Total lookups (result: hit/miss/uncertain_hit) |
| `{prefix}_similarity_score` | Histogram | `cache_name`, `category` | Cosine distance on every lookup with a candidate |
| `{prefix}_operation_duration_seconds` | Histogram | `cache_name`, `operation` | End-to-end operation duration |
| `{prefix}_embedding_duration_seconds` | Histogram | `cache_name` | Time in embedFn |
| `{prefix}_cost_saved_total` | Counter | `cache_name`, `category` | Cumulative dollars saved from cache hits |
| `{prefix}_embedding_cache_total` | Counter | `cache_name`, `result` | Embedding cache hit/miss counts |
| `{prefix}_stale_model_evictions_total` | Counter | `cache_name` | Entries evicted by staleAfterModelChange |

## Known limitations

### Cluster mode

`flush()` and embedding cache cleanup use `SCAN`. In Valkey Cluster mode, `SCAN` on a single node only iterates that node's keys. v0.2.0 uses `clusterScan()` (same pattern as `agent-cache`) to fan out across all master nodes for these operations.

The `FT.CREATE` index and `FT.SEARCH` queries work correctly in cluster mode because Valkey routes them to the appropriate node. However, `FT.CREATE` creates the index only on the node that receives the command - in a full cluster setup, users may need to create the index on each node. This is a fundamental limitation of `valkey-search` in cluster mode and is documented in the Valkey Search documentation.

### Streaming

`store()` expects a complete response string. Accumulate the full streamed response before calling `store()`. The `createSemanticCacheMiddleware` Vercel AI SDK adapter does not implement `wrapStream`.

### Schema migration

Adding `binary_refs`, `temperature`, `top_p`, and `seed` fields to the index schema in v0.2.0 requires a schema migration for existing v0.1.0 indexes. If the existing index lacks these fields, `check()` operates in text-only mode (no binary filtering). To migrate, call `flush()` and `initialize()` to rebuild with the full schema.

## Valkey Search 1.2 compatibility notes

1. `FT.INFO` error format: handles three variants for cross-compatibility
2. `FT.DROPINDEX DD` not supported: key cleanup done via SCAN + DEL
3. `FT.SEARCH` KNN score aliases: not usable in RETURN/SORTBY
4. `FT.INFO` dimension: nested inside `"index"` sub-array as `"dimensions"`
