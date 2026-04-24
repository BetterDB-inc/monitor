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
