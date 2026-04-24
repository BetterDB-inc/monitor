"""Anthropic semantic cache example.

Run:
    ANTHROPIC_API_KEY=sk-ant-... OPENAI_API_KEY=sk-... VALKEY_HOST=localhost VALKEY_PORT=6399 python examples/anthropic/main.py
"""
from __future__ import annotations

import asyncio
import os
import warnings


async def main() -> None:
    import valkey.asyncio as valkey
    import anthropic

    from betterdb_semantic_cache import SemanticCache, SemanticCacheOptions
    from betterdb_semantic_cache.adapters.anthropic import prepare_semantic_params
    from betterdb_semantic_cache.types import CacheStoreOptions
    from embed.openai import create_openai_embed

    host = os.environ.get("VALKEY_HOST", "localhost")
    port = int(os.environ.get("VALKEY_PORT", "6399"))
    client_v = valkey.Valkey(host=host, port=port)
    ant_client = anthropic.Anthropic()

    embed = create_openai_embed(model="text-embedding-3-small")
    cache = SemanticCache(SemanticCacheOptions(
        client=client_v,
        embed_fn=embed,
        name="demo_anthropic",
        default_threshold=0.12,
    ))

    warnings.warn("Flushing cache 'demo_anthropic' on startup.", stacklevel=1)
    await cache.initialize()
    await cache.flush()
    await cache.initialize()

    params = {
        "model": "claude-3-5-haiku-20241022",
        "max_tokens": 256,
        "messages": [{"role": "user", "content": "What is photosynthesis?"}],
    }

    sp = await prepare_semantic_params(params)
    result = await cache.check(sp.text)
    if result.hit:
        print(f"Cache HIT: {result.response!r}")
    else:
        print("Cache MISS — calling Anthropic...")
        resp = ant_client.messages.create(**params)
        answer = resp.content[0].text if resp.content else ""
        print(f"Anthropic response: {answer!r}")
        await cache.store(sp.text, answer, CacheStoreOptions(model=params["model"]))

    result2 = await cache.check(sp.text)
    print(f"\nSecond lookup: hit={result2.hit}, confidence={result2.confidence}")

    await client_v.aclose()


if __name__ == "__main__":
    asyncio.run(main())
