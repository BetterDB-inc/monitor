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
from embed.openai import create_openai_embed

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
