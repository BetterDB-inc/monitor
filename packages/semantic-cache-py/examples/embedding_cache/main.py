"""Embedding cache example for betterdb-semantic-cache

Demonstrates that repeated check() calls on the same text skip the embed_fn
when the embedding cache is enabled, by wrapping embed_fn in a counter.

No API key required.

Prerequisites:
  - Valkey 8.0+ with valkey-search at localhost:6379

Usage:
  python examples/embedding_cache/main.py
"""
from __future__ import annotations

import asyncio
import math
import os
import re


embed_call_count = 0


def _tracking_embed_sync(text: str) -> list[float]:
    global embed_call_count
    embed_call_count += 1
    import re as _re
    words = [w for w in _re.split(r'\W+', text.lower()) if w]
    dim = 8
    vec = [0.0] * dim
    for w in words:
        for i in range(min(len(w), dim)):
            vec[i % dim] += ord(w[i]) / 128.0
    norm = math.sqrt(sum(x * x for x in vec)) or 1.0
    return [x / norm for x in vec]


async def tracking_embed(text: str) -> list[float]:
    return _tracking_embed_sync(text)


async def run_with_embedding_cache(client, enabled: bool) -> None:
    global embed_call_count
    embed_call_count = 0

    from betterdb_semantic_cache import SemanticCache, SemanticCacheOptions
    from betterdb_semantic_cache.types import EmbeddingCacheOptions

    name = f"example_emb_{'on' if enabled else 'off'}"
    cache = SemanticCache(SemanticCacheOptions(
        client=client,
        embed_fn=tracking_embed,
        name=name,
        default_threshold=0.2,
        embedding_cache=EmbeddingCacheOptions(enabled=enabled, ttl=3600),
    ))

    await cache.initialize()
    await cache.flush()
    await cache.initialize()

    text = "What is the capital of France?"

    # First call
    await cache.check(text)
    after_first = embed_call_count

    # Second call with same text
    await cache.check(text)
    after_second = embed_call_count

    # Third call with different text
    await cache.check("Who invented the telephone?")
    after_third = embed_call_count

    cached_note = " [cached!]" if enabled and after_second == after_first else ""
    print(f"  After 1st call (same text):  {after_first} embedFn call(s)")
    print(f"  After 2nd call (same text):  {after_second} embedFn call(s){cached_note}")
    print(f"  After 3rd call (diff text):  {after_third} embedFn call(s)")

    await cache.flush()


async def main() -> None:
    import valkey.asyncio as valkey

    host = os.environ.get("VALKEY_HOST", "localhost")
    port = int(os.environ.get("VALKEY_PORT", "6379"))
    client = valkey.Valkey(host=host, port=port)

    print("=== Embedding cache example ===\n")

    print("-- With embedding cache ENABLED --")
    await run_with_embedding_cache(client, enabled=True)
    print()

    print("-- With embedding cache DISABLED --")
    await run_with_embedding_cache(client, enabled=False)
    print()

    print("Key insight: when enabled, repeated check() on the same text")
    print("reads the cached Float32 vector from Valkey instead of calling embed_fn.")

    await client.aclose()


if __name__ == "__main__":
    asyncio.run(main())
