# betterdb-semantic-cache v0.1.0

Initial release. Full Python port of `@betterdb/semantic-cache` v0.2.0 — async-first,
dataclass config, feature-for-feature parity with the TypeScript implementation.

Requires Python 3.11+, Valkey 8+ with the **valkey-search** module.
Works with ElastiCache for Valkey, Memorystore for Valkey, and MemoryDB.

## Installation

```sh
pip install betterdb-semantic-cache
```

Install optional extras alongside the library:

```sh
pip install "betterdb-semantic-cache[openai]"
pip install "betterdb-semantic-cache[anthropic]"
pip install "betterdb-semantic-cache[langchain]"
pip install "betterdb-semantic-cache[langgraph]"
pip install "betterdb-semantic-cache[llamaindex]"
pip install "betterdb-semantic-cache[httpx]"     # Voyage AI, Cohere, Ollama
pip install "betterdb-semantic-cache[bedrock]"   # AWS Bedrock
pip install "betterdb-semantic-cache[all]"       # everything above
```

---

## Adapters

Six adapters extract the semantic cache key from provider-specific request objects.
All return a `SemanticParams` dataclass with `text`, `blocks`, and `model` fields.

### OpenAI Chat Completions

```python
from betterdb_semantic_cache.adapters.openai import prepare_semantic_params

params = {
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "What is the capital of France?"}],
}
sp = await prepare_semantic_params(params)

result = await cache.check(sp.blocks or sp.text)
if not result.hit:
    response = await openai_client.chat.completions.create(**params)
    await cache.store(sp.blocks or sp.text, response.choices[0].message.content,
                      CacheStoreOptions(model=sp.model))
```

Handles text, `image_url` (URL and base64), `input_audio`, and `file` content parts.
Pass `normalizer=cache.normalizer` to share the same normalization strategy.

### OpenAI Responses API

```python
from betterdb_semantic_cache.adapters.openai_responses import prepare_semantic_params

sp = await prepare_semantic_params(params)
result = await cache.check(sp.blocks or sp.text)
```

Supports `input_text`, `input_image`, and `input_file` content parts.

### Anthropic Messages

```python
from betterdb_semantic_cache.adapters.anthropic import prepare_semantic_params

sp = await prepare_semantic_params(params)
result = await cache.check(sp.blocks or sp.text)
```

Supports text; base64, URL, and file images; base64, URL, plaintext, and file documents.

### LlamaIndex

```python
from betterdb_semantic_cache.adapters.llamaindex import prepare_semantic_params

sp = await prepare_semantic_params(messages, model="gpt-4o")
result = await cache.check(sp.text)
```

Extracts the last user `ChatMessage` from a list. Supports `text`, `image_url`,
`file`, `audio`, and `image` content parts.

### LangChain — async `BaseCache`

`BetterDBSemanticCache` implements LangChain's `BaseCache` interface. Because
`SemanticCache` is async-only, the synchronous `lookup()` / `update()` methods
return `None` / no-op; use `ainvoke` / `astream` to get real cache behaviour.

```python
from betterdb_semantic_cache.adapters.langchain import BetterDBSemanticCache
from langchain_openai import ChatOpenAI

lc_cache = BetterDBSemanticCache(cache)
llm = ChatOpenAI(model="gpt-4o", cache=lc_cache)

# Cache is transparent — hits are returned without calling the LLM
response = await llm.ainvoke("What is the capital of France?")
```

Optional `filter_by_model=True` scopes hits to a specific LLM configuration.

### LangGraph semantic memory store

`BetterDBSemanticStore` implements the LangGraph `BaseStore` interface using
vector similarity for retrieval. Use this for agent memory (finding the most
relevant past facts for a query), not for checkpoint persistence — use
`betterdb_agent_cache.adapters.langgraph` for that. Both can coexist on the
same Valkey instance with different key prefixes.

```python
from betterdb_semantic_cache.adapters.langgraph import BetterDBSemanticStore

store = BetterDBSemanticStore(cache, embed_field="content")

await store.aput(["user", "alice", "facts"], "pref_001", {
    "content": "Alice prefers async Python over synchronous code.",
})

results = await store.asearch(["user", "alice", "facts"],
                               query="What are Alice's coding preferences?",
                               limit=5)
# results[i].value — the stored dict; results[i].key — the item key
```

Full interface: `aput()`, `aget()`, `asearch()` (semantic KNN or namespace scan),
`adelete()`, `abatch()`.

---

## Embedding helpers

Five pre-built `EmbedFn` callables so you don't have to write your own:

| Import | Provider | Default model | Dimensions |
|---|---|---|---|
| `betterdb_semantic_cache.embed.openai` | OpenAI | `text-embedding-3-small` | 1536 |
| `betterdb_semantic_cache.embed.voyage` | Voyage AI | `voyage-3-lite` | 512 |
| `betterdb_semantic_cache.embed.cohere` | Cohere | `embed-english-v3.0` | 1024 |
| `betterdb_semantic_cache.embed.ollama` | Ollama (local) | `nomic-embed-text` | 768 |
| `betterdb_semantic_cache.embed.bedrock` | AWS Bedrock | `amazon.titan-embed-text-v2:0` | 1024 |

```python
from betterdb_semantic_cache.embed.openai import create_openai_embed
from betterdb_semantic_cache.embed.voyage import create_voyage_embed
from betterdb_semantic_cache.embed.ollama import create_ollama_embed

cache = SemanticCache(SemanticCacheOptions(
    client=client,
    embed_fn=create_voyage_embed(model="voyage-3-lite"),
))
```

The Voyage AI, Cohere, and Ollama helpers use `httpx` directly — no provider SDK
required. The httpx client is created once per helper instance and reused across
calls. Install: `pip install "betterdb-semantic-cache[httpx]"`.

---

## Core features

### Cost tracking + bundled model price table

Store token counts at cache time; get automatic cost-saved reporting on every hit.
A bundled `DEFAULT_COST_TABLE` covers 1,900+ models from
[LiteLLM](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json)
and is refreshed on every release. No configuration required for common models.

```python
await cache.store("Summarize this document", response_text,
                  CacheStoreOptions(model="gpt-4o", input_tokens=512, output_tokens=128))

result = await cache.check("Summarize this document")
print(result.cost_saved)        # e.g. 0.00385 — dollars saved on this hit

stats = await cache.stats()
print(stats.cost_saved_micros)  # cumulative across all hits
```

Override entries with `cost_table={...}`; disable with `use_default_cost_table=False`.

### Multi-modal prompts

`check()`, `store()`, and `store_multipart()` accept `str | list[ContentBlock]`.
A `ContentBlock` list embeds the text blocks and uses binary refs as an AND-filter —
a hit requires both semantic similarity on the text **and** all binary refs to match.

```python
from betterdb_semantic_cache.normalizer import hash_base64
from betterdb_semantic_cache.utils import TextBlock, BinaryBlock

prompt = [
    TextBlock(type="text", text="What is in this image?"),
    BinaryBlock(type="binary", kind="image", mediaType="image/png",
                ref=hash_base64(b64_data)),
]

await cache.store_multipart(prompt, [TextBlock(type="text", text="A red square.")])
result = await cache.check(prompt)  # hit requires both text match AND same image
if result.hit:
    print(result.content_blocks)    # the stored ContentBlock[] response
```

**Binary normalizer:** `compose_normalizer`, `hash_base64`, `hash_bytes`, `hash_url`,
and `fetch_and_hash` generate stable, compact refs for any binary source. The
`default_normalizer` hashes base64 and bytes rather than storing raw data in TAG
fields. Access the configured normalizer via `cache.normalizer`.

### Embedding cache

Computed embedding vectors are stored in Valkey (`{name}:embed:{sha256}`) and
reused on subsequent `check()` calls for the same text — `embed_fn` is only
called once per unique string.

```python
SemanticCache(SemanticCacheOptions(
    ...,
    embedding_cache=EmbeddingCacheOptions(enabled=True, ttl=86400),  # default
))
```

Prometheus counter: `{prefix}_embedding_cache_total` labelled `result: hit | miss`.

### Batch check — `check_batch()`

Embeds all prompts in parallel and pipelines all `FT.SEARCH` calls in a single
Valkey round-trip.

```python
results = await cache.check_batch([
    "What is the capital of France?",
    "Who wrote Hamlet?",
    "What is the speed of light?",
])
# results[i] is a CacheCheckResult — same shape as check()
```

### Rerank hook

Retrieve the top-k most similar candidates and apply custom ranking before
serving from cache.

```python
async def pick_longest(_query: str, candidates: list[dict]) -> int:
    return max(range(len(candidates)), key=lambda i: len(candidates[i]["response"]))

result = await cache.check(query, CacheCheckOptions(
    rerank=RerankOptions(k=5, rerank_fn=pick_longest),
))
```

Return `-1` from `rerank_fn` to reject all candidates (miss).

### Stale-model eviction

Automatically evict cached entries when you upgrade the LLM for a prompt category.
On a hit, if the stored model differs from `current_model`, the entry is deleted and
the call returns a miss.

```python
result = await cache.check(prompt, CacheCheckOptions(
    stale_after_model_change=True,
    current_model="gpt-4o",   # evict if entry was stored with gpt-3.5-turbo
))
```

Prometheus counter: `{prefix}_stale_model_evictions_total`.

### Threshold effectiveness recommendations

`threshold_effectiveness()` analyzes a rolling window of cosine distance scores
(up to 10,000 entries, 7-day retention) and returns a concrete recommendation:

```python
analysis = await cache.threshold_effectiveness(min_samples=100)
# ThresholdEffectivenessResult:
#   recommendation:         'tighten_threshold'
#   current_threshold:      0.1
#   recommended_threshold:  0.072
#   hit_rate:               0.83
#   uncertain_hit_rate:     0.31
#   reasoning:              '31.0% of hits are in the uncertainty band...'

all_results = await cache.threshold_effectiveness_all(min_samples=50)
# list[ThresholdEffectivenessResult] — one per category + aggregate
```

### Params-aware filtering

`temperature`, `top_p`, and `seed` are stored as NUMERIC fields on entries,
enabling opt-in filtering when sampling parameters affect correctness.

```python
await cache.store(prompt, response, CacheStoreOptions(temperature=0.0, seed=42))

result = await cache.check(prompt, CacheCheckOptions(
    filter="@temperature:[0 0] @seed:[42 42]",
))
```

### PostHog analytics

Aggregate usage statistics (hit rate, cost saved per instance) are reported to
PostHog when the wheel is built with a baked API key. No prompt text, responses,
or PII are sent.

**To opt out:**

```sh
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

Call `await cache.shutdown()` before process exit to flush queued events.

---

## Full `SemanticCache` API

| Method | Description |
|---|---|
| `await initialize()` | Create or attach to the vector index |
| `await check(prompt, opts?)` | Similarity lookup — hit/miss with confidence, similarity score, optional cost saved |
| `await store(prompt, response, opts?)` | Store a response with optional cost metadata |
| `await store_multipart(prompt, blocks, opts?)` | Store a structured `ContentBlock` list as the response |
| `await check_batch(prompts, opts?)` | Pipelined multi-prompt lookup |
| `await invalidate(filter)` | Delete entries matching an FT.SEARCH filter |
| `await invalidate_by_model(model)` | Delete all entries tagged with a model name |
| `await invalidate_by_category(category)` | Delete all entries in a category |
| `await stats()` | Hit/miss counts and cumulative cost saved |
| `await index_info()` | Index name, doc count, vector dimension |
| `await threshold_effectiveness(min_samples?)` | Threshold tuning analysis |
| `await threshold_effectiveness_all(min_samples?)` | Per-category + aggregate analysis |
| `await flush()` | Drop index and delete all cached entries |
| `await shutdown()` | Stop stats timer and flush analytics queue |

### Key `SemanticCacheOptions` fields

| Field | Default | Description |
|---|---|---|
| `client` | required | `valkey.asyncio.Valkey` or `ValkeyCluster` |
| `embed_fn` | required | Async callable `(str) → list[float]` |
| `default_threshold` | `0.1` | Cosine distance threshold (0–2, lower = stricter) |
| `default_ttl` | `None` | Entry TTL in seconds |
| `category_thresholds` | `{}` | Per-category threshold overrides |
| `uncertainty_band` | `0.05` | Distance band below threshold that returns `confidence='uncertain'` |
| `use_default_cost_table` | `True` | Merge bundled LiteLLM prices |
| `embedding_cache` | `EmbeddingCacheOptions(enabled=True, ttl=86400)` | Embed vector caching |
| `normalizer` | `default_normalizer` | Binary content normalizer (accessible as `cache.normalizer`) |
| `analytics` | `AnalyticsOptions()` | PostHog analytics config |

---

## Observability

Seven Prometheus metrics, all labelled with `cache_name`:

| Metric | Labels | Description |
|---|---|---|
| `{prefix}_requests_total` | `result`, `category` | Hit / uncertain_hit / miss counts |
| `{prefix}_similarity_score` | `category` | Cosine distance histogram |
| `{prefix}_operation_duration_seconds` | `operation` | Per-operation latency |
| `{prefix}_embedding_duration_seconds` | — | `embed_fn` call latency |
| `{prefix}_cost_saved_total` | `category` | Dollars saved on hits |
| `{prefix}_embedding_cache_total` | `result` | Embedding cache hit / miss |
| `{prefix}_stale_model_evictions_total` | — | Stale-model eviction count |

OpenTelemetry spans are created for every cache operation with `cache.hit`,
`cache.similarity`, `cache.threshold`, `cache.confidence`, and `cache.category`
attributes. Pass a custom `registry` in `TelemetryOptions` to isolate metrics
from the host application's default registry.

---

## 12 runnable examples

```
examples/basic/            examples/openai/           examples/anthropic/
examples/llamaindex/       examples/langchain/         examples/langgraph/
examples/multimodal/       examples/cost_tracking/     examples/threshold_tuning/
examples/embedding_cache/  examples/batch_check/       examples/rerank/
```

Each requires only a local Valkey instance with valkey-search:

```sh
cd examples/basic && python main.py
```

---

## Telemetry

The published wheel includes anonymous product analytics powered by PostHog.
Aggregate statistics (hit rate, cost saved) are collected on a per-instance basis
using a stable UUID persisted in Valkey — no prompt text, responses, or PII.

To opt out: `export BETTERDB_TELEMETRY=false`

See the [Analytics section](#posthog-analytics) above for full details.

---

## Links

- [Changelog](./CHANGELOG.md)
- [TypeScript counterpart](../semantic-cache/RELEASE_NOTES.md)
