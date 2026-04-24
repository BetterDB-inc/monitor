# Release Notes — @betterdb/semantic-cache v0.2.0

v0.1.0 shipped the core cache with text-only string prompts and two adapters.
v0.2.0 adds five new adapters, five embedding helpers, and a set of features
that make the cache production-ready: cost tracking, multi-modal prompts, batch
lookup, threshold tuning, embedding cache, stale-model eviction, and a rerank hook.

## Installation

```bash
npm install @betterdb/semantic-cache@0.2.0 iovalkey
```

---

## New adapters

v0.1.0 had LangChain and Vercel AI SDK. v0.2.0 adds:

### OpenAI Chat Completions — `@betterdb/semantic-cache/openai`

Extracts the last user message from `ChatCompletionCreateParams`. Handles text,
`image_url` (URL and base64), `input_audio`, and `file` content parts.

```typescript
import { prepareSemanticParams } from '@betterdb/semantic-cache/openai';

const { text, blocks, model } = await prepareSemanticParams(params);
const result = await cache.check(blocks ?? text);
if (!result.hit) {
  const response = await openai.chat.completions.create(params);
  await cache.store(blocks ?? text, response.choices[0].message.content!, { model });
}
```

### OpenAI Responses API — `@betterdb/semantic-cache/openai-responses`

Extracts the last user input from the Responses API `input` field — string or
message array with `input_text`, `input_image`, and `input_file` parts.

```typescript
import { prepareSemanticParams } from '@betterdb/semantic-cache/openai-responses';

const { text, blocks } = await prepareSemanticParams(params);
const result = await cache.check(blocks ?? text);
```

### Anthropic Messages — `@betterdb/semantic-cache/anthropic`

Extracts the last user message from `MessageCreateParamsNonStreaming`. Supports
text; base64, URL, and file images; and base64, URL, plaintext, and file documents.

```typescript
import { prepareSemanticParams } from '@betterdb/semantic-cache/anthropic';

const { text, blocks, model } = await prepareSemanticParams(params);
const result = await cache.check(blocks ?? text);
```

### LlamaIndex — `@betterdb/semantic-cache/llamaindex`

Extracts the last user `ChatMessage` from a `ChatMessage[]` array. Supports
`text`, `image_url`, `file`, `audio`, and `image` content parts.

```typescript
import { prepareSemanticParams } from '@betterdb/semantic-cache/llamaindex';

const { text } = await prepareSemanticParams(messages, { model: 'gpt-4o' });
const result = await cache.check(text);
```

### LangGraph semantic memory store — `@betterdb/semantic-cache/langgraph`

`BetterDBSemanticStore` implements the LangGraph `BaseStore` interface using
vector similarity — find the most semantically relevant past observations for a
given query. This is distinct from `@betterdb/agent-cache/langgraph`, which does
exact-match checkpoint persistence. Both can coexist on the same Valkey instance
with different key prefixes.

```typescript
import { BetterDBSemanticStore } from '@betterdb/semantic-cache/langgraph';

const store = new BetterDBSemanticStore({ cache, embedField: 'content' });

await store.put(['user', 'alice', 'facts'], 'pref_001', {
  content: 'Alice prefers async Python over synchronous code.',
});

const results = await store.search(['user', 'alice', 'facts'], {
  query: "What are Alice's coding preferences?",
  limit: 5,
});
// results[i].value — the stored object; results[i].key — the item key
```

Full interface: `put()`, `get()`, `search()` (semantic KNN or namespace scan),
`delete()`, `batch()`.

### Updated: LangChain — `@betterdb/semantic-cache/langchain`

`BetterDBSemanticCache` now wraps responses in a proper `AIMessage` so chat
models can correctly access `response.content`. New `filterByModel` option scopes
hits to a specific LLM configuration (deterministically hashed from `llm_string`).

---

## Embedding helpers

Five pre-built `EmbedFn` factories so you don't have to write your own:

| Import | Provider | Default model | Dimensions |
|---|---|---|---|
| `@betterdb/semantic-cache/embed/openai` | OpenAI | `text-embedding-3-small` | 1536 |
| `@betterdb/semantic-cache/embed/voyage` | Voyage AI | `voyage-3-lite` | 512 |
| `@betterdb/semantic-cache/embed/cohere` | Cohere | `embed-english-v3.0` | 1024 |
| `@betterdb/semantic-cache/embed/ollama` | Ollama (local) | `nomic-embed-text` | 768 |
| `@betterdb/semantic-cache/embed/bedrock` | AWS Bedrock | `amazon.titan-embed-text-v2:0` | 1024 |

```typescript
import { createOpenAIEmbed } from '@betterdb/semantic-cache/embed/openai';
import { createVoyageEmbed } from '@betterdb/semantic-cache/embed/voyage';
import { createOllamaEmbed } from '@betterdb/semantic-cache/embed/ollama';
import { createBedrockEmbed } from '@betterdb/semantic-cache/embed/bedrock';

const cache = new SemanticCache({
  client,
  embedFn: createVoyageEmbed({ model: 'voyage-3-lite' }),
});
```

All helpers lazily initialise their clients and cache the instance across calls —
no per-request connection overhead.

---

## New core features

### Cost tracking + bundled model price table

Store token counts at cache time; get automatic cost-saved reporting on every hit.
A bundled `DEFAULT_COST_TABLE` covers 1,971 models sourced from
[LiteLLM](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json)
and is refreshed on every release via `pnpm update:pricing`. No configuration is
required for common models.

```typescript
await cache.store('Summarize this document', responseText, {
  model: 'gpt-4o',
  inputTokens: 512,
  outputTokens: 128,
});

const result = await cache.check('Summarize this document');
console.log(result.costSaved);       // e.g. 0.00385 — dollars saved on this hit

const stats = await cache.stats();
console.log(stats.costSavedMicros);  // cumulative across all hits
```

Override or extend the table via `costTable`; disable it with
`useDefaultCostTable: false`. `DEFAULT_COST_TABLE` and `ModelCost` are exported
from the package root.

### Multi-modal prompts

`check()`, `store()`, and the new `storeMultipart()` accept `string | ContentBlock[]`.
A `ContentBlock[]` prompt embeds the text blocks and uses binary refs as an AND-filter —
a hit requires both the text to be semantically similar **and** all binary refs to
match exactly.

```typescript
import { hashBase64, type ContentBlock } from '@betterdb/semantic-cache';

const prompt: ContentBlock[] = [
  { type: 'text', text: 'What is in this image?' },
  { type: 'binary', kind: 'image', mediaType: 'image/png', ref: hashBase64(b64) },
];

await cache.store(prompt, 'A red square on a white background.');
const result = await cache.check(prompt); // hit requires both text AND same image
```

**`storeMultipart(prompt, blocks[])`** stores a structured response (text +
citations + tool calls) and returns `result.contentBlocks` on hit.

**Binary normalizer:** `composeNormalizer`, `hashBase64`, `hashBytes`, `hashUrl`,
and `fetchAndHash` produce stable, compact refs for any binary source. The
`defaultNormalizer` hashes base64 and bytes rather than storing raw data in TAG
fields. All normalizer utilities are exported from the package root.

### Embedding cache

Computed embedding vectors are stored in Valkey (`{name}:embed:{sha256}`) and
reused on subsequent `check()` calls for the same text — `embedFn` is only
called once per unique string, then reads hit a fast `GET`.

```typescript
// enabled by default; override if needed:
new SemanticCache({
  embeddingCache: { enabled: true, ttl: 86400 },
});
```

New Prometheus counter: `{prefix}_embedding_cache_total` labelled
`result: hit | miss`.

### Batch check — `checkBatch()`

Embeds all prompts in parallel and pipelines all `FT.SEARCH` calls in a single
Valkey round-trip.

```typescript
const results = await cache.checkBatch([
  'What is the capital of France?',
  'Who wrote Hamlet?',
  'What is the speed of light?',
]);
// results[i] is a CacheCheckResult — same shape as check()
```

Typically 60–80% faster than sequential `check()` calls for bulk lookups,
dashboards, and prefetch patterns.

### Rerank hook

Retrieve the top-k most similar candidates and apply custom ranking before
deciding whether to serve from cache — useful for cross-encoder reranking,
LLM-as-judge, or domain-specific scoring.

```typescript
const result = await cache.check(query, {
  rerank: {
    k: 5,
    rerankFn: async (query, candidates) => {
      const scores = await crossEncoder.predict(query, candidates.map(c => c.response));
      const best = scores.indexOf(Math.max(...scores));
      return scores[best] > 0.8 ? best : -1; // -1 → reject all → miss
    },
  },
});
```

### Stale-model eviction

Automatically evict cached entries when you upgrade the LLM for a prompt category.
On a hit, if the stored model differs from `currentModel`, the entry is deleted and
the call returns a miss — forcing a fresh response under the new model.

```typescript
const result = await cache.check(prompt, {
  staleAfterModelChange: true,
  currentModel: 'gpt-4o',  // evict if entry was stored with gpt-3.5-turbo
});
```

New Prometheus counter: `{prefix}_stale_model_evictions_total`.

### Threshold effectiveness recommendations

The cache records a rolling window of cosine distance scores (up to 10,000
entries, 7-day retention). `thresholdEffectiveness()` analyzes this window and
returns a concrete recommendation:

```typescript
const analysis = await cache.thresholdEffectiveness({ minSamples: 100 });
// {
//   recommendation: 'tighten_threshold',
//   currentThreshold: 0.1,
//   recommendedThreshold: 0.072,
//   hitRate: 0.83,
//   uncertainHitRate: 0.31,
//   nearMissRate: 0.04,
//   reasoning: '31.0% of hits are in the uncertainty band — tighten the threshold...',
// }

// Per-category + aggregate in one call:
const allResults = await cache.thresholdEffectivenessAll({ minSamples: 50 });
```

Possible recommendations: `tighten_threshold`, `loosen_threshold`, `optimal`,
`insufficient_data`.

### Params-aware filtering

`temperature`, `topP`, and `seed` are stored as NUMERIC fields on entries,
enabling opt-in filtering when sampling params affect correctness.

```typescript
await cache.store(prompt, response, { temperature: 0, seed: 42 });

const result = await cache.check(prompt, {
  filter: '@temperature:[0 0] @seed:[42 42]',
});
```

### PostHog analytics

Aggregate usage statistics (hit rate, cost saved per instance) are reported to
PostHog when the wheel is built with a baked API key. No prompt text, responses,
or PII are ever sent.

**To opt out:**

```bash
export BETTERDB_TELEMETRY=false   # also accepts: 0, no, off
```

Or programmatically: `new SemanticCache({ analytics: { disabled: true } })`.

Call `await cache.shutdown()` before process exit to flush any queued events.

---

## New `SemanticCache` API surface

| Addition | Description |
|---|---|
| `check(ContentBlock[])` | Multi-modal prompt lookup |
| `store(ContentBlock[])` | Multi-modal prompt storage |
| `storeMultipart(prompt, blocks[])` | Store a structured `ContentBlock[]` response |
| `checkBatch(prompts[])` | Pipelined multi-prompt lookup |
| `invalidateByModel(model)` | Delete all entries tagged with a model name |
| `invalidateByCategory(category)` | Delete all entries in a category |
| `thresholdEffectiveness(opts?)` | Rolling-window threshold tuning analysis |
| `thresholdEffectivenessAll(opts?)` | Per-category + aggregate threshold analysis |
| `shutdown()` | Stop stats timer and flush analytics queue |
| `CacheCheckResult.contentBlocks` | Structured response blocks on hit |
| `CacheCheckResult.costSaved` | Dollars saved (when cost metadata stored) |
| `CacheCheckResult.nearestMiss` | Similarity + delta for miss diagnostics |
| `CacheCheckOptions.rerank` | Top-k rerank hook |
| `CacheCheckOptions.staleAfterModelChange` | Auto-evict on model upgrade |
| `CacheStoreOptions.inputTokens / outputTokens` | For cost tracking |
| `SemanticCacheOptions.embeddingCache` | Embedding vector caching config |
| `SemanticCacheOptions.categoryThresholds` | Per-category threshold overrides |
| `SemanticCacheOptions.uncertaintyBand` | Controls `uncertain` vs `high` confidence |
| `SemanticCacheOptions.analytics` | PostHog analytics config |

---

## 13 runnable examples

```
examples/openai            examples/openai-responses   examples/anthropic
examples/llamaindex        examples/langchain           examples/langgraph
examples/vercel-ai-sdk     examples/multimodal          examples/cost-tracking
examples/threshold-tuning  examples/embedding-cache     examples/batch-check
examples/rerank
```

Each runs against a local Valkey instance with `pnpm start`. See
[examples/README.md](./examples/README.md) for setup instructions.

---

## Breaking changes

**None.** String prompts produce byte-identical behavior to v0.1.0.

**Schema migration for multi-modal features:** The v0.2.0 index schema adds
`binary_refs TAG`, `temperature NUMERIC`, `top_p NUMERIC`, and `seed NUMERIC`
fields. Existing v0.1.0 indexes continue to work in text-only mode. To use the
new fields, call `flush()` then `initialize()` — this drops and rebuilds the index.

---

## Links

- [Changelog](./CHANGELOG.md)
- [Examples](./examples/README.md)
- [Documentation](../../docs/packages/semantic-cache.md)
