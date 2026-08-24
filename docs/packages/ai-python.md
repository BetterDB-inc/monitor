---
layout: default
title: AI (all-in-one, Python)
parent: Packages
nav_order: 4
---

# AI (all-in-one, Python)

`betterdb-ai` is one install for the whole BetterDB AI stack on Valkey, and the
Python counterpart to [`@betterdb/ai`](ai.html). It re-exports, and pins exact
versions of, five packages:

| Package                                                        | Purpose                                         |
| -------------------------------------------------------------- | ----------------------------------------------- |
| [`betterdb-agent-cache`](agent-cache-python.html)              | Multi-tier exact-match cache                    |
| [`betterdb-semantic-cache`](semantic-cache-python.html)        | Embedding-similarity cache                      |
| [`betterdb-retrieval`](retrieval-python.html)                  | Vector + filtered query over valkey-search      |
| [`betterdb-agent-memory`](agent-memory-python.html)            | Short-term tiers plus semantic long-term memory |
| [`betterdb-valkey-search-kit`](valkey-search-kit-python.html)  | Shared `FT.*` helpers                           |

Each remains published and supported. Install them directly for a narrower
dependency; install `betterdb-ai` for the whole stack at one mutually
compatible set of versions.

```bash
pip install betterdb-ai
```

```python
from valkey.asyncio import Valkey
from betterdb_ai import AgentCache, SemanticCache, MemoryStore, Retriever

client = Valkey(host="localhost", port=6379)
cache = AgentCache(client=client)
```

## Framework adapters

| Import                          | Provides                                             |
| ------------------------------- | ---------------------------------------------------- |
| `betterdb_ai.langchain`         | `BetterDBLlmCache`, `BetterDBSemanticCache`          |
| `betterdb_ai.langgraph`         | `BetterDBSaver`, `BetterDBSemanticStore`             |
| `betterdb_ai.openai`            | `prepare_params`, `prepare_semantic_params`          |
| `betterdb_ai.openai_responses`  | `prepare_params`, `prepare_semantic_params`          |
| `betterdb_ai.anthropic`         | `prepare_params`, `prepare_semantic_params`          |
| `betterdb_ai.llamaindex`        | `prepare_params`, `prepare_semantic_params`          |
| `betterdb_ai.openai_agents`     | `prepare_params`, `CachedModel`, `CachedModelProvider` |
| `betterdb_ai.pydantic_ai`       | `prepare_params`, `CachedModel`                      |

The adapter set is not the same as the TypeScript one, because the underlying
packages differ. `openai_agents` and `pydantic_ai` exist only here, and both are
agent-cache only — there is no semantic counterpart, so neither module has a
`prepare_semantic_params`. There is no `vercel` module: the Vercel AI SDK is
TypeScript, so only `@betterdb/ai` has one.

Install the framework you use, or take the matching extra:

```bash
pip install "betterdb-ai[langchain]"
```

| Extra           | Pulls                                |
| --------------- | ------------------------------------ |
| `openai`        | `openai`                             |
| `anthropic`     | `anthropic`                          |
| `langchain`     | `langchain-core`, `langchain-openai` |
| `langgraph`     | `langgraph`                          |
| `llamaindex`    | `llama-index-core`                   |
| `openai_agents` | `openai-agents`                      |
| `pydantic_ai`   | `pydantic-ai-slim`                   |
| `normalizer`    | `aiohttp`                            |
| `bedrock`       | `boto3`                              |
| `httpx`         | `httpx`                              |
| `all`           | every one of the above               |

Each extra fans out to the same extra on every child that declares it, so
`betterdb-ai[langchain]` covers both caches' LangChain adapters.

## Embedding functions

`SemanticCache` needs an `embed_fn` to turn text into a vector. Bring your own,
or use one of these provider-backed factories:

| Import                       | Provides              | Needs       |
| ---------------------------- | --------------------- | ----------- |
| `betterdb_ai.embed.openai`   | `create_openai_embed` | `[openai]`  |
| `betterdb_ai.embed.bedrock`  | `create_bedrock_embed`| `[bedrock]` |
| `betterdb_ai.embed.voyage`   | `create_voyage_embed` | `[httpx]`   |
| `betterdb_ai.embed.cohere`   | `create_cohere_embed` | `[httpx]`   |
| `betterdb_ai.embed.ollama`   | `create_ollama_embed` | `[httpx]`   |
| `betterdb_ai.embed.google`   | `create_google_embed` | `[httpx]`   |

```python
from betterdb_ai import SemanticCache, SemanticCacheOptions
from betterdb_ai.embed.openai import create_openai_embed

cache = SemanticCache(SemanticCacheOptions(client=client, embed_fn=create_openai_embed()))
```

## Namespaces

Twenty-two names are declared as a *different* object by more than one
underlying package, so they are not exported flat — flattening one would
silently break `except` and `isinstance` for the other. Reach them through the
namespace for the package you want:

```python
import asyncio

from betterdb_ai import AgentCache, agent_cache, semantic_cache


async def main() -> None:
    cache = AgentCache(client=client)

    try:
        await cache.llm.check(model="claude-sonnet-4-5", messages=[...])
    except agent_cache.ValkeyCommandError:
        # agent-cache errors extend AgentCacheError
        ...
    except semantic_cache.ValkeyCommandError:
        # semantic-cache's ValkeyCommandError extends Exception — a different
        # class that happens to share the name
        ...


asyncio.run(main())
```

Namespaces: `agent_cache`, `semantic_cache`, `retrieval`, `memory`,
`search_kit`. Each is the child module itself, so anything unavailable flat is
available here. `betterdb_ai.AMBIGUOUS` lists the affected names and
`betterdb_ai.NAMESPACES` the five modules.

A name two packages export that resolves to the *same* object is not ambiguous
and is flattened once — `betterdb_semantic_cache` re-exports `escape_tag`,
`encode_float32`, `decode_float32`, and `parse_ft_search_response` straight from
`betterdb_valkey_search_kit`.

The conflict set is not the same as the TypeScript one and is recomputed at
import time rather than written down, because `betterdb_agent_memory` builds its
`__all__` dynamically from `betterdb_agent_cache`'s.

## Versioning

Facade releases are automatic patch bumps triggered by each child's own release,
and may carry breaking changes from a child package. Consumers who need strict
semver guarantees should pin `betterdb-ai` to an exact version.

**The Python and TypeScript SDKs version independently.** `betterdb-ai 0.1.0`
and `@betterdb/ai 0.1.0` are not the same surface, and the individual packages
do not track each other across ecosystems either. Compare the packages you
actually installed rather than assuming parity.
