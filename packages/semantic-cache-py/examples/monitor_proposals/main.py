"""
BetterDB Monitor — cache_propose_threshold_adjust live demo

Shows the full no-restart configuration loop:

  1. SemanticCache starts with a loose threshold (0.25) — borderline queries hit.
  2. Claude + BetterDB MCP reviews the similarity distribution and proposes a tighten:
       mcp__betterdb__cache_propose_threshold_adjust({ ... })
  3. A human approves the proposal in the Monitor web UI (or via MCP).
  4. Monitor's dispatcher writes the new threshold to Valkey:
       HSET {name}:__config threshold "0.10"
  5. SemanticCache picks up the change on the next refresh tick — no restart.
  6. The same borderline queries that were hits at 0.25 become misses at 0.10.

This demo simulates steps 4-5 locally by writing directly to Valkey.
No API key required — uses a deterministic content-word embedder.

Embedder geometry:
  Stopwords stripped. Each unique content word maps to a fixed dimension
  via DJB2 hash (dim=64). Distance formula:
    distance = 1 − K / √(N1 · N2)
  where K = shared content words, N1/N2 = word counts.
  So "capital france" (N=2) vs "capital france city" (N=3):
    distance = 1 − 2/√6 ≈ 0.184  →  HIT at 0.25, MISS at 0.10.

Prerequisites:
  Valkey with valkey-search module at localhost:6399:
    docker run -d --name valkey -p 6399:6379 valkey/valkey:8 \\
      --loadmodule /usr/lib/valkey/valkey-search.so

Usage:
  pip install betterdb-semantic-cache
  python main.py
"""
from __future__ import annotations

import asyncio
import os

import valkey.asyncio as valkey_client

from betterdb_semantic_cache import SemanticCache
from betterdb_semantic_cache.types import (
    ConfigRefreshOptions,
    EmbeddingCacheOptions,
    SemanticCacheOptions,
)

CACHE_NAME = "demo_sc"
INITIAL_THRESHOLD = 0.25  # loose — borderline queries hit
NEW_THRESHOLD = 0.10      # tight — borderline queries miss
REFRESH_INTERVAL_S = 5    # short for demo; production default is 30 s

HOST = os.environ.get("VALKEY_HOST", "localhost")
PORT = int(os.environ.get("VALKEY_PORT", "6399"))

# ── Mock embedder ─────────────────────────────────────────────────────────────
# Content-word-only, DJB2 hash, dim=64. Stopwords stripped so "pizza topping"
# has zero overlap with geography/science entries → distance = 1.0 (miss).

_STOPWORDS = {
    "what", "is", "the", "a", "an", "of", "in", "who", "how", "where",
    "when", "why", "that", "this", "it", "are", "was", "were", "be", "been",
    "do", "does", "did", "i", "you", "we", "they", "he", "she",
    "at", "as", "for", "by", "and", "or", "not", "s",
}


async def mock_embed(text: str) -> list[float]:
    dim = 64
    words = list({
        w for w in text.lower().split()
        if len(w) > 1 and w.strip("'s?.,!") not in _STOPWORDS
        # strip possessives / punctuation before checking
    })
    # Clean each word of trailing punctuation then re-filter
    cleaned: list[str] = []
    for w in text.lower().split():
        w = w.strip("'s?.,!\"")
        if len(w) > 1 and w not in _STOPWORDS:
            cleaned.append(w)
    words = list(dict.fromkeys(cleaned))  # deduplicated, order-preserving

    vec = [0.0] * dim
    for word in words:
        h = 5381
        for ch in word.encode():
            h = ((h << 5) + h + ch) & 0xFFFFFFFF
        vec[h % dim] += 1.0

    norm = sum(x * x for x in vec) ** 0.5 or 1.0
    return [x / norm for x in vec]


# ── Helpers ───────────────────────────────────────────────────────────────────

def sep(label: str = "") -> None:
    if label:
        pad = max(0, 60 - len(label) - 4)
        print(f"\n{'─' * 2} {label} {'─' * pad}")
    else:
        print("─" * 62)


def log(msg: str) -> None:
    print(f"  {msg}")


async def check_and_log(
    cache: SemanticCache,
    prompt: str,
    label: str,
    category: str = "",
) -> dict:
    from betterdb_semantic_cache.types import CacheCheckOptions
    opts = CacheCheckOptions(category=category) if category else None
    r = await cache.check(prompt, opts)
    score = f" (score: {r.similarity:.3f})" if r.similarity is not None else ""
    conf = f" [{r.confidence}]" if r.hit and r.confidence != "high" else ""
    outcome = f"HIT{conf}" if r.hit else "MISS"
    cat_label = f" [category: {category}]" if category else ""
    log(f'{label}: "{prompt[:48]}"{cat_label}  →  {outcome}{score}')
    return {"hit": r.hit, "similarity": r.similarity, "confidence": r.confidence}


async def countdown(seconds: int) -> None:
    print("  Refresh fires in: ", end="", flush=True)
    for i in range(seconds, 0, -1):
        print(f"{i}… ", end="", flush=True)
        await asyncio.sleep(1)
    print()


async def main() -> None:
    print()
    print("╔══════════════════════════════════════════════════════════════╗")
    print("║  BetterDB Monitor — cache_propose_threshold_adjust demo      ║")
    print("╚══════════════════════════════════════════════════════════════╝")
    print()

    # ── 1. Setup ──────────────────────────────────────────────────────────────
    sep("1 · Setup")

    client = valkey_client.Valkey(host=HOST, port=PORT)
    config_key = f"{CACHE_NAME}:__config"
    await client.delete(config_key)
    log(f"Cleared {config_key}")

    cache = SemanticCache(SemanticCacheOptions(
        client=client,
        embed_fn=mock_embed,
        name=CACHE_NAME,
        default_threshold=INITIAL_THRESHOLD,
        uncertainty_band=0.05,
        embedding_cache=EmbeddingCacheOptions(enabled=False),
        config_refresh=ConfigRefreshOptions(
            enabled=True,
            interval_ms=REFRESH_INTERVAL_S * 1000,
        ),
    ))
    await cache.initialize()
    log(f'SemanticCache "{CACHE_NAME}" initialized')
    log(f"default_threshold       = {INITIAL_THRESHOLD}  (loose)")
    log(f"config_refresh.interval = {REFRESH_INTERVAL_S * 1000} ms  "
        f"(production default: 30 000 ms)")
    log("Embedder: content-word overlap — stopwords stripped, DJB2 hash, dim=64")

    # ── 2. Seed entries ───────────────────────────────────────────────────────
    sep("2 · Seed cache (3 entries)")

    seeded = [
        ("What is the capital of France?",  "Paris"),           # [capital, france]
        ("Who wrote Romeo and Juliet?",      "William Shakespeare"),  # [wrote, romeo, juliet]
        ("What is the speed of light?",      "299,792 km/s"),    # [speed, light]
    ]
    for prompt, response in seeded:
        await cache.store(prompt, response)
        log(f'stored: "{prompt}" → "{response}"')

    # ── 3. Baseline queries at threshold 0.25 ─────────────────────────────────
    sep(f"3 · Baseline queries at threshold {INITIAL_THRESHOLD}")
    log("Content-word distances (predicted):")
    log("  exact match     → distance ≈ 0.000  (hit at any threshold)")
    log("  +1 extra word   → distance ≈ 0.184  (hit at 0.25, miss at 0.10)")
    log("  no shared words → distance = 1.000  (miss at any threshold)")
    print()

    await check_and_log(cache, "What is the capital of France?", "  check")
    r1 = await check_and_log(cache, "What is France's capital city?", "  check")
    r2 = await check_and_log(cache, "What is the approximate speed of light?", "  check")
    await check_and_log(cache, "What is the best pizza topping?", "  check")

    borderline_hits = sum(1 for r in [r1, r2] if r["hit"])
    print()
    log(f"Borderline queries hitting at {INITIAL_THRESHOLD}: {borderline_hits}/2")
    log("At score 0.184 the cached answer may not be the right one for the query.")
    log("The operator wants to force borderline queries to the LLM for fresh answers.")

    # ── 4. The Monitor / MCP side ─────────────────────────────────────────────
    sep("4 · Monitor agent proposes a threshold tighten via MCP")

    log("After reviewing cache_similarity_distribution and cache_threshold_recommendation,")
    log("Claude calls:")
    print()
    print(f'  mcp__betterdb__cache_propose_threshold_adjust({{')
    print(f'    cache_name:    "{CACHE_NAME}",')
    print(f'    new_threshold: {NEW_THRESHOLD},')
    print(f'    reasoning: "Two query clusters land at cosine distance ~0.18 —')
    print(f'               just inside the 0.25 threshold. Tightening to 0.10')
    print(f'               eliminates borderline matches and forces the LLM to')
    print(f'               answer them fresh, improving answer reliability."')
    print(f'  }})')
    print()
    log("→ Monitor creates a pending proposal  (status: pending).")
    log("→ A human reviews it in the Monitor UI and clicks Approve.")
    log("→ Monitor's dispatcher applies the proposal immediately.")

    # ── 5. Simulate the dispatcher write ──────────────────────────────────────
    sep("5 · Dispatcher writes to Valkey (simulated)")

    # Exact call CacheApplyDispatcher.applySemanticThresholdAdjust() makes:
    await client.hset(config_key, "threshold", str(NEW_THRESHOLD))
    log(f"HSET {config_key}")
    log(f'      threshold = "{NEW_THRESHOLD}"')
    log("")
    log("The SemanticCache process has NOT been restarted.")
    log(f"It will pick up the change on the next refresh tick ({REFRESH_INTERVAL_S} s).")

    # ── 6. Wait for refresh ───────────────────────────────────────────────────
    sep("6 · Waiting for refresh tick")
    await countdown(REFRESH_INTERVAL_S)

    # ── 7. Verify threshold updated ───────────────────────────────────────────
    sep("7 · Verify — threshold updated without restart")

    log(f"cache._default_threshold  before: {INITIAL_THRESHOLD}")
    log(f"cache._default_threshold  after:  {cache._default_threshold}")

    if abs(cache._default_threshold - NEW_THRESHOLD) < 0.001:
        log(f"✓  Threshold is now {cache._default_threshold} — change is live.")
    else:
        log(f"✗  Threshold not updated (got: {cache._default_threshold})")

    # ── 8. Same queries at new threshold ──────────────────────────────────────
    sep(f"8 · Same queries at tighter threshold {NEW_THRESHOLD}")
    print()

    await check_and_log(cache, "What is the capital of France?", "  check")
    after1 = await check_and_log(cache, "What is France's capital city?", "  check")
    after2 = await check_and_log(cache, "What is the approximate speed of light?", "  check")
    await check_and_log(cache, "What is the best pizza topping?", "  check")

    hits_after = sum(1 for r in [after1, after2] if r["hit"])
    print()
    log(f"Borderline queries hitting at {NEW_THRESHOLD}: {hits_after}/2")
    if hits_after < borderline_hits:
        log(f"✓  {borderline_hits - hits_after} borderline match(es) eliminated — those queries")
        log("   will now reach the LLM for a fresh answer. Zero downtime.")

    # ── 9. Per-category override ──────────────────────────────────────────────
    sep("9 · Bonus — per-category override")

    log("Monitor can also propose a per-category threshold:")
    print()
    print(f'  mcp__betterdb__cache_propose_threshold_adjust({{')
    print(f'    cache_name:    "{CACHE_NAME}",')
    print(f'    new_threshold: 0.22,')
    print(f'    category:      "geography",')
    print(f'    reasoning:     "Geography queries tolerate slightly looser matching')
    print(f'                   because place names have many valid phrasings."')
    print(f'  }})')
    print()

    await client.hset(config_key, "threshold:geography", "0.22")
    log(f"HSET {config_key} threshold:geography 0.22  (simulated dispatch)")

    await countdown(REFRESH_INTERVAL_S)

    log(f"Global threshold:     {cache._default_threshold}    (unchanged)")
    log(f"Geography threshold:  {cache._category_thresholds.get('geography', '(not set)')}")
    print()

    await check_and_log(cache, "What is France's capital city?", "  check (no category)")
    await check_and_log(cache, "What is France's capital city?", "  check (geography)",
                        category="geography")

    # ── Cleanup ───────────────────────────────────────────────────────────────
    sep()
    log("Flushing demo cache...")
    await cache.flush()
    log("Done.")
    log("")
    log("In production:")
    log("  • Keep config_refresh.interval_ms at the default 30 000 ms.")
    log("  • Use Monitor's MCP tools or web UI to create and approve proposals.")
    log("  • Changes propagate to all running instances within one refresh window.")
    log("  • Per-category overrides let you tune different query domains independently.")

    await client.aclose()


if __name__ == "__main__":
    asyncio.run(main())
