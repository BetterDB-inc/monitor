"""Cost tracking example for betterdb-semantic-cache

Demonstrates:
  1. store() with input_tokens/output_tokens/model to record cost
  2. check() returning cost_saved on hit
  3. stats() showing cumulative cost_saved_micros

No API key required - uses a mock embedder.

Prerequisites:
  - Valkey 8.0+ with valkey-search at localhost:6379

Usage:
  python examples/cost_tracking/main.py
"""
from __future__ import annotations

import asyncio
import math
import os


# Simple word-overlap mock embedder (charcode 16-dim)
# Mirrors TS cost-tracking mock exactly
def _mock_embed(text: str) -> list[float]:
    import re
    words = [w for w in re.split(r'\W+', text.lower()) if w]
    dim = 16
    vec = [0.0] * dim
    for w in words:
        for i in range(min(len(w), dim)):
            vec[i % dim] += ord(w[i]) / 128.0
    norm = math.sqrt(sum(x * x for x in vec)) or 1.0
    return [x / norm for x in vec]


async def mock_embed(text: str) -> list[float]:
    return _mock_embed(text)


PROMPTS = [
    {"text": "What is the capital of France?", "answer": "Paris is the capital of France."},
    {"text": "What is the capital of Germany?", "answer": "Berlin is the capital of Germany."},
    {"text": "Who wrote Romeo and Juliet?", "answer": "William Shakespeare wrote Romeo and Juliet."},
]

MODEL = "gpt-4o-mini"
TOKENS = {"input": 25, "output": 15}


async def main() -> None:
    import valkey.asyncio as valkey

    from betterdb_semantic_cache import SemanticCache, SemanticCacheOptions
    from betterdb_semantic_cache.types import CacheStoreOptions, EmbeddingCacheOptions

    host = os.environ.get("VALKEY_HOST", "localhost")
    port = int(os.environ.get("VALKEY_PORT", "6379"))
    client = valkey.Valkey(host=host, port=port)

    # Use default cost table (bundled LiteLLM prices)
    cache = SemanticCache(SemanticCacheOptions(
        client=client,
        embed_fn=mock_embed,
        name="example_cost",
        default_threshold=0.25,  # loose threshold for mock embedder
        embedding_cache=EmbeddingCacheOptions(enabled=False),
    ))

    print("=== Cost tracking example ===\n")

    print("WARNING: Flushing cache - deletes all existing cache data.")
    await cache.initialize()
    await cache.flush()
    await cache.initialize()
    print("Cache initialized and flushed.\n")

    # -- Seed the cache with cost information --
    print("-- Seeding cache with cost-annotated entries --")
    for p in PROMPTS:
        await cache.store(
            p["text"], p["answer"],
            CacheStoreOptions(
                model=MODEL,
                input_tokens=TOKENS["input"],
                output_tokens=TOKENS["output"],
            ),
        )
        print(f'  Stored: "{p["text"][:40]}..."')
    print()

    # -- Query the cache 5 times (should all be hits) --
    print("-- Running 5 cache lookups --")
    queries = [
        "What is the capital city of France?",
        "What is France's capital?",
        "Capital of Germany?",
        "Who is the author of Romeo and Juliet?",
        "Who wrote the play Romeo and Juliet?",
    ]

    total_saved = 0.0
    for query in queries:
        result = await cache.check(query)
        if result.hit:
            saved = result.cost_saved or 0.0
            total_saved += saved
            print(f'  HIT: "{query[:35]}..." | saved ${saved:.6f}')
        else:
            print(f'  MISS: "{query[:35]}..."')
    print()

    # -- Print total cost saved --
    stats = await cache.stats()
    print("-- Cost Summary --")
    print(f"Hits: {stats.hits} / Requests: {stats.total}")
    print(f"Total cost saved: ${stats.cost_saved_micros / 1_000_000:.6f}")
    print(f"(via cumulative stats): ${stats.cost_saved_micros / 1_000_000:.6f}")

    await cache.flush()
    await client.aclose()


if __name__ == "__main__":
    asyncio.run(main())
