"""
Validation gate: reproduce vCache static-threshold baseline F1.

Before running, fill in validate_targets.yaml with the F1 from
vCache (arXiv 2502.03771) Table 2, static-threshold baseline row,
all-MiniLM-L6-v2 column.

Exit 0 if all adapters pass, 1 otherwise.
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import yaml

from cache_benchmark.adapters.betterdb import BetterDBAdapter
from cache_benchmark.adapters.gptcache_adapter import GPTCacheAdapter
from cache_benchmark.adapters.redisvl_adapter import RedisVLAdapter
from cache_benchmark.datasets.vcache_lmarena import load_vcache_lmarena
from cache_benchmark.harness import run_replay
from cache_benchmark.metrics import compute_metrics

TARGETS_FILE = Path(__file__).parent.parent.parent.parent / "validate_targets.yaml"


async def validate_against_vcache(redis_url: str = "redis://localhost:6381") -> bool:
    config = yaml.safe_load(TARGETS_FILE.read_text())
    cfg = config["vcache_lmarena"]
    threshold = cfg["threshold"]
    embedding_model = cfg["embedding_model"]
    expected_f1 = cfg["expected"]["static_threshold_baseline_f1"]
    tolerance = cfg["expected"]["tolerance"]

    if expected_f1 == 0.0:
        print("ERROR: validate_targets.yaml has expected F1 = 0.0.")
        print("  Fill in static_threshold_baseline_f1 from vCache (arXiv 2502.03771) Table 2.")
        return False

    low = expected_f1 * (1 - tolerance)
    high = expected_f1 * (1 + tolerance)
    print(f"Expected F1: {expected_f1:.4f}  Acceptable range: [{low:.4f}, {high:.4f}]")
    print(f"Threshold: {threshold}  Model: {embedding_model}\n")

    pairs = load_vcache_lmarena()
    print(f"Loaded {len(pairs)} pairs from SemBenchmarkLmArena\n")

    adapters = [
        BetterDBAdapter(threshold=threshold, embedding_model=embedding_model, redis_url=redis_url),
        RedisVLAdapter(threshold=threshold, embedding_model=embedding_model, redis_url=redis_url),
        GPTCacheAdapter(threshold=threshold, embedding_model=embedding_model),
    ]

    all_pass = True
    for adapter in adapters:
        results = await run_replay(adapter, pairs)
        await adapter.close()
        m = compute_metrics(results)
        passed = low <= m.f1 <= high
        status = "PASS" if passed else "FAIL"
        if not passed:
            all_pass = False
        print(
            f"[{adapter.name:10s}] F1={m.f1:.4f}  precision={m.precision:.4f}  recall={m.recall:.4f}  "
            f"fpr={m.false_positive_rate:.4f}  -> {status}"
        )

    print()
    print("Overall:", "PASS" if all_pass else "FAIL")
    return all_pass


if __name__ == "__main__":
    redis_url = sys.argv[1] if len(sys.argv) > 1 else "redis://localhost:6379"
    ok = asyncio.run(validate_against_vcache(redis_url=redis_url))
    sys.exit(0 if ok else 1)
