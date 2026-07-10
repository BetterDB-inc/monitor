---
layout: default
title: Agent Cache (Python)
parent: Packages
nav_order: 3
---

# Agent Cache (Python)

`betterdb-agent-cache` is the Python counterpart to [`@betterdb/agent-cache`](/docs/packages/agent-cache). Same architecture, same three cache tiers, same Valkey key format, same Monitor integration — different language. A TypeScript app and a Python app can share the same cache. It pairs with [`betterdb-agent-memory`](/docs/packages/agent-memory-python) as the short-term (llm/tool/session) cache layer.

For the full design rationale (tradeoffs, storage layout, cluster behavior), see the [TypeScript page](/docs/packages/agent-cache) — this page focuses on Python usage and the Python-only differences.

## Prerequisites

- **Valkey 7+** or Redis 6.2+ (no modules, no RediSearch, no RedisJSON)
- Or **Amazon ElastiCache for Valkey / Redis**
- Or **Google Cloud Memorystore for Valkey**
- Or **Amazon MemoryDB**
- Python >= 3.11

## Installation

```bash
pip install betterdb-agent-cache
```

Optional extras install the provider/framework SDKs alongside the library:

```bash
pip install "betterdb-agent-cache[openai]"
pip install "betterdb-agent-cache[anthropic]"
pip install "betterdb-agent-cache[langchain]"
pip install "betterdb-agent-cache[langgraph]"
pip install "betterdb-agent-cache[llamaindex]"
pip install "betterdb-agent-cache[openai_agents]"
pip install "betterdb-agent-cache[pydantic_ai]"
# Everything:
pip install "betterdb-agent-cache[all]"
```

## Quick start

```python
import asyncio
import json
import valkey.asyncio as valkey_client
from betterdb_agent_cache import AgentCache, TierDefaults
from betterdb_agent_cache.types import AgentCacheOptions

client = valkey_client.Valkey(host="localhost", port=6379)

cache = AgentCache(AgentCacheOptions(
    client=client,
    tier_defaults={
        "llm":     TierDefaults(ttl=3600),
        "tool":    TierDefaults(ttl=300),
        "session": TierDefaults(ttl=1800),
    },
    # cost_table is pre-loaded for GPT-4o, Claude, Gemini, and 1,900+ others
))

async def main():
    # LLM response caching
    params = {
        "model": "gpt-4o",
        "messages": [{"role": "user", "content": "What is Valkey?"}],
        "temperature": 0,
    }
    result = await cache.llm.check(params)
    if not result.hit:
        response = await call_llm(params)
        await cache.llm.store(params, response)

    # Tool result caching
    weather = await cache.tool.check("get_weather", {"city": "Sofia"})
    if not weather.hit:
        data = await get_weather(city="Sofia")
        await cache.tool.store("get_weather", {"city": "Sofia"}, json.dumps(data))

    # Session state
    await cache.session.set("thread-1", "last_intent", "book_flight")
    intent = await cache.session.get("thread-1", "last_intent")

asyncio.run(main())
```

The client owns the connection lifecycle — `AgentCache` does not open or close it, and there is no separate `initialize()` step.

## Configuration reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `client` | `valkey.asyncio.Valkey` \| `ValkeyCluster` | *required* | Valkey async client instance |
| `name` | `str` | `'betterdb_ac'` | Key prefix for all Valkey keys |
| `default_ttl` | `int \| None` | `None` | Default TTL in seconds. `None` = no expiry |
| `tier_defaults["llm"].ttl` | `int \| None` | `None` | Default TTL for LLM cache entries |
| `tier_defaults["tool"].ttl` | `int \| None` | `None` | Default TTL for tool cache entries |
| `tier_defaults["session"].ttl` | `int \| None` | `None` | Default TTL for session entries |
| `cost_table` | `dict[str, ModelCost]` | `{}` | Model pricing overrides. Merged on top of the built-in default table |
| `use_default_cost_table` | `bool` | `True` | Use bundled default cost table sourced from LiteLLM. Set to `False` to disable |
| `telemetry.tracer_name` | `str` | `'@betterdb/agent-cache'` | OpenTelemetry tracer name |
| `telemetry.metrics_prefix` | `str` | `'agent_cache'` | Prometheus metric name prefix |
| `telemetry.registry` | `CollectorRegistry \| None` | default registry | `prometheus_client` registry to register metrics on |

### ModelCost format

```python
from betterdb_agent_cache import ModelCost

cost_table = {
    "gpt-4o":      ModelCost(input_per_1k=0.0025, output_per_1k=0.01),
    "gpt-4o-mini": ModelCost(input_per_1k=0.00015, output_per_1k=0.0006),
}
```

A default cost table sourced from LiteLLM's `model_prices_and_context_window.json` is bundled and refreshed on every release, so cost tracking works out of the box for 1,900+ models. `cost_table` entries override defaults for matching keys; set `use_default_cost_table=False` to disable the defaults entirely.

## Cache tiers

Three tiers behind one connection, all `async`. Method names are the Python (`snake_case`) equivalents of the [TypeScript API](/docs/packages/agent-cache#cache-tiers).

### LLM cache — `cache.llm`

```python
# Check for a cached response
result = await cache.llm.check(params)

# Store a response with token counts for cost tracking
await cache.llm.store(params, response, LlmStoreOptions(tokens={"input": 10, "output": 50}))

# Store a multi-part response (text + tool calls)
await cache.llm.store_multipart(params, blocks, LlmStoreOptions(...))

# Invalidate all entries for a model
deleted = await cache.llm.invalidate_by_model("gpt-4o")
```

### Tool cache — `cache.tool`

```python
result  = await cache.tool.check("get_weather", {"city": "Sofia"})
await cache.tool.store("get_weather", {"city": "Sofia"}, json_result, ToolStoreOptions(ttl=300, cost=0.001))
await cache.tool.set_policy("get_weather", ToolPolicy(ttl=600))
deleted = await cache.tool.invalidate_by_tool("get_weather")
existed = await cache.tool.invalidate("get_weather", {"city": "Sofia"})
```

### Session store — `cache.session`

Key-value storage for agent session state with a sliding-window TTL (fields are individual Valkey keys, enabling per-field TTL).

```python
await cache.session.set("thread-1", "last_intent", "book_flight")
intent  = await cache.session.get("thread-1", "last_intent")   # refreshes TTL on hit
allf    = await cache.session.get_all("thread-1")
await cache.session.delete("thread-1", "last_intent")
deleted = await cache.session.destroy_thread("thread-1")       # includes LangGraph checkpoints
await cache.session.touch("thread-1")
```

## Stats and self-optimization

```python
stats = await cache.stats()
# AgentCacheStats(llm=TierStats(hits=..., misses=...), tool=..., session=...,
#                 cost_saved_micros=..., per_tool={...})

ranked = await cache.tool_effectiveness()
# [ToolEffectivenessEntry(tool="get_weather", hit_rate=0.85, cost_saved=5.00,
#                         recommendation="increase_ttl"), ...]
```

## Adapters

All adapters are submodule imports under `betterdb_agent_cache.adapters` with optional peer dependencies. The `prepare_params(...)` adapters normalize provider request shapes into `LlmCacheParams` that you pass to `cache.llm.check()` / `store()`; the `BetterDB*` classes plug directly into a framework's cache/checkpoint interface.

| Adapter | Import | Kind |
|---|---|---|
| OpenAI Chat Completions | `adapters.openai` | `prepare_params` |
| OpenAI Responses API | `adapters.openai_responses` | `prepare_params` |
| OpenAI Agents SDK | `adapters.openai_agents` | `CachedModel` / `CachedModelProvider` |
| Anthropic Messages | `adapters.anthropic` | `prepare_params` |
| LlamaIndex | `adapters.llamaindex` | `prepare_params` |
| LangChain | `adapters.langchain` | `BetterDBLlmCache` |
| LangGraph | `adapters.langgraph` | `BetterDBSaver` |
| Pydantic AI | `adapters.pydantic_ai` | `CachedModel` |

> **Note on parity:** the Python package ships the **OpenAI Agents SDK** and **Pydantic AI** adapters, which have no TypeScript equivalents (both frameworks are Python-only). Conversely, the TypeScript package ships a **Vercel AI SDK** adapter, which is JavaScript-only. Every other adapter exists in both languages.

### OpenAI Chat Completions

```python
from betterdb_agent_cache.adapters.openai import prepare_params

cache_params = await prepare_params(openai_params)
result = await cache.llm.check(cache_params)
```

### OpenAI Responses API

```python
from betterdb_agent_cache.adapters.openai_responses import prepare_params

cache_params = await prepare_params(responses_params)
```

### OpenAI Agents SDK

Caches at the Agents SDK `Model.get_response()` level, so agent workloads that replay the same tool-call sequences (evaluation, testing, multi-agent orchestration) skip the API entirely. Requires the `openai-agents` peer dependency (`pip install "betterdb-agent-cache[openai_agents]"`).

**Recommended — wrap the model provider** so every model an agent run resolves is cache-enabled:

```python
from agents import Agent, Runner, RunConfig
from betterdb_agent_cache.adapters.openai_agents import CachedModelProvider

cached_provider = CachedModelProvider(provider, cache=cache)

result = await Runner.run(
    agent,
    "Hello",
    run_config=RunConfig(model_provider=cached_provider),
)
```

**Or wrap a single model directly:**

```python
from agents import Agent
from agents.models.openai_chatcompletions import OpenAIChatCompletionsModel
from betterdb_agent_cache.adapters.openai_agents import CachedModel

base_model = OpenAIChatCompletionsModel(model="gpt-4o", openai_client=client)
agent = Agent(name="Assistant", model=CachedModel(base_model, cache=cache))
```

`get_response()` is checked against the cache before calling the model and stored on a miss (fail-open: a store failure logs and returns the live response, never crashing the run). `stream_response()` is delegated uncached, matching the BetterDB streaming convention. Tools, handoffs, `output_schema`, and server-side context references (`previous_response_id`, `conversation_id`) are excluded from the cache key — safe when one `CachedModel` wraps a single agent whose tools don't change between calls. If server-side context affects your responses, use a separate `CachedModel` per conversation thread.

### Pydantic AI

Wraps any Pydantic AI `Model` and intercepts `request()` for cache-before-call semantics, storing on a miss. Requires the `pydantic-ai-slim` peer dependency (`pip install "betterdb-agent-cache[pydantic_ai]"`).

```python
from pydantic_ai import Agent
from pydantic_ai.models.openai import OpenAIModel
from betterdb_agent_cache.adapters.pydantic_ai import CachedModel

base_model = OpenAIModel("gpt-4o")
agent = Agent(model=CachedModel(base_model, cache=cache))
```

The message history is normalized into a stable cache key across all Pydantic AI part types (system/instruction, user prompt, text, tool call, tool return, retry); `ThinkingPart` is dropped as non-deterministic, and `ImageUrl` / `BinaryContent` are routed through the binary normalizer so blobs become compact refs rather than raw base64. On a hit the response is reconstructed (text or tool calls) with the stored token counts and the underlying model is not called; everything the wrapper doesn't intercept is delegated via `__getattr__`. `model_request_parameters` (tool schemas) is excluded from the cache key — safe when one `CachedModel` wraps a single `Agent` whose tools don't change between calls. `prepare_params` is also exposed for manual cache control.

### Anthropic Messages

```python
from betterdb_agent_cache.adapters.anthropic import prepare_params

cache_params = await prepare_params(anthropic_params)
```

### LlamaIndex

```python
from betterdb_agent_cache.adapters.llamaindex import prepare_params

cache_params = await prepare_params(messages)
```

### LangChain

```python
from betterdb_agent_cache.adapters.langchain import BetterDBLlmCache
from langchain_openai import ChatOpenAI

model = ChatOpenAI(model="gpt-4o-mini", cache=BetterDBLlmCache(cache=cache))
```

### LangGraph

Works on vanilla Valkey 7+ with no modules. Unlike `langgraph-checkpoint-redis`, it does not require Redis 8.0+, RedisJSON, or RediSearch.

```python
from betterdb_agent_cache.adapters.langgraph import BetterDBSaver
from langgraph.graph import StateGraph

checkpointer = BetterDBSaver(cache=cache)
graph = StateGraph(schema).add_node("agent", agent_node).compile(checkpointer=checkpointer)
```

## Binary normalizer

Controls how binary content (images, audio, documents) is reduced to a stable string before hashing. Zero-latency by default — no network calls.

```python
from betterdb_agent_cache import compose_normalizer, hash_base64, fetch_and_hash

normalizer = compose_normalizer({"base64": hash_base64})     # hash base64 bytes
normalizer = compose_normalizer({"url": fetch_and_hash})     # fetch + hash URLs (needs aiohttp)
```

## Cluster support

Pass a `ValkeyCluster` client and all SCAN-based operations (`flush`, `invalidate_by_model`, `invalidate_by_tool`, `destroy_thread`, `touch`) automatically iterate all master nodes. No configuration changes needed.

```python
from valkey.asyncio.cluster import ValkeyCluster

client = ValkeyCluster(host="my-cluster.example.com", port=6379)
cache = AgentCache(AgentCacheOptions(client=client))
```

## Observability

Every public method emits an OpenTelemetry span (snake_case names, e.g. `agent_cache.llm.check`, `agent_cache.session.destroy_thread`) and updates Prometheus metrics prefixed with `agent_cache_` (configurable via `telemetry.metrics_prefix`). Spans require an OpenTelemetry SDK configured in the host application. See the [TypeScript page](/docs/packages/agent-cache#observability) for the full span and metric tables — the names match.

## BetterDB Monitor integration

Connect [BetterDB Monitor](https://betterdb.com) to the same Valkey instance and it will automatically detect the agent cache stats hash (`{name}:__stats`) and surface hit rates, cost savings, and per-tool effectiveness in the dashboard. No additional configuration is required.

## Known limitations

- **Session `get_all()`** is SCAN-based — fine for dozens of fields per thread; consider a Redis HASH for thousands.
- **LangGraph `list()`** loads all checkpoint data for a thread into memory before filtering. For millions of checkpoints, use `langgraph-checkpoint-redis` with Redis 8+ instead.
- **`active_sessions` gauge** is approximate and does not survive process restarts.
- **Streaming responses** are not cached by any Python adapter — accumulate the full response before storing. (The TypeScript Vercel AI SDK adapter is the only one that caches streams.)
