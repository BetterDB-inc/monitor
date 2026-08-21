"""OpenAI Responses API + betterdb-semantic-cache example.

Demonstrates prepare_semantic_params() from the openai_responses adapter
extracting the semantic key from OpenAI Responses API params.

Prerequisites:
  - Valkey 8.0+ with valkey-search at localhost:6399
  - OPENAI_API_KEY environment variable set

Run:
    pip install "betterdb-semantic-cache[openai]"
    OPENAI_API_KEY=sk-... VALKEY_HOST=localhost VALKEY_PORT=6399 python examples/openai_responses/main.py
"""
from __future__ import annotations

import asyncio
import os
import warnings


async def main() -> None:
    import valkey.asyncio as valkey
    from openai import AsyncOpenAI

    from betterdb_semantic_cache import SemanticCache, SemanticCacheOptions
    from betterdb_semantic_cache.adapters.openai_responses import prepare_semantic_params
    from betterdb_semantic_cache.embed.openai import create_openai_embed
    from betterdb_semantic_cache.types import CacheStoreOptions

    host = os.environ.get("VALKEY_HOST", "localhost")
    port = int(os.environ.get("VALKEY_PORT", "6399"))
    client_v = valkey.Valkey(host=host, port=port)
    openai_client = AsyncOpenAI()

    embed = create_openai_embed(model="text-embedding-3-small", client=openai_client)
    cache = SemanticCache(SemanticCacheOptions(
        client=client_v,
        embed_fn=embed,
        name="demo_openai_resp",
        default_threshold=0.12,
        default_ttl=300,
    ))

    warnings.warn("Flushing cache 'demo_openai_resp' on startup.", stacklevel=1)
    await cache.initialize()
    await cache.flush()
    await cache.initialize()

    print("=== OpenAI Responses API + SemanticCache example ===\n")

    # -- Round 1: seed --
    print("-- Round 1: Seeding --")
    params1 = {
        "model": "gpt-4o-mini",
        "input": "What is the capital of Australia?",
    }
    print(f"User: {params1['input']}")
    sp1 = await prepare_semantic_params(params1)
    cached1 = await cache.check(sp1.text)
    if cached1.hit:
        print(f"  [cache HIT] similarity={cached1.similarity:.4f} confidence={cached1.confidence}")
        answer1 = cached1.response
    else:
        print("  [cache MISS] calling OpenAI Responses API...")
        resp1 = await openai_client.responses.create(**params1)
        answer1 = getattr(resp1, "output_text", "") or ""
        await cache.store(sp1.text, answer1, CacheStoreOptions(model=params1["model"]))
    print(f"Assistant: {answer1}\n")

    # -- Round 2: semantic hit --
    print("-- Round 2: Semantic hit --")
    params2 = {
        "model": "gpt-4o-mini",
        "input": "Which city is the capital of Australia?",
    }
    print(f"User: {params2['input']}")
    sp2 = await prepare_semantic_params(params2)
    cached2 = await cache.check(sp2.text)
    if cached2.hit:
        print(f"  [cache HIT] similarity={cached2.similarity:.4f} confidence={cached2.confidence}")
        answer2 = cached2.response
    else:
        print("  [cache MISS] calling OpenAI Responses API...")
        resp2 = await openai_client.responses.create(**params2)
        answer2 = getattr(resp2, "output_text", "") or ""
        await cache.store(sp2.text, answer2, CacheStoreOptions(model=params2["model"]))
    print(f"Assistant: {answer2}\n")

    # -- Stats --
    stats = await cache.stats()
    print("-- Cache Stats --")
    print(f"Hits: {stats.hits} | Misses: {stats.misses}")

    await cache.flush()
    await client_v.aclose()


if __name__ == "__main__":
    asyncio.run(main())
