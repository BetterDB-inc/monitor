"""LLM-as-judge example for betterdb-semantic-cache

Demonstrates the judge option for adjudicating borderline cache hits.

Uses a mock judge function — no API key or LLM required. Replace
mock_judge with a real LLM call (e.g. OpenAI chat completions) in production.

Prerequisites:
  - Valkey 8.0+ with valkey-search at localhost:6379

Usage:
  python examples/judge/main.py
"""
from __future__ import annotations

import asyncio
import math
import os
import re


# charcode 16-dim mock embedder — same strategy as the rerank example so
# paraphrases land close but not identical, triggering the uncertainty band.
def _mock_embed(text: str) -> list[float]:
    words = [w for w in re.split(r"\W+", text.lower()) if w]
    dim = 16
    vec = [0.0] * dim
    for w in words:
        for i in range(min(len(w), dim)):
            vec[i % dim] += ord(w[i]) / 128.0
    norm = math.sqrt(sum(x * x for x in vec)) or 1.0
    return [x / norm for x in vec]


async def mock_embed(text: str) -> list[float]:
    return _mock_embed(text)


# Mock judge: accepts if the response shares at least 2 words with the prompt.
# Replace this with a real LLM call in production (e.g. ask the model whether
# the cached response adequately answers the new question).
async def mock_judge(input: dict) -> bool:
    prompt_words = set(re.split(r"\W+", input["prompt"].lower())) - {""}
    response_words = re.split(r"\W+", input["response"].lower())
    overlap = sum(1 for w in response_words if w in prompt_words)
    accept = overlap >= 2
    print(
        f"  [judge] similarity={input['similarity']:.4f}"
        f"  overlap={overlap}"
        f"  → {'ACCEPT' if accept else 'REJECT'}"
    )
    return accept


def log_result(result: object) -> None:
    from betterdb_semantic_cache import CacheCheckResult
    r: CacheCheckResult = result  # type: ignore[assignment]
    if r.hit:
        print(f"  → HIT   confidence={r.confidence}  distance={r.similarity:.4f}")
        print(f"           matched: \"{r.response}\"")
    elif r.similarity is not None:
        nm = r.nearest_miss
        delta = f"  delta_to_threshold={nm.delta_to_threshold:.4f}" if nm else ""
        print(f"  → MISS  nearest distance={r.similarity:.4f}{delta}")
    else:
        print("  → MISS  (no candidate found)")


async def main() -> None:
    import valkey.asyncio as valkey

    from betterdb_semantic_cache import (
        JudgeOptions,
        SemanticCache,
        SemanticCacheOptions,
    )
    from betterdb_semantic_cache.types import CacheCheckOptions, EmbeddingCacheOptions

    host = os.environ.get("VALKEY_HOST", "localhost")
    port = int(os.environ.get("VALKEY_PORT", "6379"))
    client = valkey.Valkey(host=host, port=port)

    # Loose threshold so paraphrases are borderline hits, not clear misses.
    # uncertainty_band=0.08 → judge fires when 0.22 < distance <= 0.30.
    cache = SemanticCache(SemanticCacheOptions(
        client=client,
        embed_fn=mock_embed,
        name="example_judge",
        default_threshold=0.30,
        uncertainty_band=0.08,
        embedding_cache=EmbeddingCacheOptions(enabled=False),
    ))

    print("=== LLM-as-judge example ===\n")

    await cache.initialize()
    await cache.flush()
    await cache.initialize()
    print("Cache initialized.\n")

    entries = [
        ("What is the capital of France?", "The capital of France is Paris."),
        ("How does photosynthesis work?", "Photosynthesis converts sunlight into energy in plants."),
    ]
    for prompt, response in entries:
        await cache.store(prompt, response)
    print("Seeded entries:")
    for prompt, _ in entries:
        print(f'  • "{prompt}"')
    print()

    judge_opts = JudgeOptions(judge_fn=mock_judge, on_error="accept", timeout_ms=5000)

    # 1. Paraphrase — likely borderline hit, judge fires
    q1 = "What is France's capital city?"
    print(f'Query: "{q1}"  (paraphrase — judge may fire)')
    r1 = await cache.check(q1, CacheCheckOptions(judge=judge_opts))
    log_result(r1)
    print()

    # 2. Unrelated — clear miss, judge not invoked
    q2 = "What is the speed of light?"
    print(f'Query: "{q2}"  (unrelated — judge not invoked)')
    r2 = await cache.check(q2, CacheCheckOptions(judge=judge_opts))
    log_result(r2)
    print()

    # 3. Exact match — high-confidence hit, judge not invoked
    q3 = "How does photosynthesis work?"
    print(f'Query: "{q3}"  (exact match — judge not invoked)')
    r3 = await cache.check(q3, CacheCheckOptions(judge=judge_opts))
    log_result(r3)
    print()

    # 4. check_batch() raises when judge is supplied
    print("check_batch() with judge raises SemanticCacheUsageError:")
    from betterdb_semantic_cache import SemanticCacheUsageError
    try:
        await cache.check_batch(["hello"], CacheCheckOptions(judge=judge_opts))
    except SemanticCacheUsageError as e:
        print(f"  ✓ {e}")

    await cache.flush()
    await client.aclose()


if __name__ == "__main__":
    asyncio.run(main())
