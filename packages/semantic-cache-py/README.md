# betterdb-semantic-cache

Semantic cache for AI workloads backed by Valkey vector search. Embeddings-based similarity matching with OpenTelemetry and Prometheus instrumentation.

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
        embed_fn=create_openai_embed(),
        default_threshold=0.12,
    ))
    await cache.initialize()

    result = await cache.check("What is the capital of France?")
    if not result.hit:
        await cache.store("What is the capital of France?", "Paris")

asyncio.run(main())
```

## LLM-as-judge

When a hit lands in the uncertainty band (`threshold - uncertainty_band < score <= threshold`), you can supply a `judge_fn` to adjudicate automatically instead of handling `confidence == 'uncertain'` yourself.

```python
from betterdb_semantic_cache import JudgeOptions
from betterdb_semantic_cache.types import CacheCheckOptions

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

openai = AsyncOpenAI()

async def my_judge(inp: dict) -> bool:
    # Return True to accept (confidence → 'high')
    # Return False to reject (treated as miss with nearest_miss)
    verdict = await openai.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": "Reply YES or NO only."},
            {"role": "user", "content": (
                f"Does this cached response correctly answer the prompt?\n"
                f"Prompt: {inp['prompt']}\nResponse: {inp['response']}"
            )},
        ],
    )
    return (verdict.choices[0].message.content or "").startswith("YES")
```

**When the judge is invoked:** only for `confidence == 'uncertain'` hits. High-confidence hits, misses, and the zero-candidates case bypass the judge entirely.

**Accept path:** `result.hit == True`, `result.confidence == 'high'`.

**Reject path:** `result.hit == False`, `result.nearest_miss` populated with `delta_to_threshold <= 0` (use this to distinguish judge rejections from regular misses where `delta_to_threshold > 0`).

**Composing with rerank:** when both `rerank` and `judge` are set, the judge receives the reranked pick's response and similarity score.

**`check_batch()` does not support `judge`.** Call `check()` individually for prompts that need adjudication.

### CacheCheckOptions reference

| Option | Type | Default | Description |
|---|---|---|---|
| `threshold` | `float` | `default_threshold` | Per-request cosine distance threshold override |
| `category` | `str` | `""` | Category tag for per-category thresholds and metric labels |
| `filter` | `str` | `None` | FT.SEARCH pre-filter expression (trusted input only) |
| `k` | `int` | `1` | KNN neighbours to fetch (ignored when `rerank` is set) |
| `stale_after_model_change` | `bool` | `False` | Evict and miss when stored model differs from `current_model` |
| `current_model` | `str` | `None` | Model to compare against stored entries |
| `rerank` | `RerankOptions` | `None` | Rerank hook; see `RerankOptions` |
| `judge` | `JudgeOptions` | `None` | LLM-as-judge for borderline hits. Not supported by `check_batch()`; raises `SemanticCacheUsageError` |

## Telemetry

The published wheel includes anonymous product analytics powered by PostHog.
When a baked API key is present in the package (injected at publish time),
**aggregate usage statistics** (hit rate, cost saved) are collected on a
per-instance basis — no prompt text, responses, or personally-identifiable
information is ever sent.

**To opt out**, set the environment variable before starting your process:

```bash
export BETTERDB_TELEMETRY=false   # also accepts: 0, no, off
```

You can also disable it programmatically:

```python
from betterdb_semantic_cache.types import AnalyticsOptions
cache = SemanticCache(SemanticCacheOptions(
    ...,
    analytics=AnalyticsOptions(disabled=True),
))
```
