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

Install the matching framework yourself. Six framework peers are optional
(`/openai` and `/openai-responses` both use the `openai` peer) — `iovalkey` is
the seventh peer and is required.

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

## Versioning

Facade releases are automatic patch bumps triggered by each child's own
release, and may carry breaking changes from a child package. Consumers who
need strict semver guarantees should pin `@betterdb/ai` to an exact version.
