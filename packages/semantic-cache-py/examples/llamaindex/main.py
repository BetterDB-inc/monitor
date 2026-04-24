"""LlamaIndex semantic cache example.

Run:
    OPENAI_API_KEY=sk-... VALKEY_HOST=localhost VALKEY_PORT=6399 python examples/llamaindex/main.py
"""
from __future__ import annotations

import asyncio
import os
import warnings


async def main() -> None:
    import valkey.asyncio as valkey

    from betterdb_semantic_cache import SemanticCache, SemanticCacheOptions
    from betterdb_semantic_cache.adapters.llamaindex import prepare_semantic_params
    from betterdb_semantic_cache.types import CacheStoreOptions
    from betterdb_semantic_cache.embed.openai import create_openai_embed

    host = os.environ.get("VALKEY_HOST", "localhost")
    port = int(os.environ.get("VALKEY_PORT", "6399"))
    client_v = valkey.Valkey(host=host, port=port)

    embed = create_openai_embed(model="text-embedding-3-small")
    cache = SemanticCache(SemanticCacheOptions(
        client=client_v,
        embed_fn=embed,
        name="demo_llamaindex",
        default_threshold=0.12,
    ))

    warnings.warn("Flushing cache 'demo_llamaindex' on startup.", stacklevel=1)
    await cache.initialize()
    await cache.flush()
    await cache.initialize()

    messages = [{"role": "user", "content": "Explain gradient descent in simple terms."}]
    sp = await prepare_semantic_params(messages, model="gpt-4o-mini")

    result = await cache.check(sp.text)
    if result.hit:
        print(f"Cache HIT: {result.response!r}")
    else:
        print("Cache MISS — storing synthetic response...")
        answer = "Gradient descent is an optimization algorithm that iteratively adjusts parameters to minimize a loss function."
        await cache.store(sp.text, answer, CacheStoreOptions(model="gpt-4o-mini"))
        print(f"Stored: {answer!r}")

    result2 = await cache.check(sp.text)
    print(f"\nSecond lookup: hit={result2.hit}")

    await client_v.aclose()


if __name__ == "__main__":
    asyncio.run(main())
