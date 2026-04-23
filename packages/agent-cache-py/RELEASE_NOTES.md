# betterdb-agent-cache v0.4.0

Python port of `@betterdb/agent-cache`. Multi-tier exact-match cache for AI agent
workloads backed by Valkey — LLM responses, tool results, and session state, with
built-in OpenTelemetry and Prometheus instrumentation.

Runs on vanilla Valkey 7+. No modules, no RedisJSON, no RediSearch. Works on
ElastiCache for Valkey, Memorystore for Valkey, and MemoryDB.

---

## Installation

```sh
pip install betterdb-agent-cache
```

Optional extras install the provider SDKs alongside the library:

```sh
pip install "betterdb-agent-cache[openai]"
pip install "betterdb-agent-cache[anthropic]"
pip install "betterdb-agent-cache[langchain]"
pip install "betterdb-agent-cache[langgraph]"
pip install "betterdb-agent-cache[llamaindex]"
```

---

## What's included

### Three cache tiers

| Tier | Use for |
|---|---|
| `cache.llm` | LLM API responses — `check` / `store` / `store_multipart` / `invalidate_by_model` |
| `cache.tool` | Tool call results — `check` / `store` / `set_policy` / `invalidate_by_tool` |
| `cache.session` | Agent session state — `get` / `set` / `get_all` / `destroy_thread` / `touch` |

### Provider adapters

| Import | Provider |
|---|---|
| `betterdb_agent_cache.adapters.openai` | OpenAI Chat Completions |
| `betterdb_agent_cache.adapters.openai_responses` | OpenAI Responses API |
| `betterdb_agent_cache.adapters.anthropic` | Anthropic Messages |
| `betterdb_agent_cache.adapters.llamaindex` | LlamaIndex |
| `betterdb_agent_cache.adapters.langchain` | LangChain `BaseCache` |
| `betterdb_agent_cache.adapters.langgraph` | LangGraph `BaseCheckpointSaver` |

### Bundled default cost table

A default cost table sourced from [LiteLLM's `model_prices_and_context_window.json`](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json)
is bundled with the package and refreshed on every release. Cost tracking works out of
the box for 1,900+ models — no `cost_table` configuration required.

User-supplied `cost_table` entries are merged on top of the defaults, so you can
override a single model without losing coverage for everything else:

```python
cache = AgentCache(AgentCacheOptions(
    client=client,
    cost_table={"gpt-4o": ModelCost(input_per_1k=0.002, output_per_1k=0.008)},
))
```

To disable the default table entirely:

```python
cache = AgentCache(AgentCacheOptions(
    client=client,
    use_default_cost_table=False,
    cost_table={...},
))
```

The bundled table is also exported directly if you need to inspect it:

```python
from betterdb_agent_cache import DEFAULT_COST_TABLE
```

### Pluggable binary normalizer

Controls how binary content (images, audio, documents) is reduced to a stable string
before hashing. Zero-latency by default — no network calls.

```python
from betterdb_agent_cache import compose_normalizer, hash_base64

normalizer = compose_normalizer({"base64": hash_base64})
```

### Observability

- OpenTelemetry spans on every cache operation
- Prometheus counters, histograms, and gauges: `requests_total`, `operation_duration_seconds`,
  `cost_saved_total`, `stored_bytes_total`, `active_sessions`

### Cluster support

Pass a `ValkeyCluster` client and all SCAN-based operations (`flush`, `invalidate_by_model`,
`invalidate_by_tool`, `destroy_thread`, `touch`) automatically iterate all master nodes.

---

## Quick start

Cost tracking is pre-defined for 1,900+ models — no pricing configuration needed.

```python
import asyncio
import valkey.asyncio as valkey_client
from betterdb_agent_cache import AgentCache, TierDefaults
from betterdb_agent_cache.adapters.openai import prepare_params
from betterdb_agent_cache.types import AgentCacheOptions

client = valkey_client.Valkey(host="localhost", port=6379)
cache = AgentCache(AgentCacheOptions(
    client=client,
    tier_defaults={"llm": TierDefaults(ttl=3600)},
    # cost_table is pre-defined for GPT-4o, Claude, Gemini, and 1,900+ others
))

async def main():
    params = await prepare_params({
        "model": "gpt-4o-mini",
        "messages": [{"role": "user", "content": "What is 2+2?"}],
    })

    result = await cache.llm.check(params)
    if result.hit:
        print("Cache hit:", result.response)
    else:
        # ... call OpenAI ...
        await cache.llm.store(params, "Four")

asyncio.run(main())
```

---

## Full changelog

See [CHANGELOG.md](./CHANGELOG.md) for detailed history.
