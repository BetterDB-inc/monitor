"""
Latency profiler for cache adapter comparison.

Measures embed/network/parse breakdown and tests the BetterDB embedding cache hypothesis.

Usage:
    uv run python scripts/latency_profile.py --profile --queries 200

Requirements:
    - valkey-bench on port 6381 (valkey/valkey-bundle with search module):
        docker run -d --name valkey-bench -p 6381:6379 valkey/valkey-bundle:unstable
    - Redis 8 on port 6384 (for native RedisVL comparison, recommended):
        docker run -d --name redis-8-bench -p 6384:6379 redis:latest

Version history:
    - First run (2026-05-25): tested redis/redis-stack-server:latest
      (Redis 7.4.7, sha256:798ab84d9f266936b034ab11c4d04a2b8e4b441884c5aa7d17ac951eefdf742a).
      Numbers preserved as LEGACY_REDIS_STACK_RESULT below.
    - Second run (2026-05-25): switched to redis:latest (Redis 8.6.3, Search 8.6.7).
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

# Results from the first profiler run (Redis Stack 7.4.7, 2026-05-25, 200 queries).
# Preserved so the table can show Redis Stack vs Redis 8 side-by-side without re-running.
LEGACY_REDIS_STACK_RESULT: "ScenarioResult | None" = None  # filled in after class definition

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


# Legacy numbers from first run (Redis Stack 7.4.7, sha256:798ab84d, 2026-05-25, n=200).
LEGACY_REDIS_STACK_RESULT = ScenarioResult(
    label="RedisVL-redis-stack-7.4.7-legacy",
    p50=6.30, p95=6.63, p99=7.00,
    mean_embed=2.93, mean_network=3.32, mean_parse=0.00,
    embed_cache_hit_rate=0.0,
    n=200,
)


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
    rvl_legacy = by_label.get("RedisVL-redis-stack-7.4.7-legacy")
    # Redis 8 label is dynamic (includes version string); find it by prefix
    rvl_r8 = next((r for r in results if r.label.startswith("RedisVL-redis-") and "legacy" not in r.label), None)

    print("=" * 70)
    print("SUMMARY")
    print("=" * 70)

    # 1. Version comparison: Redis Stack 7.4.7 vs Redis 8 native
    print(f"\n1. Redis Stack 7.4.7 (legacy) vs Redis 8 native (RedisVL p50):")
    if rvl_legacy:
        print(f"   Redis Stack 7.4.7:  {rvl_legacy.p50:.2f} ms  (network: {rvl_legacy.mean_network:.2f}ms)")
    if rvl_r8:
        print(f"   Redis 8 native:     {rvl_r8.p50:.2f} ms  (network: {rvl_r8.mean_network:.2f}ms)")
    if rvl_legacy and rvl_r8:
        diff = rvl_legacy.p50 - rvl_r8.p50
        if abs(diff) < 0.5:
            print(f"   → Within noise ({diff:+.2f}ms). Redis 8 search internals did not meaningfully change latency.")
        elif diff > 0:
            print(f"   → Redis 8 is {diff:.2f}ms faster than Redis Stack 7.4.7 on native path.")
        else:
            print(f"   → Redis 8 is {abs(diff):.2f}ms slower than Redis Stack 7.4.7 on native path.")

    # 2. Valkey workaround vs Redis 8 native
    if rvl_v and rvl_r8:
        print(f"\n2. Valkey workaround vs Redis 8 native (RedisVL p50):")
        print(f"   Valkey workaround:  {rvl_v.p50:.2f} ms  (network: {rvl_v.mean_network:.2f}ms)")
        print(f"   Redis 8 native:     {rvl_r8.p50:.2f} ms  (network: {rvl_r8.mean_network:.2f}ms)")
        delta_wka = rvl_r8.p50 - rvl_v.p50
        if rvl_r8.p50 < rvl_v.p50 * 0.85:
            print(f"   → Redis 8 native is substantially faster ({delta_wka:+.2f}ms). The Valkey workaround adds overhead.")
        elif abs(delta_wka) / rvl_v.p50 < 0.15:
            print(f"   → Within 15% ({delta_wka:+.2f}ms). The Valkey workaround is not a meaningful penalty.")
        else:
            print(f"   → Valkey workaround is {-delta_wka:.2f}ms faster than Redis 8 native.")
            print(f"      The workaround avoids VectorRangeQuery overhead; Redis 8's range-then-rank path is slower.")
    else:
        print("\n2. Redis 8 not tested (not running or skipped).")

    # 3. Embed/network/parse breakdown
    print(f"\n3. Embed / network / parse breakdown (unique queries):")
    for r in [bd_u, rvl_v, rvl_r8, rvl_legacy]:
        if r:
            print(f"   {r.label:<40}  embed={r.mean_embed:.2f}ms  network={r.mean_network:.2f}ms  parse={r.mean_parse:.2f}ms")

    # 4. Embedding cache effect
    if bd_u and bd_c:
        print(f"\n4. BetterDB embedding cache effect:")
        print(f"   Unique queries p50:  {bd_u.p50:.2f} ms  (embed cache hit rate: {bd_u.embed_cache_hit_rate:.0%})")
        print(f"   Cycling queries p50: {bd_c.p50:.2f} ms  (embed cache hit rate: {bd_c.embed_cache_hit_rate:.0%})")
        speedup = bd_u.p50 / bd_c.p50 if bd_c.p50 > 0 else 1.0
        if bd_c.embed_cache_hit_rate > 0.5 and speedup > 1.5:
            print(f"   → Embedding cache explains {speedup:.1f}x speedup on cycling queries.")
            print(f"   → BetterDB skips SBERT compute when the same prompt text is seen again.")
            print(f"   → Benchmark pairs use unique prompt_b values, so this rarely fires in practice.")
        else:
            print(f"   → Embedding cache has minimal effect at this scale (hit rate: {bd_c.embed_cache_hit_rate:.0%}).")

    # 5. Blog narrative verdict
    print(f"\n5. Blog narrative:")
    if rvl_v and rvl_r8:
        if rvl_r8.p50 < rvl_v.p50 * 0.85:
            print(f"   Redis 8 closes the gap — narrative: 'RedisVL on Redis 8 is faster than the Valkey workaround.'")
        elif rvl_r8.p50 > rvl_v.p50 * 1.15:
            print(f"   Valkey workaround is still faster on Redis 8 — narrative unchanged:")
            print(f"   'The Valkey KNN workaround beats both Redis Stack and Redis 8 native paths because")
            print(f"   it avoids the VectorRangeQuery pre-filter overhead that redisvl adds by default.'")
        else:
            print(f"   Results are at parity — narrative: 'RedisVL on Redis 8 and the Valkey workaround")
            print(f"   are equivalent; latency differences are within measurement noise.'")


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

    # Redis 8 (redis:latest) — optional, skip if not running.
    # "redis-stack" is kept as a backward-compatible alias for "redis-os".
    try:
        import redis as redis_py  # type: ignore
        rc = redis_py.Redis.from_url(stack_url, socket_connect_timeout=2)
        rc.ping()
        redis_version = rc.info("server").get("redis_version", "unknown")
        rc.close()
        print(f"→ RedisVL / Redis {redis_version} native / unique queries...")
        r = await _measure_redisvl(
            n_warmup, n, stack_url, backend="redis-os", cycling=False,
            label=f"RedisVL-redis-{redis_version}-native",
        )
        results.append(r)
    except Exception as e:
        print(f"  ⚠ Redis 8 not reachable at {stack_url}: {e}")
        print(f"  To run native comparison:")
        print(f"    docker run -d --name redis-8-bench -p 6384:6379 redis:latest")

    # Always include legacy Redis Stack numbers for side-by-side comparison.
    results.append(LEGACY_REDIS_STACK_RESULT)

    _print_table(results)
    if args.profile:
        _print_summary(results)


def main():
    parser = argparse.ArgumentParser(description="Cache adapter latency profiler")
    parser.add_argument("--profile", action="store_true",
                        help="Print the written summary with root-cause analysis after the table")
    parser.add_argument("--queries", type=int, default=200, help="Number of check() calls to measure per scenario")
    parser.add_argument("--valkey-url", default="redis://localhost:6381", help="Valkey with search module")
    parser.add_argument("--redis-stack-url",
                        default=os.environ.get("REDIS_OS_URL", os.environ.get("REDIS_STACK_URL", "redis://localhost:6384")),
                        help="Redis 8 / Redis OS URL for native comparison (REDIS_OS_URL env var)")
    args = parser.parse_args()
    asyncio.run(_run(args))  # args.profile gates the summary section


if __name__ == "__main__":
    main()
