# Release Notes - @betterdb/semantic-cache v0.2.0

## What's New

v0.2.0 brings full adapter parity with `@betterdb/agent-cache`, adds cost tracking with a bundled model price table, multi-modal prompt support, threshold effectiveness recommendations, and several new quality-of-life features.

## Installation

```bash
npm install @betterdb/semantic-cache@0.2.0 iovalkey
```

## Highlights

### Bundled cost table + cost savings tracking

Store token counts at cache-time and automatically compute cost saved on every hit:

```typescript
await cache.store('What is the capital of France?', 'Paris', {
  model: 'gpt-4o',
  inputTokens: 25,
  outputTokens: 5,
});

const result = await cache.check('Capital city of France?');
console.log(result.costSaved); // e.g. 0.000105
```

The bundled `DEFAULT_COST_TABLE` contains pricing for 1,971 models sourced from LiteLLM. Update with `pnpm update:pricing`.

### Five new provider adapters

Each extracts the semantic cache key from provider-specific request params:

```typescript
import { prepareSemanticParams } from '@betterdb/semantic-cache/openai';
import { prepareSemanticParams } from '@betterdb/semantic-cache/openai-responses';
import { prepareSemanticParams } from '@betterdb/semantic-cache/anthropic';
import { prepareSemanticParams } from '@betterdb/semantic-cache/llamaindex';
import { BetterDBSemanticStore } from '@betterdb/semantic-cache/langgraph';
```

### Embedding helpers

Five pre-built `EmbedFn` factories for common providers:

```typescript
import { createOpenAIEmbed } from '@betterdb/semantic-cache/embed/openai';
import { createVoyageEmbed } from '@betterdb/semantic-cache/embed/voyage';
// + createBedrockEmbed, createCohereEmbed, createOllamaEmbed
```

### Multi-modal prompts

Cache prompts containing both text and binary content (images, documents, audio):

```typescript
const prompt: ContentBlock[] = [
  { type: 'text', text: 'Describe this image.' },
  { type: 'binary', kind: 'image', mediaType: 'image/png', ref: hashBase64(b64) },
];
await cache.store(prompt, 'A red square.');
const result = await cache.check(prompt); // only hits if text AND image ref match
```

### Threshold effectiveness recommendations

Analyze the rolling score window and get actionable threshold tuning advice:

```typescript
const analysis = await cache.thresholdEffectiveness({ minSamples: 100 });
// { recommendation: 'tighten_threshold', recommendedThreshold: 0.085, reasoning: '...' }
```

### Embedding cache

Avoid re-embedding the same text on repeated `check()` calls. Enabled by default with 24-hour TTL:

```typescript
const cache = new SemanticCache({
  // ...
  embeddingCache: { enabled: true, ttl: 86400 },
});
```

### Other additions

- `checkBatch(prompts[])` - pipelined multi-prompt lookups
- `storeMultipart(prompt, blocks[])` - store structured response content blocks
- `invalidateByModel(model)` / `invalidateByCategory(category)` - convenience invalidation
- `staleAfterModelChange` option - auto-evict entries from old models
- `rerank` hook - top-k candidate selection with custom ranking function
- `temperature`, `topP`, `seed` stored as NUMERIC fields for opt-in filtering
- Cluster-aware `flush()` using `clusterScan()` across all master nodes

## Breaking changes

None. v0.2.0 is backward compatible with v0.1.0. Existing text-only string prompts produce byte-identical cache behavior.

**Schema migration required for multi-modal features:** The v0.2.0 index schema adds `binary_refs`, `temperature`, `top_p`, and `seed` fields. Existing v0.1.0 indexes operate in text-only mode until `flush()` and `initialize()` are called to rebuild.

## Examples

Runnable examples for every adapter and feature are in `packages/semantic-cache/examples/`. Each runs against a local Valkey instance at `localhost:6399`.

## Links

- [Changelog](./CHANGELOG.md)
- [Examples](./examples/README.md)
- [Documentation](../../docs/packages/semantic-cache.md)
