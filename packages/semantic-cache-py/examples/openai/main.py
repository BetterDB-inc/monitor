"""OpenAI semantic cache example.

Run:
    OPENAI_API_KEY=sk-... VALKEY_HOST=localhost VALKEY_PORT=6399 python examples/openai/main.py
"""
from __future__ import annotations

import asyncio
import os
import warnings


async def main() -> None:
    import valkey.asyncio as valkey
    from openai import AsyncOpenAI

    from betterdb_semantic_cache import SemanticCache, SemanticCacheOptions
    from betterdb_semantic_cache.adapters.openai import prepare_semantic_params
    from betterdb_semantic_cache.types import CacheStoreOptions
    from betterdb_semantic_cache.embed.openai import create_openai_embed

    host = os.environ.get("VALKEY_HOST", "localhost")
    port = int(os.environ.get("VALKEY_PORT", "6399"))
    client_v = valkey.Valkey(host=host, port=port)
    openai_client = AsyncOpenAI()

    embed = create_openai_embed(model="text-embedding-3-small", client=openai_client)
    cache = SemanticCache(SemanticCacheOptions(
        client=client_v,
        embed_fn=embed,
        name="demo_openai",
        default_threshold=0.12,
    ))

    warnings.warn("Flushing cache 'demo_openai' on startup.", stacklevel=1)
    await cache.initialize()
    await cache.flush()
    await cache.initialize()

    params = {
        "model": "gpt-4o-mini",
        "messages": [{"role": "user", "content": "What is the speed of light?"}],
    }

    sp = await prepare_semantic_params(params)
    result = await cache.check(sp.text)
    if result.hit:
        print(f"Cache HIT: {result.response!r}")
        answer = result.response
    else:
        print("Cache MISS — calling OpenAI...")
        resp = await openai_client.chat.completions.create(**params)
        answer = resp.choices[0].message.content
        print(f"OpenAI response: {answer!r}")
        await cache.store(sp.text, answer or "", CacheStoreOptions(model=params["model"]))

    # Second lookup (should hit)
    result2 = await cache.check(sp.text)
    print(f"\nSecond lookup: hit={result2.hit}, confidence={result2.confidence}")

    await client_v.aclose()


if __name__ == "__main__":
    asyncio.run(main())
