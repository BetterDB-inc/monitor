---
layout: default
title: AI (all-in-one)
parent: Packages
nav_order: 0
---

# AI (all-in-one)

`@betterdb/ai` is one install for the whole BetterDB AI stack on Valkey. It
re-exports, and pins exact versions of, five packages:

| Package                                                 | Purpose                                         |
| ------------------------------------------------------- | ----------------------------------------------- |
| [`@betterdb/agent-cache`](agent-cache.html)             | Multi-tier exact-match cache                    |
| [`@betterdb/semantic-cache`](semantic-cache.html)       | Embedding-similarity cache                      |
| [`@betterdb/retrieval`](retrieval.html)                 | Vector + filtered query over valkey-search      |
| [`@betterdb/agent-memory`](agent-memory.html)           | Short-term tiers plus semantic long-term memory |
| [`@betterdb/valkey-search-kit`](valkey-search-kit.html) | Shared `FT.*` helpers                           |

Each remains published and supported. Install them directly for a narrower
dependency; install `@betterdb/ai` for the whole stack at one mutually
compatible set of versions.

```bash
npm install @betterdb/ai iovalkey
```

```ts
import Valkey from 'iovalkey';
import { AgentCache, SemanticCache, MemoryStore, Retriever } from '@betterdb/ai';

const client = new Valkey({ host: 'localhost', port: 6379 });
const cache = new AgentCache({ client });
```

## Framework adapters

| Import                          | Provides                                                      |
| ------------------------------- | ------------------------------------------------------------- |
| `@betterdb/ai/langchain`        | `BetterDBLlmCache`, `BetterDBSemanticCache`                   |
| `@betterdb/ai/langgraph`        | `BetterDBSaver`, `BetterDBSemanticStore`                      |
| `@betterdb/ai/vercel`           | `createAgentCacheMiddleware`, `createSemanticCacheMiddleware` |
| `@betterdb/ai/openai`           | `prepareParams`, `prepareSemanticParams`                      |
| `@betterdb/ai/openai-responses` | `prepareParams`, `prepareSemanticParams`                      |
| `@betterdb/ai/anthropic`        | `prepareParams`, `prepareSemanticParams`                      |
| `@betterdb/ai/llamaindex`       | `prepareParams`, `prepareSemanticParams`                      |

Six framework peers are optional — install the ones you use (`/openai` and
`/openai-responses` both use the `openai` peer). The seventh peer, `iovalkey`,
is required.

Subpath imports (everything but the root `@betterdb/ai` import) require
`"moduleResolution"` set to `"node16"`, `"nodenext"`, or `"bundler"` in your
`tsconfig.json`. The root import works under classic `"node"` resolution too.

## Embedding functions

`SemanticCache` requires an `embedFn` to turn text into a vector. Bring your
own, or use one of these provider-backed factories:

| Import                       | Provides             |
| ---------------------------- | -------------------- |
| `@betterdb/ai/embed/openai`  | `createOpenAIEmbed`  |
| `@betterdb/ai/embed/bedrock` | `createBedrockEmbed` |
| `@betterdb/ai/embed/voyage`  | `createVoyageEmbed`  |
| `@betterdb/ai/embed/cohere`  | `createCohereEmbed`  |
| `@betterdb/ai/embed/ollama`  | `createOllamaEmbed`  |

```ts
import { SemanticCache } from '@betterdb/ai';
import { createOpenAIEmbed } from '@betterdb/ai/embed/openai';

const cache = new SemanticCache({ client, embedFn: createOpenAIEmbed() });
```

## Namespaces

Twenty-five names are declared by more than one underlying package, so they are
not exported flat. Reach them through the namespace for the package you want:

```ts
import Valkey from 'iovalkey';
import { AgentCache, agentCache, semanticCache } from '@betterdb/ai';

const cache = new AgentCache({ client: new Valkey() });

try {
  await cache.llm.check({
    model: 'claude-sonnet-4-5',
    messages: [{ role: 'user', content: 'hello' }],
  });
} catch (err) {
  if (err instanceof agentCache.ValkeyCommandError) {
    // agent-cache errors extend AgentCacheError
  } else if (err instanceof semanticCache.ValkeyCommandError) {
    // semantic-cache's extend Error — a different class with the same name
  }
}
```

Namespaces: `agentCache`, `semanticCache`, `retrieval`, `memory`, `searchKit`.
Each mirrors its package's full root surface, so anything unavailable flat is
available here.

There is no PyPI equivalent yet — Python users install the individual
`betterdb-*` packages.

## Versioning

Facade releases are automatic patch bumps triggered by each child's own
release, and may carry breaking changes from a child package. Consumers who
need strict semver guarantees should pin `@betterdb/ai` to an exact version.
