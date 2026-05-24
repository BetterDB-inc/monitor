"""
Latency profiler for cache adapter comparison.

Measures embed/network/parse breakdown and tests the BetterDB embedding cache hypothesis.

Usage:
    uv run python scripts/latency_profile.py --profile --queries 200

Requirements:
    - valkey-bench on port 6381 (valkey/valkey-bundle with search module):
        docker run -d --name valkey-bench -p 6381:6379 valkey/valkey-bundle:unstable
    - Redis Stack on port 6383 (for native RedisVL comparison):
        docker run -d --name redis-stack-bench -p 6383:6379 redis/redis-stack-server:latest
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
import time
import uuid
from pathlib import Path
from typing import NamedTuple

# Add src to path so imports work when run as a script
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
THRESHOLD = 0.15

# Fixed prompt pool for cycling test (5 prompts cycled 40× each at n=200)
CYCLE_PROMPTS = [
    "What is the capital of France?",
    "How does photosynthesis work?",
    "What is the Pythagorean theorem?",
    "Who wrote Romeo and Juliet?",
    "What causes a rainbow?",
]

# Unique prompts for the unique-query test (generated at runtime)
def _make_unique_prompts(n: int) -> list[str]:
    import hashlib
    return [f"Query about topic {hashlib.sha256(str(i).encode()).hexdigest()[:12]} at index {i}" for i in range(n)]


class TimingRecord(NamedTuple):
    total_ms: float
    embed_ms: float
    network_ms: float
    parse_ms: float
    embed_cache_hit: bool  # True if BetterDB skipped the embed_fn


class ScenarioResult(NamedTuple):
    label: str
    p50: float
    p95: float
    p99: float
    mean_embed: float
    mean_network: float
    mean_parse: float
    embed_cache_hit_rate: float
    n: int


# ---------------------------------------------------------------------------
# BetterDB timed embed wrapper
# ---------------------------------------------------------------------------

def _make_timed_embed_fn(model_name: str, timing_store: dict):
    """Wraps SBERT embed_fn to record timing per call. timing_store is mutated in-place."""
    import asyncio
    from sentence_transformers import SentenceTransformer  # type: ignore

    model = SentenceTransformer(model_name)

    async def embed(text: str) -> list[float]:
        t0 = time.perf_counter_ns()
        loop = asyncio.get_running_loop()
        vec = await loop.run_in_executor(None, lambda: model.encode(text).tolist())
        timing_store["last_embed_ns"] = time.perf_counter_ns() - t0
        timing_store["embed_called"] = True
        return vec

    return embed


async def _build_betterdb(valkey_url: str, timing_store: dict, cache_name: str | None = None):
    import valkey.asyncio as valkey  # type: ignore
    from betterdb_semantic_cache import SemanticCache  # type: ignore
    from betterdb_semantic_cache.types import (  # type: ignore
        SemanticCacheOptions, AnalyticsOptions, DiscoveryOptions, ConfigRefreshOptions,
    )

    name = cache_name or f"bench:profile:{uuid.uuid4().hex[:8]}"
    client = valkey.Valkey.from_url(valkey_url, decode_responses=False)
    embed_fn = _make_timed_embed_fn(EMBEDDING_MODEL, timing_store)

    opts = SemanticCacheOptions(
        client=client,
        embed_fn=embed_fn,
        name=name,
        default_threshold=THRESHOLD,
        analytics=AnalyticsOptions(disabled=True),
        discovery=DiscoveryOptions(enabled=False),
        config_refresh=ConfigRefreshOptions(enabled=False),
    )
    cache = SemanticCache(opts)
    await cache.initialize()
    return cache, client


async def _measure_betterdb(
    n_warmup: int,
    n_measure: int,
    valkey_url: str,
    cycling: bool,
    label: str,
) -> ScenarioResult:
    """Measure BetterDB check() latency with embed/network breakdown."""
    timing_store: dict = {"last_embed_ns": 0, "embed_called": False}
    cache, client = await _build_betterdb(valkey_url, timing_store)

    prompts_unique = _make_unique_prompts(n_warmup + n_measure)
    prompts_warmup = prompts_unique[:n_warmup]
    if cycling:
        prompts_measure = [CYCLE_PROMPTS[i % len(CYCLE_PROMPTS)] for i in range(n_measure)]
    else:
        prompts_measure = prompts_unique[n_warmup:n_warmup + n_measure]

    # Store warmup prompts
    for p in prompts_warmup:
        await cache.store(p, f"Answer: {p}")
    if cycling:
        for p in CYCLE_PROMPTS:
            await cache.store(p, f"Answer: {p}")

    # Warmup checks
    for p in prompts_warmup:
        await cache.check(p)

    # Measured checks
    records: list[TimingRecord] = []
    for p in prompts_measure:
        timing_store["embed_called"] = False
        timing_store["last_embed_ns"] = 0

        t0 = time.perf_counter_ns()
        await cache.check(p)
        total_ns = time.perf_counter_ns() - t0

        embed_ns = timing_store["last_embed_ns"] if timing_store["embed_called"] else 0
        embed_cache_hit = not timing_store["embed_called"]
        # network ≈ total - embed (parsing is negligible in BetterDB's async path)
        network_ns = max(0, total_ns - embed_ns)

        records.append(TimingRecord(
            total_ms=total_ns / 1e6,
            embed_ms=embed_ns / 1e6,
            network_ms=network_ns / 1e6,
            parse_ms=0.0,
            embed_cache_hit=embed_cache_hit,
        ))

    await cache.flush()
    await cache.shutdown()
    await client.aclose()

    return _summarise(label, records)


async def _measure_redisvl(
    n_warmup: int,
    n_measure: int,
    valkey_url: str,
    backend: str,
    cycling: bool,
    label: str,
) -> ScenarioResult:
    """Measure RedisVL check() latency with embed/network/parse breakdown."""
    from cache_benchmark.adapters.redisvl_adapter import RedisVLAdapter  # type: ignore

    adapter = RedisVLAdapter(
        threshold=THRESHOLD,
        embedding_model=EMBEDDING_MODEL,
        redis_url=valkey_url,
        redisvl_backend=backend,
    )
    await adapter.clear()
    await adapter.initialize()

    prompts_unique = _make_unique_prompts(n_warmup + n_measure)
    prompts_warmup = prompts_unique[:n_warmup]
    if cycling:
        prompts_measure = [CYCLE_PROMPTS[i % len(CYCLE_PROMPTS)] for i in range(n_measure)]
    else:
        prompts_measure = prompts_unique[n_warmup:n_warmup + n_measure]

    for p in prompts_warmup:
        await adapter.store(p, f"Answer: {p}")
    if cycling:
        for p in CYCLE_PROMPTS:
            await adapter.store(p, f"Answer: {p}")

    for p in prompts_warmup:
        await adapter.check(p)

    records: list[TimingRecord] = []
    for p in prompts_measure:
        await adapter.check(p)
        t = adapter._profile_timing
        records.append(TimingRecord(
            total_ms=t.get("embed_ms", 0) + t.get("network_ms", 0) + t.get("parse_ms", 0),
            embed_ms=t.get("embed_ms", 0),
            network_ms=t.get("network_ms", 0),
            parse_ms=t.get("parse_ms", 0),
            embed_cache_hit=False,
        ))

    await adapter.close()
    return _summarise(label, records)


def _summarise(label: str, records: list[TimingRecord]) -> ScenarioResult:
    import numpy as np
    totals = [r.total_ms for r in records]
    return ScenarioResult(
        label=label,
        p50=float(np.percentile(totals, 50)),
        p95=float(np.percentile(totals, 95)),
        p99=float(np.percentile(totals, 99)),
        mean_embed=float(np.mean([r.embed_ms for r in records])),
        mean_network=float(np.mean([r.network_ms for r in records])),
        mean_parse=float(np.mean([r.parse_ms for r in records])),
        embed_cache_hit_rate=sum(1 for r in records if r.embed_cache_hit) / len(records),
        n=len(records),
    )


def _print_table(results: list[ScenarioResult]) -> None:
    header = f"{'Adapter':<35} | {'p50 (ms)':>8} | {'p95 (ms)':>8} | {'p99 (ms)':>8} | {'embed (ms)':>10} | {'network (ms)':>12} | {'parse (ms)':>10} | {'emb$hit%':>8}"
    print()
    print(header)
    print("-" * len(header))
    for r in results:
        print(
            f"{r.label:<35} | {r.p50:>8.2f} | {r.p95:>8.2f} | {r.p99:>8.2f} | "
            f"{r.mean_embed:>10.2f} | {r.mean_network:>12.2f} | {r.mean_parse:>10.2f} | "
            f"{r.embed_cache_hit_rate:>7.0%} "
        )
    print()


def _print_summary(results: list[ScenarioResult]) -> None:
    by_label = {r.label: r for r in results}
    bd_u = by_label.get("BetterDB-valkey-unique")
    bd_c = by_label.get("BetterDB-valkey-cycling")
    rvl_v = by_label.get("RedisVL-valkey-workaround")
    rvl_s = by_label.get("RedisVL-redis-stack-native")

    print("=" * 70)
    print("SUMMARY")
    print("=" * 70)

    # 1. Gap on Redis Stack
    if rvl_v and rvl_s:
        gap_valkey = bd_u.p50 / rvl_v.p50 if bd_u and rvl_v.p50 else None
        gap_stack = bd_u.p50 / rvl_s.p50 if bd_u and rvl_s.p50 else None
        print(f"\n1. Valkey workaround vs Redis Stack native (RedisVL p50):")
        print(f"   RedisVL-valkey:       {rvl_v.p50:.2f} ms")
        print(f"   RedisVL-redis-stack:  {rvl_s.p50:.2f} ms")
        if gap_valkey and gap_stack:
            print(f"   BetterDB/RedisVL-valkey ratio:  {gap_valkey:.2f}x")
            print(f"   BetterDB/RedisVL-stack ratio:   {gap_stack:.2f}x")
        if rvl_s.p50 < rvl_v.p50 * 0.8:
            print("   → Redis Stack native is substantially faster. Our workaround adds overhead.")
        elif abs(rvl_s.p50 - rvl_v.p50) / rvl_v.p50 < 0.15:
            print("   → Valkey workaround and Redis Stack native are within 15%. Workaround is not the cause.")
        else:
            print(f"   → Moderate difference ({(rvl_v.p50 - rvl_s.p50)/rvl_v.p50:.0%}). Workaround adds some overhead.")
    else:
        print("\n1. Redis Stack not tested (not running or skipped).")

    # 2. Embed/network/parse breakdown
    print(f"\n2. Embed / network / parse breakdown (unique queries):")
    for r in [bd_u, rvl_v, rvl_s]:
        if r:
            print(f"   {r.label:<35}  embed={r.mean_embed:.2f}ms  network={r.mean_network:.2f}ms  parse={r.mean_parse:.2f}ms")

    # 3. Embedding cache effect
    if bd_u and bd_c:
        print(f"\n3. BetterDB embedding cache effect:")
        print(f"   Unique queries p50:  {bd_u.p50:.2f} ms  (embed cache hit rate: {bd_u.embed_cache_hit_rate:.0%})")
        print(f"   Cycling queries p50: {bd_c.p50:.2f} ms  (embed cache hit rate: {bd_c.embed_cache_hit_rate:.0%})")
        speedup = bd_u.p50 / bd_c.p50 if bd_c.p50 > 0 else 1.0
        if bd_c.embed_cache_hit_rate > 0.5 and speedup > 1.5:
            print(f"   → Embedding cache explains {speedup:.1f}x speedup on cycling queries.")
            print(f"   → BetterDB skips SBERT compute when the same prompt is seen again.")
            print(f"   → In the benchmark harness, each pair uses a different prompt_b, so the cache")
            print(f"      rarely hits in practice. The benchmark numbers reflect real-world unique-query behavior.")
        else:
            print(f"   → Embedding cache has minimal effect at this scale (hit rate: {bd_c.embed_cache_hit_rate:.0%}).")

    # 4. Root cause
    print(f"\n4. Identified cause of BetterDB vs RedisVL latency difference:")
    if bd_u and rvl_v:
        delta = rvl_v.p50 - bd_u.p50
        pct = delta / rvl_v.p50 * 100
        embed_delta = rvl_v.mean_embed - bd_u.mean_embed
        network_delta = rvl_v.mean_network - bd_u.mean_network

        if abs(delta) < 1.0:
            print(f"   Gap is {delta:.2f}ms ({pct:.0f}%) — within noise. No significant difference.")
        else:
            dominant = "embedding" if abs(embed_delta) > abs(network_delta) else "network round-trip"
            print(f"   p50 gap: {delta:.2f}ms ({pct:.0f}%). Dominant factor: {dominant}.")
            print(f"   embed delta:   {embed_delta:+.2f}ms  (BetterDB uses async valkey embed cache; RedisVL is synchronous)")
            print(f"   network delta: {network_delta:+.2f}ms  (BetterDB async valkey client vs RedisVL sync redis-py client)")


async def _run(args) -> None:
    n_warmup = 50
    n = args.queries
    valkey_url = args.valkey_url
    stack_url = args.redis_stack_url

    print(f"Profiling {n} queries per scenario (warmup: {n_warmup})")
    print(f"Valkey URL: {valkey_url}")
    print(f"Redis Stack URL: {stack_url}")
    print()

    results: list[ScenarioResult] = []

    print("→ BetterDB / Valkey / unique queries...")
    r = await _measure_betterdb(n_warmup, n, valkey_url, cycling=False, label="BetterDB-valkey-unique")
    results.append(r)

    print("→ BetterDB / Valkey / cycling queries (embedding cache test)...")
    r = await _measure_betterdb(n_warmup, n, valkey_url, cycling=True, label="BetterDB-valkey-cycling")
    results.append(r)

    print("→ RedisVL / Valkey workaround / unique queries...")
    r = await _measure_redisvl(n_warmup, n, valkey_url, backend="valkey", cycling=False, label="RedisVL-valkey-workaround")
    results.append(r)

    # Redis Stack — optional, skip if not running
    try:
        import redis as redis_py  # type: ignore
        rc = redis_py.Redis.from_url(stack_url, socket_connect_timeout=2)
        rc.ping()
        rc.close()
        print("→ RedisVL / Redis Stack native / unique queries...")
        r = await _measure_redisvl(n_warmup, n, stack_url, backend="redis-stack", cycling=False, label="RedisVL-redis-stack-native")
        results.append(r)
    except Exception as e:
        print(f"  ⚠ Redis Stack not reachable at {stack_url}: {e}")
        print(f"  To run native comparison:")
        print(f"    docker run -d --name redis-stack-bench -p 6383:6379 redis/redis-stack-server:latest")

    _print_table(results)
    _print_summary(results)


def main():
    parser = argparse.ArgumentParser(description="Cache adapter latency profiler")
    parser.add_argument("--profile", action="store_true", help="Enable detailed timing breakdown")
    parser.add_argument("--queries", type=int, default=200, help="Number of check() calls to measure per scenario")
    parser.add_argument("--valkey-url", default="redis://localhost:6381", help="Valkey with search module")
    parser.add_argument("--redis-stack-url", default=os.environ.get("REDIS_STACK_URL", "redis://localhost:6383"))
    args = parser.parse_args()
    asyncio.run(_run(args))


if __name__ == "__main__":
    main()
