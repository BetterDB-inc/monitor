"""Threshold effectiveness tuning example for betterdb-semantic-cache

Demonstrates threshold_effectiveness() analyzing the rolling score window
and recommending threshold adjustments.

No API key required - uses a mock embedder and simulated queries.

Prerequisites:
  - Valkey 8.0+ with valkey-search at localhost:6379

Usage:
  python examples/threshold_tuning/main.py
"""
from __future__ import annotations

import asyncio
import math
import os
import random
import re


# Parameterized mock embedder for controllable similarity (mirrors TS exactly)
def make_embedder(jitter: float):
    def _embed_sync(text: str) -> list[float]:
        words = [w for w in re.split(r'\W+', text.lower()) if w]
        dim = 16
        vec = [0.0] * dim
        for w in words:
            for i in range(min(len(w), dim)):
                vec[i % dim] += ord(w[i]) / 128.0
        # Add controlled noise
        for i in range(dim):
            vec[i] += (random.random() - 0.5) * jitter
        norm = math.sqrt(sum(x * x for x in vec)) or 1.0
        return [x / norm for x in vec]

    async def embed(text: str) -> list[float]:
        return _embed_sync(text)

    return embed


THRESHOLD = 0.15

SEED_PROMPTS = [
    "What is machine learning?",
    "How does gradient descent work?",
    "What is a neural network?",
    "Explain backpropagation in simple terms",
    "What is overfitting in machine learning?",
]

QUERY_PROMPTS = [
    "What is machine learning?",
    "Explain machine learning simply",
    "What is ML?",
    "How does gradient descent optimize?",
    "Explain gradient descent",
    "What is a deep neural network?",
    "Describe neural networks",
    "What is backpropagation?",
    "How does backpropagation work?",
    "What is model overfitting?",
    "What is the best pizza topping?",  # unrelated
    "How do you make pasta?",           # unrelated
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
        embed_fn=make_embedder(0.3),  # moderate noise -> some uncertain hits
        name="example_threshold",
        default_threshold=THRESHOLD,
        uncertainty_band=0.05,
        embedding_cache=EmbeddingCacheOptions(enabled=False),
    ))

    print("=== Threshold effectiveness tuning example ===\n")

    print("WARNING: Flushing cache - deletes all existing cache data.")
    await cache.initialize()
    await cache.flush()
    await cache.initialize()
    print(f"Cache initialized. Threshold: {THRESHOLD}\n")

    # -- Seed the cache --
    print(f"-- Seeding cache with {len(SEED_PROMPTS)} entries --")
    for prompt in SEED_PROMPTS:
        await cache.store(prompt, f"Answer for: {prompt}")
    print("  Seeding complete.\n")

    # -- Run queries to populate the similarity window --
    print(f"-- Running {len(QUERY_PROMPTS)} queries to build similarity window --")
    hits = misses = uncertain = 0

    for query in QUERY_PROMPTS:
        result = await cache.check(query)
        if result.hit:
            hits += 1
            if result.confidence == "uncertain":
                uncertain += 1
            marker = "HIT~" if result.confidence == "uncertain" else "HIT "
        else:
            misses += 1
            marker = "MISS"

        sim_str = f" ({result.similarity:.3f})" if result.similarity is not None else ""
        print(f'  {marker}{sim_str} - "{query[:35]}"')
    print()

    # -- Get threshold recommendations --
    print("-- Threshold Effectiveness Analysis --")
    analysis = await cache.threshold_effectiveness(min_samples=5)

    print(f"Category: {analysis.category}")
    print(f"Sample count: {analysis.sample_count}")
    print(f"Current threshold: {analysis.current_threshold}")
    print(f"Hit rate: {analysis.hit_rate * 100:.1f}%")
    print(f"Uncertain hit rate: {analysis.uncertain_hit_rate * 100:.1f}%")
    print(f"Near-miss rate: {analysis.near_miss_rate * 100:.1f}%")
    print(f"Avg hit similarity: {analysis.avg_hit_similarity:.4f}")
    print(f"Avg miss similarity: {analysis.avg_miss_similarity:.4f}")
    print()
    print(f"Recommendation: {analysis.recommendation.upper()}")
    if analysis.recommended_threshold is not None:
        print(f"Recommended threshold: {analysis.recommended_threshold:.4f}")
    print(f"Reasoning: {analysis.reasoning}")

    await cache.flush()
    await client.aclose()


if __name__ == "__main__":
    asyncio.run(main())
