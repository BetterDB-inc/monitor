from __future__ import annotations

from cache_benchmark.adapters.base import CacheAdapter
from cache_benchmark.types import QueryPair, ReplayResult


async def run_replay(
    adapter: CacheAdapter,
    pairs: list[QueryPair],
    populate_with_dummy_responses: bool = True,
) -> list[ReplayResult]:
    """Replay labeled pairs through the cache adapter.

    Procedure:
    1. Clear and reinitialize the adapter.
    2. Store prompt_a for each pair with a dummy response.
    3. Check prompt_b for each pair and record the result.
    """
    from tqdm.asyncio import tqdm  # type: ignore

    import asyncio

    async def _with_retry(coro_fn, retries: int = 3, delay: float = 3.0):
        """Call coro_fn(), retrying on timeout/connection errors after reinitializing."""
        for attempt in range(retries):
            try:
                return await coro_fn()
            except Exception as e:
                msg = str(e).lower()
                is_transient = any(k in msg for k in ("timeout", "connection", "closed", "reset", "eof"))
                if is_transient and attempt < retries - 1:
                    await asyncio.sleep(delay)
                    try:
                        await adapter.close()
                        await adapter.initialize()
                    except Exception:
                        pass
                else:
                    raise

    await adapter.clear()
    await adapter.initialize()

    # Store phase
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
