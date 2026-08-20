# @betterdb/ai

One install for the BetterDB AI stack on Valkey.

```bash
npm install @betterdb/ai iovalkey
```

## Usage

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

Install the matching framework yourself — all seven are optional peers.

## Namespaces

A handful of names are declared by more than one underlying package, so they are
not exported flat. Reach them through the namespace for the package you want:

```ts
import { agentCache, semanticCache } from '@betterdb/ai';

try {
  await cache.get(params);
} catch (e) {
  if (e instanceof agentCache.ValkeyCommandError) {
    // agent-cache errors extend AgentCacheError
  }
}

let block: agentCache.ContentBlock;
```

Namespaces: `agentCache`, `semanticCache`, `retrieval`, `memory`, `searchKit`.
Each mirrors the corresponding package's full root export surface, so anything
not available flat is available here.

## Relationship to the individual packages

`@betterdb/ai` re-exports, and pins exact versions of:

- [`@betterdb/agent-cache`](../agent-cache) — multi-tier exact-match cache
- [`@betterdb/semantic-cache`](../semantic-cache) — embedding-similarity cache
- [`@betterdb/retrieval`](../retrieval) — vector + filtered query over valkey-search
- [`@betterdb/agent-memory`](../agent-memory) — short-term tiers plus semantic long-term memory
- [`@betterdb/valkey-search-kit`](../valkey-search-kit) — shared `FT.*` helpers

They remain published and supported. Install them directly if you want a
narrower dependency; install `@betterdb/ai` if you want the whole stack at one
mutually-compatible set of versions.
