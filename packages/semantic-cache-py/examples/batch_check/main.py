"""Batch check example for betterdb-semantic-cache

Demonstrates check_batch() for pipelined multi-prompt lookups,
and compares timing against sequential check() calls.

No API key required.

Prerequisites:
  - Valkey 8.0+ with valkey-search at localhost:6379

Usage:
  python examples/batch_check/main.py
"""
from __future__ import annotations

import asyncio
import math
import os
import time


# Word-hashing embedder: each word maps to a fixed index in a large sparse vector.
# This gives much better topic separation than character-code approaches.
# Mirrors the TS batch-check mock exactly: h = ((h << 5) + h + charCode) & 0xffffffff
def _mock_embed(text: str) -> list[float]:
    dim = 128
    words = [w for w in text.lower().split() if w.replace("'", "").isalpha() or w.isalnum()]
    # Split on non-word chars like TS /\W+/
    import re
    words = [w for w in re.split(r'\W+', text.lower()) if w]
    vec = [0.0] * dim
    for w in words:
        h = 5381
        for ch in w:
            h = ((h << 5) + h + ord(ch)) & 0xFFFFFFFF
        vec[abs(h) % dim] += 1.0
    norm = math.sqrt(sum(x * x for x in vec)) or 1.0
    return [x / norm for x in vec]


async def mock_embed(text: str) -> list[float]:
    return _mock_embed(text)


SEED = [
    {"q": "What is the capital of France?", "a": "Paris"},
    {"q": "What is the capital of Germany?", "a": "Berlin"},
    {"q": "What is the capital of Italy?", "a": "Rome"},
]

QUERIES = [
    "What is the capital of France?",        # hit
    "Capital of Germany?",                    # near hit
    "Who invented the telephone?",            # miss
    "What is the capital of Italy?",          # hit
    "What is the best programming language?", # miss
]


async def main() -> None:
    import valkey.asyncio as valkey

    from betterdb_semantic_cache import SemanticCache, SemanticCacheOptions
    from betterdb_semantic_cache.types import EmbeddingCacheOptions

    host = os.environ.get("VALKEY_HOST", "localhost")
    port = int(os.environ.get("VALKEY_PORT", "6379"))
    client = valkey.Valkey(host=host, port=port)

    cache = SemanticCache(SemanticCacheOptions(
        client=client,
        embed_fn=mock_embed,
        name="example_batch",
        default_threshold=0.1,
        embedding_cache=EmbeddingCacheOptions(enabled=False),
    ))

    print("=== Batch check example ===\n")

    print("WARNING: Flushing cache - deletes all existing cache data.")
    await cache.initialize()
    await cache.flush()
    await cache.initialize()
    print("Cache initialized and flushed.\n")

    # Seed
    print("-- Seeding cache --")
    for entry in SEED:
        await cache.store(entry["q"], entry["a"])
        print(f'  Stored: "{entry["q"]}"')
    print()

    # Sequential check
    print(f"-- Sequential check() x{len(QUERIES)} --")
    seq_start = time.perf_counter()
    seq_results = []
    for q in QUERIES:
        seq_results.append(await cache.check(q))
    seq_ms = (time.perf_counter() - seq_start) * 1000

    # Batch check
    print(f"-- checkBatch() x{len(QUERIES)} --")
    batch_start = time.perf_counter()
    batch_results = await cache.check_batch(QUERIES)
    batch_ms = (time.perf_counter() - batch_start) * 1000

    # Print results
    print("\n-- Results comparison --")
    print("Query".ljust(45) + "Sequential".ljust(14) + "Batch")
    print("-" * 75)
    for i, q in enumerate(QUERIES):
        seq_hit = f"HIT({seq_results[i].confidence})" if seq_results[i].hit else "MISS"
        batch_hit = f"HIT({batch_results[i].confidence})" if batch_results[i].hit else "MISS"
        print(q[:44].ljust(45) + seq_hit.ljust(14) + batch_hit)

    print(f"\nSequential: {seq_ms:.1f}ms | Batch: {batch_ms:.1f}ms")
    if batch_ms < seq_ms:
        pct = (seq_ms - batch_ms) / seq_ms * 100
        print(f"Batch was {pct:.0f}% faster.")

    await cache.flush()
    await client.aclose()


if __name__ == "__main__":
    asyncio.run(main())
