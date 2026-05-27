---
layout: default
title: Semantic Cache (Python)
parent: Packages
nav_order: 2
---

# Semantic Cache (Python)

`betterdb-semantic-cache` is the Python counterpart to [`@betterdb/semantic-cache`](/docs/packages/semantic-cache). Same architecture, same Valkey data format, same Monitor integration — different language. A TypeScript app and a Python app can share the same cache index.

**v0.4.0** ships with full feature parity: LLM-as-judge, reranking, embedding caching, cost tracking, config refresh, discovery, multi-modal prompts, batch lookups, and all framework adapters.

## Prerequisites

- **Valkey 8.0+** with the `valkey-search` module loaded
- Or **Amazon ElastiCache for Valkey** (8.0+)
- Or **Google Cloud Memorystore for Valkey**
- Python >= 3.11

## Installation

```bash
pip install betterdb-semantic-cache
# With OpenAI embeddings:
pip install betterdb-semantic-cache[openai]
# All extras:
pip install betterdb-semantic-cache[all]
```

## Quick start

```python
import asyncio
import valkey.asyncio as valkey
from betterdb_semantic_cache import SemanticCache, SemanticCacheOptions
from betterdb_semantic_cache.embed.openai import create_openai_embed

async def main():
    client = valkey.Valkey(host="localhost", port=6399)
    cache = SemanticCache(SemanticCacheOptions(
        client=client,
        embed_fn=create_openai_embed(),  # text-embedding-3-small by default
        default_threshold=0.12,
    ))
    await cache.initialize()

    await cache.store("What is the capital of France?", "Paris")

    result = await cache.check("Capital city of France?")
    # result.hit == True
    # result.response == "Paris"
    # result.cost_saved == 0.000105 (based on bundled LiteLLM prices)

asyncio.run(main())
```

## Configuration reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | `str` | `'betterdb_scache'` | Index name prefix for all Valkey keys |
| `client` | `valkey.asyncio.Valkey` | *required* | A valkey-py async client instance |
| `embed_fn` | `Callable[[str], Awaitable[list[float]]]` | *required* | Async embedding function |
| `default_threshold` | `float` | `0.1` | Cosine distance threshold (0–2) |
| `default_ttl` | `int \| None` | `None` | Default TTL in seconds |
| `category_thresholds` | `dict[str, float]` | `{}` | Per-category threshold overrides |
| `uncertainty_band` | `float` | `0.05` | Width of the uncertainty band below threshold |
| `cost_table` | `dict[str, ModelCost]` | `{}` | Custom model pricing overrides |
| `use_default_cost_table` | `bool` | `True` | Merge bundled LiteLLM price table |
| `embedding_cache.enabled` | `bool` | `True` | Cache computed embeddings in Valkey |
| `embedding_cache.ttl` | `int` | `86400` | Embedding cache TTL in seconds |
| `telemetry.tracer_name` | `str` | `'betterdb-semantic-cache'` | OTel tracer name |
| `telemetry.metrics_prefix` | `str` | `'semantic_cache'` | Prometheus metric name prefix |
| `config_refresh.enabled` | `bool` | `True` | Periodically re-read threshold config from Valkey |
| `config_refresh.interval_ms` | `int` | `30000` | Refresh interval in milliseconds (min: 1000) |
| `discovery.enabled` | `bool` | `True` | Register cache in Valkey for BetterDB Monitor |
| `discovery.heartbeat_interval_ms` | `int` | `30000` | Heartbeat interval in milliseconds |

## Adapters

All adapters are submodule imports with optional peer dependencies.

### LangChain

```python
from betterdb_semantic_cache.adapters.langchain import BetterDBSemanticCache
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(cache=BetterDBSemanticCache(cache=cache))
```

### OpenAI Chat Completions

```python
from betterdb_semantic_cache.adapters.openai import prepare_semantic_params

text, model = prepare_semantic_params(params)
result = await cache.check(text)
```

### OpenAI Responses API

```python
from betterdb_semantic_cache.adapters.openai_responses import prepare_semantic_params

text = prepare_semantic_params(params)
```

### Anthropic Messages

```python
from betterdb_semantic_cache.adapters.anthropic import prepare_semantic_params

text = prepare_semantic_params(params)
```

### LlamaIndex

```python
from betterdb_semantic_cache.adapters.llamaindex import prepare_semantic_params

text = prepare_semantic_params(messages, model="gpt-4o")
```

### LangGraph (semantic memory store)

```python
from betterdb_semantic_cache.adapters.langgraph import BetterDBSemanticStore

store = BetterDBSemanticStore(cache=cache)
await store.put(("user", "alice", "memories"), "mem1", {"content": "Alice lives in Paris."})
results = await store.search(("user", "alice", "memories"), query="Where does Alice live?")
```

## Embedding helpers

Pre-built `EmbedFn` factories for common providers:

```python
from betterdb_semantic_cache.embed.openai import create_openai_embed
from betterdb_semantic_cache.embed.bedrock import create_bedrock_embed
from betterdb_semantic_cache.embed.voyage import create_voyage_embed
from betterdb_semantic_cache.embed.cohere import create_cohere_embed
from betterdb_semantic_cache.embed.ollama import create_ollama_embed
```

| Helper | Model default | Dimensions |
|---|---|---|
| `create_openai_embed` | `text-embedding-3-small` | 1536 |
| `create_bedrock_embed` | `amazon.titan-embed-text-v2:0` | 1024 |
| `create_voyage_embed` | `voyage-3-lite` | 512 |
| `create_cohere_embed` | `embed-english-v3.0` | 1024 |
| `create_ollama_embed` | `nomic-embed-text` | 768 |

## LLM-as-judge

When a hit lands in the uncertainty band (`threshold - uncertainty_band < score <= threshold`), supply a `judge_fn` to adjudicate automatically:

```python
from betterdb_semantic_cache.types import CacheCheckOptions, JudgeOptions

result = await cache.check(user_prompt, CacheCheckOptions(
    judge=JudgeOptions(
        judge_fn=my_judge,
        on_error="accept",   # fail-open on judge errors (default)
        timeout_ms=2000,     # per-call timeout (default)
    )
))
```

A minimal OpenAI judge:

```python
from openai import AsyncOpenAI

openai_client = AsyncOpenAI()

async def my_judge(ctx: dict) -> bool:
    # ctx keys: prompt, response, similarity, threshold, category
    # Return True to accept (confidence → 'high')
    # Return False to reject (treated as miss)
    resp = await openai_client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": "Reply YES or NO only."},
            {"role": "user", "content": (
                f"Does this cached response correctly answer the prompt?\n"
                f"Prompt: {ctx['prompt']}\nResponse: {ctx['response']}"
            )},
        ],
    )
    return (resp.choices[0].message.content or "").startswith("YES")
```

The judge is only invoked for uncertain hits. High-confidence hits, misses, and no-candidate cases bypass it entirely. When both `rerank` and `judge` are set, the judge runs on the reranked pick.

## Rerank hook

Retrieve top-k candidates and select the best with a custom function:

```python
from betterdb_semantic_cache.types import CacheCheckOptions, RerankOptions

async def my_rerank(query: str, candidates: list[dict]) -> int:
    # Return index of best candidate, or -1 to reject all
    return 0

result = await cache.check(prompt, CacheCheckOptions(
    rerank=RerankOptions(k=5, rerank_fn=my_rerank),
))
```

## Cost tracking

Store token counts alongside responses to enable cost savings reporting:

```python
from betterdb_semantic_cache.types import CacheStoreOptions

await cache.store("What is the capital of France?", "Paris", CacheStoreOptions(
    model="gpt-4o",
    input_tokens=25,
    output_tokens=5,
))

result = await cache.check("Capital of France?")
# result.cost_saved == 0.000105 on hit

stats = await cache.stats()
# stats.cost_saved_micros == 105 (microdollars)
```

Cost is computed using the bundled LiteLLM price table. Override or extend with the `cost_table` option.

## Threshold effectiveness

Analyze the rolling similarity score window for threshold tuning guidance:

```python
analysis = await cache.threshold_effectiveness(min_samples=100)
# analysis.recommendation: 'tighten_threshold' | 'loosen_threshold' | 'optimal' | 'insufficient_data'
# analysis.recommended_threshold: 0.085 (present when actionable)
# analysis.reasoning: 'Human-readable explanation'
```

When [BetterDB Monitor](https://betterdb.com) is connected, this data feeds into the Monitor's self-tuning loop — the Monitor reads the similarity window, generates proposals with reasoning, and writes approved threshold changes back to Valkey. The SDK picks them up via `config_refresh`.

## Batch check

Pipeline multiple lookups in a single round-trip:

```python
results = await cache.check_batch([
    "What is the capital of France?",
    "Who wrote Hamlet?",
    "What is 2 + 2?",
])
# results[0].hit == True, etc.
```

`check_batch()` does not support `judge`. Call `check()` individually for prompts that need adjudication.

## Config refresh and discovery

**Config refresh** (enabled by default): every 30 seconds the cache re-reads `{name}:__config` from Valkey and updates the in-memory threshold. When BetterDB Monitor approves a threshold proposal, the running cache picks it up without a restart.

**Discovery** (enabled by default): on `initialize()` the cache registers itself in the `__betterdb:caches` hash and writes a periodic heartbeat. BetterDB Monitor uses this to enumerate live caches for health monitoring and threshold recommendations.

```python
from betterdb_semantic_cache.types import ConfigRefreshOptions, DiscoveryOptions

cache = SemanticCache(SemanticCacheOptions(
    ...,
    config_refresh=ConfigRefreshOptions(enabled=True, interval_ms=30_000),
    discovery=DiscoveryOptions(enabled=True, heartbeat_interval_ms=30_000),
))
```

## Telemetry

The published wheel includes anonymous product analytics powered by PostHog. When enabled, aggregate usage statistics (hit rate, cost saved) are collected on a per-instance basis — no prompt text, responses, or personally-identifiable information is ever sent.

To opt out:

```bash
export BETTERDB_TELEMETRY=false   # also accepts: 0, no, off
```

Or programmatically:

```python
from betterdb_semantic_cache.types import AnalyticsOptions

cache = SemanticCache(SemanticCacheOptions(
    ...,
    analytics=AnalyticsOptions(disabled=True),
))
```

## Interoperability with the TypeScript package

The Python and TypeScript packages use the same Valkey data format: same index schema, same `__config` hash, same `__similarity_window` sorted set, same `__stats` hash. A cache created by one can be read and written by the other. BetterDB Monitor treats them identically.

This means you can:
- Store responses from a Python service and serve them from a TypeScript edge function
- Run the TypeScript package in production and the Python package in your benchmark harness
- Use either language for batch migration or data inspection tools
