"""Rerank hook example for betterdb-semantic-cache

Demonstrates the rerank option for selecting the best candidate from
top-k similarity results using a custom ranking function.

No API key required.

Prerequisites:
  - Valkey 8.0+ with valkey-search at localhost:6379

Usage:
  python examples/rerank/main.py
"""
from __future__ import annotations

import asyncio
import math
import os
import re


# charcode 16-dim mock embedder — mirrors TS rerank mock exactly
def _mock_embed(text: str) -> list[float]:
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


# Rerank strategy 1: pick longest response (most detailed)
async def pick_longest(_query: str, candidates: list[dict]) -> int:
    max_idx = 0
    for i in range(1, len(candidates)):
        if len(candidates[i]["response"]) > len(candidates[max_idx]["response"]):
            max_idx = i
    return max_idx


# Rerank strategy 2: reject if similarity score is above a tight threshold (0.001).
async def strict_quality(_query: str, candidates: list[dict]) -> int:
    for i, c in enumerate(candidates):
        if c["similarity"] < 0.001:
            return i
    return -1  # miss


async def main() -> None:
    import valkey.asyncio as valkey

    from betterdb_semantic_cache import SemanticCache, SemanticCacheOptions
    from betterdb_semantic_cache.types import CacheCheckOptions, EmbeddingCacheOptions, RerankOptions

    host = os.environ.get("VALKEY_HOST", "localhost")
    port = int(os.environ.get("VALKEY_PORT", "6379"))
    client = valkey.Valkey(host=host, port=port)

    cache = SemanticCache(SemanticCacheOptions(
        client=client,
        embed_fn=mock_embed,
        name="example_rerank",
        default_threshold=0.3,  # loose to retrieve multiple candidates
        embedding_cache=EmbeddingCacheOptions(enabled=False),
    ))

    print("=== Rerank hook example ===\n")

    print("WARNING: Flushing cache - deletes all existing cache data.")
    await cache.initialize()
    await cache.flush()
    await cache.initialize()
    print("Cache initialized and flushed.\n")

    # Seed multiple entries on similar topics
    print("-- Seeding cache --")
    await cache.store("What is machine learning?", "ML is a subset of AI.")
    await cache.store("How does machine learning work?", "Machine learning works by training models on data to recognize patterns and make predictions.")
    await cache.store("Explain machine learning", "Machine learning enables computers to learn from experience without being explicitly programmed. It uses statistical techniques to build mathematical models from sample data.")
    print("  Stored 3 entries (short, medium, long responses).\n")

    query = "Tell me about machine learning"

    # -- Without rerank: returns top-1 by similarity --
    print(f'-- Without rerank (top-1 by similarity): "{query}" --')
    no_rerank = await cache.check(query)
    if no_rerank.hit:
        print(f'  HIT: "{no_rerank.response}"')
        print(f"  Similarity: {no_rerank.similarity:.4f}")
    else:
        print("  MISS")
    print()

    # -- With rerank: longest response wins --
    print(f'-- With rerank (longest response wins): "{query}" --')
    with_rerank = await cache.check(
        query,
        CacheCheckOptions(rerank=RerankOptions(k=3, rerank_fn=pick_longest)),
    )
    if with_rerank.hit:
        print(f'  HIT: "{with_rerank.response}"')
    else:
        print("  MISS")
    print()

    # -- With strict quality rerank: reject loose matches --
    print(f'-- With strict quality rerank (reject similarity > 0.2): "{query}" --')
    strict_result = await cache.check(
        query,
        CacheCheckOptions(rerank=RerankOptions(k=3, rerank_fn=strict_quality)),
    )
    if strict_result.hit:
        print(f'  HIT: "{strict_result.response}"')
    else:
        print("  MISS - no candidate passed the quality threshold.")

    await cache.flush()
    await client.aclose()


if __name__ == "__main__":
    asyncio.run(main())
