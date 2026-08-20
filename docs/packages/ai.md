---
layout: default
title: AI (all-in-one)
parent: Packages
nav_order: 1
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

All seven frameworks are optional peers — install the ones you use.

## Namespaces

Twenty-five names are declared by more than one underlying package, so they are
not exported flat. Reach them through the namespace for the package you want:

```ts
import { agentCache, semanticCache } from '@betterdb/ai';

if (e instanceof agentCache.ValkeyCommandError) {
  // agent-cache errors extend AgentCacheError; semantic-cache's extend Error
}
```

Namespaces: `agentCache`, `semanticCache`, `retrieval`, `memory`, `searchKit`.
Each mirrors its package's full root surface, so anything unavailable flat is
available here.

There is no PyPI equivalent yet — Python users install the individual
`betterdb-*` packages.
