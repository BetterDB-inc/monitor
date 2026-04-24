# betterdb-semantic-cache v0.1.0

Python port of `@betterdb/semantic-cache`. Embeddings-based semantic cache for AI
workloads backed by Valkey vector search — similarity matching, cost tracking,
multi-modal prompts, embedding cache, and threshold tuning, with built-in
OpenTelemetry and Prometheus instrumentation.

Requires Valkey 8+ with the **valkey-search** module (vector index support).
Works with ElastiCache for Valkey, Memorystore for Valkey, and MemoryDB.

---

## Installation

```sh
pip install betterdb-semantic-cache
```

Optional extras install the provider SDKs alongside the library:

```sh
pip install "betterdb-semantic-cache[openai]"
pip install "betterdb-semantic-cache[anthropic]"
pip install "betterdb-semantic-cache[langchain]"
pip install "betterdb-semantic-cache[langgraph]"
pip install "betterdb-semantic-cache[llamaindex]"
pip install "betterdb-semantic-cache[httpx]"   # voyage / cohere / ollama embed helpers
pip install "betterdb-semantic-cache[bedrock]"  # AWS Bedrock embed helper
```

---

## What's included

### SemanticCache

| Method | Description |
|---|---|
| `initialize()` | Create or attach to the vector index |
| `check(prompt)` | Similarity lookup — returns hit/miss with confidence and optional cost saved |
| `store(prompt, response)` | Store a response with optional cost metadata |
| `store_multipart(prompt, blocks)` | Store structured content blocks |
| `check_batch(prompts)` | Pipelined batch lookup |
| `invalidate(filter)` | Delete entries matching a FT.SEARCH filter |
| `invalidate_by_model(model)` | Delete all entries for a model |
| `invalidate_by_category(category)` | Delete all entries in a category |
| `stats()` | Hit/miss counts and cumulative cost saved |
| `index_info()` | Index name, doc count, vector dimension |
| `threshold_effectiveness()` | Rolling window analysis and threshold recommendations |
| `threshold_effectiveness_all()` | Per-category analysis |
| `flush()` | Drop index and delete all cached entries |

### Provider adapters

| Import | Provider |
|---|---|
| `betterdb_semantic_cache.adapters.openai` | OpenAI Chat Completions |
| `betterdb_semantic_cache.adapters.openai_responses` | OpenAI Responses API |
| `betterdb_semantic_cache.adapters.anthropic` | Anthropic Messages |
| `betterdb_semantic_cache.adapters.llamaindex` | LlamaIndex `ChatMessage[]` |
| `betterdb_semantic_cache.adapters.langchain` | LangChain `BaseCache` (async-only) |
| `betterdb_semantic_cache.adapters.langgraph` | LangGraph `BetterDBSemanticStore` |

### Embedding helpers

| Import | Provider |
|---|---|
| `embed.openai` | OpenAI Embeddings API |
| `embed.voyage` | Voyage AI (httpx, no SDK required) |
| `embed.cohere` | Cohere Embed v3 (httpx, no SDK required) |
| `embed.ollama` | Ollama local models (httpx, no SDK required) |
| `embed.bedrock` | AWS Bedrock Titan / Cohere (boto3) |

### Bundled default cost table

A default cost table sourced from [LiteLLM's `model_prices_and_context_window.json`](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json)
is bundled and refreshed on every release. Cost savings tracking works out of the
box for 1,900+ models — no `cost_table` configuration required.

### Observability

- OpenTelemetry spans on every cache operation
- Prometheus metrics: `requests_total`, `similarity_score`, `operation_duration_seconds`,
  `embedding_duration_seconds`, `cost_saved_total`, `embedding_cache_total`,
  `stale_model_evictions_total`

### Cluster support

Pass a `ValkeyCluster` client and all SCAN-based operations (`flush`,
`invalidate_by_model`, `invalidate_by_category`) automatically iterate all master nodes.

---

## Quick start

```python
import asyncio
import valkey.asyncio as valkey
from betterdb_semantic_cache import SemanticCache, SemanticCacheOptions
from betterdb_semantic_cache.types import CacheStoreOptions
from embed.openai import create_openai_embed

client = valkey.Valkey(host="localhost", port=6379)
cache = SemanticCache(SemanticCacheOptions(
    client=client,
    embed_fn=create_openai_embed(),
    default_threshold=0.12,
))

async def main():
    await cache.initialize()

    result = await cache.check("What is the capital of France?")
    if result.hit:
        print("Cache hit:", result.response)
    else:
        answer = "Paris"  # ... call your LLM ...
        await cache.store(
            "What is the capital of France?", answer,
            CacheStoreOptions(model="gpt-4o", input_tokens=20, output_tokens=5),
        )

asyncio.run(main())
```

---

## Full changelog

See [CHANGELOG.md](./CHANGELOG.md) for detailed history.
