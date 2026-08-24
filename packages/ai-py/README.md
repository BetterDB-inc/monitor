# betterdb-ai

One install and one import root for the BetterDB AI stack on Valkey.

```bash
pip install betterdb-ai
```

## Usage

```python
from valkey.asyncio import Valkey
from betterdb_ai import AgentCache, SemanticCache, MemoryStore, Retriever

client = Valkey(host="localhost", port=6379)
cache = AgentCache(client=client)
```

This package adds no behaviour of its own. It depends on the five packages that
make up the Python SDK and re-exports them:

| Package | What it gives you |
| --- | --- |
| `betterdb-agent-cache` | `AgentCache` — exact-match LLM, tool, and session tiers |
| `betterdb-semantic-cache` | `SemanticCache` — embedding-similarity cache |
| `betterdb-retrieval` | `Retriever` — index lifecycle, upsert, vector + filtered query |
| `betterdb-agent-memory` | `AgentMemory`, `MemoryStore` — long-term recall |
| `betterdb-valkey-search-kit` | shared `FT.*` helpers |

Each keeps its own name, version, and release workflow. Install them directly
instead if you only need one.

## Framework adapters

| Import | Provides |
| --- | --- |
| `betterdb_ai.langchain` | `BetterDBLlmCache`, `BetterDBSemanticCache` |
| `betterdb_ai.langgraph` | `BetterDBSaver`, `BetterDBSemanticStore` |
| `betterdb_ai.openai` | `prepare_params`, `prepare_semantic_params` |
| `betterdb_ai.openai_responses` | `prepare_params`, `prepare_semantic_params` |
| `betterdb_ai.anthropic` | `prepare_params`, `prepare_semantic_params` |
| `betterdb_ai.llamaindex` | `prepare_params`, `prepare_semantic_params` |
| `betterdb_ai.openai_agents` | `prepare_params`, `CachedModel`, `CachedModelProvider` |
| `betterdb_ai.pydantic_ai` | `prepare_params`, `CachedModel` |

`openai_agents` and `pydantic_ai` are agent-cache only — there is no semantic
counterpart, so those two modules have no `prepare_semantic_params`. There is no
`vercel` module: the Vercel AI SDK is TypeScript, and only `@betterdb/ai` has one.

Install the matching framework yourself, or take the extra:

```bash
pip install "betterdb-ai[langchain]"
```

| Extra | Pulls |
| --- | --- |
| `openai` | `openai` |
| `anthropic` | `anthropic` |
| `langchain` | `langchain-core`, `langchain-openai` |
| `langgraph` | `langgraph` |
| `llamaindex` | `llama-index-core` |
| `openai_agents` | `openai-agents` |
| `pydantic_ai` | `pydantic-ai-slim` |
| `normalizer` | `aiohttp` |
| `bedrock` | `boto3` |
| `httpx` | `httpx` |
| `all` | every one of the above |

Each extra fans out to the same extra on every child that declares it, so
`betterdb-ai[langchain]` covers both caches' LangChain adapters.

## Embedding functions

`SemanticCache` needs an `embed_fn` to turn text into a vector. Bring your own,
or use one of the provider-backed factories:

| Import | Provides | Needs |
| --- | --- | --- |
| `betterdb_ai.embed.openai` | `create_openai_embed` | `[openai]` |
| `betterdb_ai.embed.bedrock` | `create_bedrock_embed` | `[bedrock]` |
| `betterdb_ai.embed.voyage` | `create_voyage_embed` | `[httpx]` |
| `betterdb_ai.embed.cohere` | `create_cohere_embed` | `[httpx]` |
| `betterdb_ai.embed.ollama` | `create_ollama_embed` | `[httpx]` |
| `betterdb_ai.embed.google` | `create_google_embed` | `[httpx]` |

```python
from betterdb_ai import SemanticCache, SemanticCacheOptions
from betterdb_ai.embed.openai import create_openai_embed

cache = SemanticCache(SemanticCacheOptions(client=client, embed_fn=create_openai_embed()))
```

## Namespaces

Twenty-two names are declared by more than one underlying package as a
*different* object, so they are not exported flat. Flattening one would silently
break `except` and `isinstance` for the other — `ValkeyCommandError` is a
genuinely different class in each cache. Reach those through the namespace for
the package you mean:

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

The five namespaces are `agent_cache`, `semantic_cache`, `retrieval`, `memory`,
and `search_kit`. Every name a child declares stays reachable through them, so
nothing is lost by not being flat. `betterdb_ai.AMBIGUOUS` lists the names this
applies to and `betterdb_ai.NAMESPACES` the five modules.

A name that two packages export but that resolves to the *same* object is not
ambiguous and is flattened once — `betterdb_semantic_cache` re-exports
`escape_tag`, `encode_float32`, `decode_float32`, and `parse_ft_search_response`
straight from `betterdb_valkey_search_kit`.

## Versioning

`betterdb-ai` pins the five children to exact `==` versions resolved from PyPI
at publish time, so a given facade release names exactly the child versions it
was tested against. Every automatic bump is a patch bump, which means a child's
breaking release can arrive under a facade version that looks compatible. Read
the children's changelogs, not just this one, until the facade leaves `0.x`.

**The Python and TypeScript SDKs version independently.** `betterdb-ai 0.1.0`
and `@betterdb/ai 0.1.0` are not the same surface, and
`betterdb-semantic-cache` and `@betterdb/semantic-cache` do not track each other
either. Compare the packages you actually installed rather than assuming parity
across ecosystems.

## License

MIT
