"""LangChain semantic cache example.

Run:
    OPENAI_API_KEY=sk-... VALKEY_HOST=localhost VALKEY_PORT=6399 python examples/langchain/main.py
"""
from __future__ import annotations

import asyncio
import os
import warnings


async def main() -> None:
    import valkey.asyncio as valkey
    from langchain_openai import ChatOpenAI

    from betterdb_semantic_cache import SemanticCache, SemanticCacheOptions
    from betterdb_semantic_cache.adapters.langchain import BetterDBSemanticCache
    from betterdb_semantic_cache.embed.openai import create_openai_embed

    host = os.environ.get("VALKEY_HOST", "localhost")
    port = int(os.environ.get("VALKEY_PORT", "6399"))
    client_v = valkey.Valkey(host=host, port=port)

    embed = create_openai_embed(model="text-embedding-3-small")
    sc = SemanticCache(SemanticCacheOptions(
        client=client_v,
        embed_fn=embed,
        name="demo_langchain",
        default_threshold=0.12,
    ))

    warnings.warn("Flushing cache 'demo_langchain' on startup.", stacklevel=1)
    await sc.initialize()
    await sc.flush()
    await sc.initialize()

    lc_cache = BetterDBSemanticCache(sc)
    llm = ChatOpenAI(model="gpt-4o-mini", cache=lc_cache)

    print("First invocation (cache miss)...")
    resp1 = await llm.ainvoke("What is machine learning?")
    print(f"Response: {resp1.content!r}")

    print("\nSecond invocation (should hit cache)...")
    resp2 = await llm.ainvoke("What is machine learning?")
    print(f"Response: {resp2.content!r}")

    await client_v.aclose()


if __name__ == "__main__":
    asyncio.run(main())
