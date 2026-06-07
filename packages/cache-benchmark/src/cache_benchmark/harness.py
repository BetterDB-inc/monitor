from __future__ import annotations

import asyncio

from tqdm.asyncio import tqdm  # type: ignore

from cache_benchmark.adapters.base import CacheAdapter
from cache_benchmark.types import QueryPair, ReplayResult


async def run_replay(
    adapter: CacheAdapter,
    pairs: list[QueryPair],
    store_mode: str = "paired",
) -> list[ReplayResult]:
    """Replay labeled pairs through the cache adapter.

    Procedure:
    1. Clear and reinitialize the adapter.
    2. Store entries (mode determines strategy).
    3. Check prompt_b for each pair and record the result.

    store_mode:
      "paired" — (default) store one entry per pair using prompt_a. Classic mode.
      "dense"  — store every unique prompt_a once, creating a dense cache with
                 many entity-confusable neighbors from different equivalence
                 classes. Tests the reranker's ability to pick the right entry.
    """

    async def _with_retry(coro_fn, retries: int = 3, delay: float = 3.0):
        """Call coro_fn(), retrying on transient connection errors.

        Does NOT call close()/initialize() on retry: those wipe all stored
        entries (RedisVL drops the FT index; GPTCache removes the data
        directory), which would silently corrupt precision/recall results
        if a transient error occurs mid-store phase. The underlying client
        will reconnect automatically on the next command after a sleep.
        """
        for attempt in range(retries):
            try:
                return await coro_fn()
            except Exception as e:
                msg = str(e).lower()
                is_transient = any(k in msg for k in ("timeout", "connection", "closed", "reset", "eof"))
                if is_transient and attempt < retries - 1:
                    await asyncio.sleep(delay)
                else:
                    raise

    await adapter.clear()
    await adapter.initialize()

    # Store phase
    if store_mode == "dense":
        # Deduplicate: store every unique prompt_a exactly once.
        # This populates the cache with all prompts from all equivalence classes,
        # so the reranker has multiple entity-confusable neighbors to pick from.
        seen: set[str] = set()
        store_items: list[tuple[str, str]] = []
        for pair in pairs:
            if pair.prompt_a not in seen:
                seen.add(pair.prompt_a)
                store_items.append((pair.prompt_a, "The answer to your question is available in our knowledge base."))
        for prompt, response in tqdm(store_items, desc=f"[{adapter.name}] storing (dense)", unit="entry"):
            await _with_retry(lambda p=prompt, r=response: adapter.store(p, r))
    else:
        for pair in tqdm(pairs, desc=f"[{adapter.name}] storing", unit="pair"):
            # Use the prompt itself as the response body so LLM-as-judge adapters
            # receive meaningful text. Real LLM responses contain content related to
            # the prompt; this is a fair upper bound that matches production conditions
            # and avoids every adapter's judge seeing an unintelligible hash string.
            dummy = f"Answer: {pair.prompt_a}"
            await _with_retry(lambda p=pair.prompt_a, d=dummy: adapter.store(p, d))

    # Check phase
    results: list[ReplayResult] = []
    for pair in tqdm(pairs, desc=f"[{adapter.name}] checking", unit="pair"):
        cr = await _with_retry(lambda p=pair.prompt_b: adapter.check(p))
        results.append(ReplayResult(
            prompt_a=pair.prompt_a,
            prompt_b=pair.prompt_b,
            is_semantic_match=pair.is_semantic_match,
            hit=cr.hit,
            similarity_score=cr.similarity_score,
            latency_ms=cr.latency_ms,
            category=pair.category,
        ))

    return results


if __name__ == "__main__":
    import asyncio
    import os

    async def _smoke():
        from cache_benchmark.adapters.betterdb import BetterDBAdapter
        from cache_benchmark.datasets.vcache_lmarena import load_vcache_lmarena

        pairs = load_vcache_lmarena(limit=100)
        redis_url = os.environ.get("REDIS_URL", "redis://localhost:6381")  # valkey-bench container
        adapter = BetterDBAdapter(
            threshold=0.15,
            embedding_model="sentence-transformers/all-MiniLM-L6-v2",
            redis_url=redis_url,
        )
        results = await run_replay(adapter, pairs)
        await adapter.close()
        hits = sum(1 for r in results if r.hit)
        print(f"Hits: {hits}, Misses: {len(results) - hits}")

    asyncio.run(_smoke())
