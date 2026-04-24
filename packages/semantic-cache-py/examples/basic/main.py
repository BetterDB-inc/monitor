"""Basic semantic cache example for betterdb-semantic-cache

Mirrors the TS basic example exactly, including the mock embedder algorithm.

Run without API key:
  python examples/basic/main.py

Prerequisites:
  - Valkey 8.0+ with valkey-search at localhost:6379
"""
from __future__ import annotations

import asyncio
import math
import os
import re
import sys


# ── Mock embedder (exact port of basic/mock-embedder.ts) ─────────────────────

DIM = 128

STOP_WORDS = {
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'do', 'for',
    'from', 'had', 'has', 'have', 'he', 'her', 'his', 'how', 'i', 'if', 'in',
    'is', 'it', 'its', 'me', 'my', 'no', 'not', 'of', 'on', 'or', 'our',
    'she', 'so', 'than', 'that', 'the', 'their', 'them', 'then', 'there',
    'these', 'they', 'this', 'to', 'us', 'was', 'we', 'what', 'when', 'where',
    'which', 'who', 'will', 'with', 'would', 'you', 'your',
}


def _hash_to_index(s: str, max_dim: int) -> int:
    """djb2 XOR variant — exact port of TS hashToIndex."""
    h = 5381
    for ch in s:
        h = (((h << 5) + h) ^ ord(ch)) & 0xFFFFFFFF
    return h % max_dim


def _tokenise(text: str) -> list[str]:
    tokens = re.sub(r'[^\w\s]', ' ', text.lower()).split()
    return [t for t in tokens if len(t) > 1 and t not in STOP_WORDS]


def _normalise(vec: list[float]) -> list[float]:
    norm = math.sqrt(sum(v * v for v in vec))
    if norm == 0:
        return vec
    return [v / norm for v in vec]


def _mock_embed_sync(text: str) -> list[float]:
    vec = [0.0] * DIM
    tokens = _tokenise(text)
    if not tokens:
        return _normalise(vec)
    for token in tokens:
        primary = _hash_to_index(token, DIM)
        vec[primary] += 1.0
        secondary = _hash_to_index(token + str(len(token)), DIM)
        vec[secondary] += 0.5
    return _normalise(vec)


async def mock_embed(text: str) -> list[float]:
    return _mock_embed_sync(text)


def tokenise(text: str) -> list[str]:
    return _tokenise(text)


# ── Mock reason helper (mirrors TS mockReason) ────────────────────────────────

STORED_PROMPTS = [
    'What is the capital of France?',
    'Who wrote Romeo and Juliet?',
    'What is the speed of light?',
]


def mock_reason(prompt: str, result) -> str:
    query_tokens = set(tokenise(prompt))
    if not result.hit:
        all_stored = [t for p in STORED_PROMPTS for t in tokenise(p)]
        shared = list({t for t in all_stored if t in query_tokens})
        if not shared:
            return '\n  (mock: no shared words with stored prompts)'
        return f'\n  (mock: shares words [{", ".join(shared[:4])}] but above threshold)'
    matched = [t for p in STORED_PROMPTS for t in tokenise(p) if t in query_tokens]
    unique = list(dict.fromkeys(matched))
    if not unique:
        return '\n  (mock: vector collision — no obvious shared words)'
    return f'\n  (mock: shared words — {", ".join(unique[:4])})'


# ── Main ──────────────────────────────────────────────────────────────────────

async def main() -> None:
    import valkey.asyncio as valkey

    from betterdb_semantic_cache import SemanticCache, SemanticCacheOptions
    from betterdb_semantic_cache.types import CacheStoreOptions

    USE_MOCK = "--mock" in sys.argv or os.environ.get("MOCK_EMBEDDINGS") == "true"

    # For now we only support mock mode (no Voyage embed configured)
    USE_MOCK = True

    if USE_MOCK:
        print("━" * 57)
        print("  MOCK MODE — no API key needed")
        print()
        print("  ⚠  Uses WORD OVERLAP, not semantic understanding.")
        print("  A hit occurs when prompts share tokens — not because")
        print("  the embedder understands meaning. Real embedding models")
        print("  will produce different results for some queries.")
        print()
        print(f"  Threshold: 0.25 (mock) vs 0.10 (real mode default)")
        print("  Run without --mock to use Voyage AI voyage-3-lite.")
        print("━" * 57)
        print()
    else:
        print("Running with Voyage AI voyage-3-lite")
    print()

    threshold = 0.25 if USE_MOCK else 0.10

    host = os.environ.get("VALKEY_HOST", "localhost")
    port = int(os.environ.get("VALKEY_PORT", "6379"))
    client = valkey.Valkey(host=host, port=port)

    embed_fn = mock_embed  # could swap for voyage embed

    cat_thresholds = (
        {"geography": 0.25, "literature": 0.25, "science": 0.25}
        if USE_MOCK
        else {"geography": 0.12, "literature": 0.12, "science": 0.10}
    )

    cache = SemanticCache(SemanticCacheOptions(
        client=client,
        embed_fn=embed_fn,
        name="example_basic",
        default_threshold=threshold,
        default_ttl=300,
        category_thresholds=cat_thresholds,
    ))

    # -- Initialize --
    print("Initializing cache...")
    await cache.initialize()
    print("Cache initialized.\n")

    # -- Store entries --
    print("Storing 3 prompt/response pairs...")

    await cache.store("What is the capital of France?", "Paris",
                      CacheStoreOptions(category="geography", model="claude-sonnet-4-6"))
    print('  Stored: "What is the capital of France?" -> "Paris" [geography]')

    await cache.store("Who wrote Romeo and Juliet?", "William Shakespeare",
                      CacheStoreOptions(category="literature", model="claude-sonnet-4-6"))
    print('  Stored: "Who wrote Romeo and Juliet?" -> "William Shakespeare" [literature]')

    await cache.store("What is the speed of light?", "Approximately 299,792 kilometres per second",
                      CacheStoreOptions(category="science", model="claude-sonnet-4-6"))
    print('  Stored: "What is the speed of light?" -> "Approximately 299,792 km/s" [science]')
    print()

    # -- Check 1: Exact match --
    q1 = "What is the capital of France?"
    print(f'[check 1] "{q1}"')
    r1 = await cache.check(q1)
    if r1.hit:
        sim = f"{r1.similarity:.4f}" if r1.similarity is not None else "N/A"
        print(f"  hit: true | confidence: {r1.confidence} | similarity: {sim} | response: {r1.response}{mock_reason(q1, r1)}")
    else:
        sim = f"{r1.similarity:.4f}" if r1.similarity is not None else "N/A"
        print(f"  hit: false | similarity: {sim}{mock_reason(q1, r1)}")
    print()

    # -- Check 2: Paraphrase --
    q2 = "Capital city of France?"
    print(f'[check 2] "{q2}"')
    r2 = await cache.check(q2)
    if r2.hit:
        sim = f"{r2.similarity:.4f}" if r2.similarity is not None else "N/A"
        print(f"  hit: true | confidence: {r2.confidence} | similarity: {sim} | response: {r2.response}{mock_reason(q2, r2)}")
    elif r2.nearest_miss:
        print(f"  hit: false | nearest miss: {r2.nearest_miss.similarity:.4f} (delta: +{r2.nearest_miss.delta_to_threshold:.4f}){mock_reason(q2, r2)}")
    else:
        print(f"  hit: false{mock_reason(q2, r2)}")
    print()

    # -- Check 3: Different topic --
    q3 = "Who wrote Hamlet?"
    print(f'[check 3] "{q3}"')
    r3 = await cache.check(q3)
    if r3.hit:
        sim = f"{r3.similarity:.4f}" if r3.similarity is not None else "N/A"
        print(f"  hit: true | confidence: {r3.confidence} | similarity: {sim} | response: {r3.response}{mock_reason(q3, r3)}")
    elif r3.nearest_miss:
        print(f"  hit: false | nearest miss: {r3.nearest_miss.similarity:.4f} (delta: +{r3.nearest_miss.delta_to_threshold:.4f}){mock_reason(q3, r3)}")
    else:
        print(f"  hit: false{mock_reason(q3, r3)}")
    print()

    # -- Check 4: Unrelated --
    q4 = "What is the best pizza topping?"
    print(f'[check 4] "{q4}"')
    r4 = await cache.check(q4)
    if r4.hit:
        sim = f"{r4.similarity:.4f}" if r4.similarity is not None else "N/A"
        print(f"  hit: true | confidence: {r4.confidence} | similarity: {sim} | response: {r4.response}{mock_reason(q4, r4)}")
    elif r4.nearest_miss:
        print(f"  hit: false | nearest miss: {r4.nearest_miss.similarity:.4f} (delta: +{r4.nearest_miss.delta_to_threshold:.4f}){mock_reason(q4, r4)}")
    else:
        print(f"  hit: false{mock_reason(q4, r4)}")
    print()

    # -- Stats --
    stats = await cache.stats()
    print(f"Cache stats: {stats.hits} hits / {stats.total} lookups ({stats.hit_rate * 100:.1f}% hit rate)")
    print()

    # -- Index info --
    info = await cache.index_info()
    print(f"Index: {info.name}, docs: {info.num_docs}, dimension: {info.dimension}, state: {info.indexing_state}")
    print()

    # -- Cleanup --
    print("Flushing cache...")
    await cache.flush()
    print("Done.")

    await client.aclose()


if __name__ == "__main__":
    asyncio.run(main())
