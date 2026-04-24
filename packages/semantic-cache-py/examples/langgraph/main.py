"""LangGraph semantic store example.

Run:
    OPENAI_API_KEY=sk-... VALKEY_HOST=localhost VALKEY_PORT=6399 python examples/langgraph/main.py
"""
from __future__ import annotations

import asyncio
import os
import warnings


async def main() -> None:
    import valkey.asyncio as valkey

    from betterdb_semantic_cache import SemanticCache, SemanticCacheOptions
    from betterdb_semantic_cache.adapters.langgraph import BetterDBSemanticStore
    from betterdb_semantic_cache.embed.openai import create_openai_embed

    host = os.environ.get("VALKEY_HOST", "localhost")
    port = int(os.environ.get("VALKEY_PORT", "6399"))
    client_v = valkey.Valkey(host=host, port=port)

    embed = create_openai_embed(model="text-embedding-3-small")
    sc = SemanticCache(SemanticCacheOptions(
        client=client_v,
        embed_fn=embed,
        name="demo_langgraph",
        default_threshold=0.2,
    ))

    warnings.warn("Flushing cache 'demo_langgraph' on startup.", stacklevel=1)
    await sc.initialize()
    await sc.flush()
    await sc.initialize()

    store = BetterDBSemanticStore(sc)
    ns = ["user", "alice", "memories"]

    print("Storing memories...")
    await store.aput(ns, "mem1", {"content": "Alice enjoys hiking in the mountains."})
    await store.aput(ns, "mem2", {"content": "Alice dislikes crowded places."})
    await store.aput(ns, "mem3", {"content": "Alice's favourite drink is green tea."})

    print("\nSearching: 'outdoor activities'")
    results = await store.asearch(ns, query="outdoor activities", limit=3)
    for item in results:
        print(f"  - {item.value.get('content', '')!r}")

    print("\nSearching: 'what does Alice drink?'")
    results2 = await store.asearch(ns, query="what does Alice drink?", limit=2)
    for item in results2:
        print(f"  - {item.value.get('content', '')!r}")

    await client_v.aclose()


if __name__ == "__main__":
    asyncio.run(main())
