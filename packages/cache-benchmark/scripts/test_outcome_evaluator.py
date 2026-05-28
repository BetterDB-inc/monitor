"""
Multi-cycle test for the outcome evaluator feedback loop.

Verifies that:
1. The outcome evaluator evaluates applied proposals after the window
2. The verdict (improved/degraded/neutral) is stored on the proposal record
3. The recommendation engine uses historical verdicts to block signals
   that have been proven ineffective

Requires: Valkey on port 6381, Monitor on port 3001 with a registered connection.
The Monitor must be running with the CacheOutcomeEvaluator's evaluation window
set low enough for this test (we manipulate applied_at timestamps to simulate
the window passing).

Usage:
    BETTERDB_URL=http://localhost:3001 \
    BETTERDB_TOKEN=local-dev \
    BETTERDB_INSTANCE_ID=<id> \
    uv run python scripts/test_outcome_evaluator.py
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from urllib.parse import quote as urlquote

import httpx


MONITOR_URL = os.environ.get("BETTERDB_URL", "http://localhost:3001")
TOKEN = os.environ.get("BETTERDB_TOKEN", "local-dev")
INSTANCE_ID = os.environ.get("BETTERDB_INSTANCE_ID", "")
HEADERS = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}

# We'll use the benchmark adapter to run cache operations, but drive the
# outcome evaluator by directly calling the Monitor's internal tick endpoint
# or by manipulating proposal timestamps.


async def detect_base() -> str:
    async with httpx.AsyncClient(timeout=5.0) as http:
        for prefix in ("/api", ""):
            try:
                resp = await http.get(f"{MONITOR_URL}{prefix}/mcp/instances", headers=HEADERS)
                if resp.status_code == 200:
                    return f"{MONITOR_URL}{prefix}"
            except httpx.HTTPError:
                continue
    raise RuntimeError("Monitor not reachable")


async def get(http: httpx.AsyncClient, path: str) -> dict:
    resp = await http.get(path, headers=HEADERS)
    resp.raise_for_status()
    return resp.json()


async def post(http: httpx.AsyncClient, path: str, body: dict | None = None) -> dict:
    resp = await http.post(path, headers=HEADERS, json=body or {})
    resp.raise_for_status()
    return resp.json()


async def run_cycle(
    http: httpx.AsyncClient,
    base: str,
    cache_name: str,
    cycle_num: int,
) -> dict | None:
    """Run one autotune cycle: get recommendation, propose, approve."""
    enc = urlquote(cache_name, safe="")

    # 1. Get recommendation
    rec = await get(
        http,
        f"{base}/mcp/instance/{INSTANCE_ID}/caches/{enc}/threshold-recommendation?minSamples=50",
    )
    print(f"  Cycle {cycle_num}: recommendation={rec.get('recommendation')}, "
          f"threshold={rec.get('current_threshold')}, "
          f"recommended={rec.get('recommended_threshold')}")
    print(f"    reasoning: {rec.get('reasoning', '')[:120]}")

    if rec.get("recommendation") not in ("tighten_threshold", "loosen_threshold"):
        print(f"  Cycle {cycle_num}: no actionable recommendation — stopping")
        return rec

    new_threshold = rec["recommended_threshold"]

    # 2. Propose
    propose_resp = await post(
        http,
        f"{base}/mcp/instance/{INSTANCE_ID}/cache-proposals/threshold-adjust",
        {
            "cache_name": cache_name,
            "new_threshold": new_threshold,
            "reasoning": f"Test cycle {cycle_num}: {rec['recommendation']}",
            "category": None,
        },
    )
    proposal_id = propose_resp.get("proposal_id") or propose_resp.get("id")
    print(f"  Cycle {cycle_num}: proposed {proposal_id}")

    # 3. Approve
    await post(
        http,
        f"{base}/mcp/cache-proposals/{proposal_id}/approve",
        {"actor": "test-script"},
    )
    print(f"  Cycle {cycle_num}: approved and applied")

    return rec


async def check_proposal_outcome(
    http: httpx.AsyncClient,
    base: str,
    cache_name: str,
) -> list[dict]:
    """List applied proposals and check for outcome evaluations."""
    # Use the recent-changes endpoint which returns proposals
    enc = urlquote(cache_name, safe="")
    changes = await get(
        http,
        f"{base}/mcp/instance/{INSTANCE_ID}/caches/{enc}/recent-changes?limit=20",
    )

    proposals = changes if isinstance(changes, list) else changes.get("proposals", [])
    evaluated = []
    for p in proposals:
        if p.get("status") != "applied":
            continue
        details = (p.get("applied_result") or {}).get("details", {})
        outcome = details.get("outcome_evaluation")
        if outcome:
            evaluated.append({
                "id": p.get("id"),
                "verdict": outcome.get("verdict"),
                "signal": outcome.get("signal"),
                "detail": outcome.get("detail"),
            })
    return evaluated


async def main():
    if not INSTANCE_ID:
        print("ERROR: BETTERDB_INSTANCE_ID is required")
        sys.exit(1)

    base = await detect_base()
    print(f"Monitor base: {base}")
    print(f"Instance: {INSTANCE_ID}")

    # Use the betterdb adapter to store and check pairs
    import valkey.asyncio as valkey
    from betterdb_semantic_cache import SemanticCache
    from betterdb_semantic_cache.types import (
        SemanticCacheOptions, AnalyticsOptions, DiscoveryOptions, ConfigRefreshOptions,
    )

    from cache_benchmark.datasets.stsb import load_stsb

    client = valkey.Valkey.from_url("redis://localhost:6381", decode_responses=False)

    cache_name = "test:outcome_eval"
    threshold = 0.40  # Start loose — autotuner should tighten

    # Create embedding function
    from sentence_transformers import SentenceTransformer
    model = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")

    async def embed(text: str) -> list[float]:
        return model.encode(text).tolist()

    # Load dataset
    pairs = load_stsb(limit=300)
    print(f"\nLoaded {len(pairs)} STSb pairs")

    async with httpx.AsyncClient(base_url=base, timeout=30.0) as http:

        # ── Phase 1: First cycle — store data, run autotune ──
        print("\n=== Phase 1: First autotune cycle ===")

        cache = SemanticCache(SemanticCacheOptions(
            client=client,
            embed_fn=embed,
            name=cache_name,
            default_threshold=threshold,
            analytics=AnalyticsOptions(disabled=False),
            discovery=DiscoveryOptions(enabled=True),
            config_refresh=ConfigRefreshOptions(enabled=True, interval_ms=30_000),
        ))
        await cache.initialize()
        await client.hset(f"{cache_name}:__config", mapping={"threshold": str(threshold)})

        # Store phase
        print(f"Storing {len(pairs)} prompts...")
        for p in pairs:
            await cache.store(p.prompt_a, f"Answer: {p.prompt_a}")

        # Check phase — builds the similarity window
        print(f"Checking {len(pairs)} prompts...")
        for p in pairs:
            await cache.check(p.prompt_b)

        # Run autotune cycle
        rec1 = await run_cycle(http, base, cache_name, 1)
        if not rec1 or rec1.get("recommendation") not in ("tighten_threshold", "loosen_threshold"):
            print("No adjustment in cycle 1 — test cannot proceed")
            await cache.shutdown()
            await client.aclose()
            return

        # ── Phase 2: Wait for proactive outcome evaluator ──
        print("\n=== Phase 2: Wait for proactive outcome evaluator ===")
        print("(Monitor must be running with OUTCOME_EVAL_WINDOW_MS=5000 OUTCOME_EVAL_TICK_MS=3000)")

        enc = urlquote(cache_name, safe="")

        # Wait for the evaluation window (5s) + a few tick intervals (3s each)
        wait_secs = 15
        print(f"Waiting {wait_secs}s for evaluator to tick...")
        await asyncio.sleep(wait_secs)

        # Check if the evaluator wrote the verdict
        evaluated_after_wait = await check_proposal_outcome(http, base, cache_name)
        if evaluated_after_wait:
            print(f"\n✓ Proactive evaluator fired! Found {len(evaluated_after_wait)} evaluation(s):")
            for e in evaluated_after_wait:
                print(f"  {e['id']}: verdict={e['verdict']} signal={e['signal']}")
                print(f"    {e['detail']}")
        else:
            print("\n✗ Evaluator has NOT written a verdict yet")
            # Show the raw proposal for debugging
            changes = await get(http, f"{base}/mcp/instance/{INSTANCE_ID}/caches/{enc}/recent-changes?limit=5")
            proposals = changes if isinstance(changes, list) else changes.get("proposals", [])
            for p in proposals:
                if p.get("status") == "applied":
                    details = (p.get("applied_result") or {}).get("details", {})
                    applied_at = p.get("applied_at", 0)
                    age_s = (time.time() * 1000 - applied_at) / 1000 if applied_at else 0
                    print(f"  Proposal {p['id']}: applied {age_s:.0f}s ago, outcome={details.get('outcome_evaluation', 'NONE')}")

        # ── Phase 3: Generate post-adjustment data ──
        print("\n=== Phase 3: Generate post-adjustment data ===")

        # The cache now runs at the adjusted threshold. Check more pairs
        # to build fresh similarity window data.
        pairs2 = load_stsb(limit=300)
        print(f"Checking {len(pairs2)} more prompts at new threshold...")
        for p in pairs2:
            await cache.check(p.prompt_b)

        # ── Phase 4: Second autotune cycle ──
        print("\n=== Phase 4: Second autotune cycle ===")
        rec2 = await run_cycle(http, base, cache_name, 2)

        # ── Phase 5: Verify the feedback loop ──
        print("\n=== Phase 5: Verification ===")

        # Check what the recommendation engine said
        rec_final = await get(
            http,
            f"{base}/mcp/instance/{INSTANCE_ID}/caches/{enc}/threshold-recommendation?minSamples=50",
        )
        print(f"\nFinal recommendation: {rec_final.get('recommendation')}")
        print(f"  reasoning: {rec_final.get('reasoning', '')}")
        print(f"  signal: {rec_final.get('signal')}")
        print(f"  dampening_factor: {rec_final.get('dampening_factor')}")
        print(f"  consecutive_same_direction: {rec_final.get('consecutive_same_direction')}")

        # Check for outcome evaluations on proposals (proactive evaluator)
        evaluated = await check_proposal_outcome(http, base, cache_name)
        if evaluated:
            print(f"\nProactive outcome evaluations on proposal records: {len(evaluated)}")
            for e in evaluated:
                print(f"  {e['id']}: {e['verdict']} — {e['detail']}")
        else:
            print("\nNo proactive outcome evaluations on proposal records")

        # Verify the outcome tracking (reactive check) worked
        # The checkLastOutcome in the recommendation engine fires immediately
        # (no need to wait for the evaluator) by comparing tuning history snapshots.
        history_key = f"{cache_name}:__tuning_history"
        raw_history = await client.lrange(history_key, 0, 9)
        print(f"\nTuning history entries: {len(raw_history)}")
        for i, entry in enumerate(raw_history):
            parsed = json.loads(entry)
            print(f"  [{i}] {parsed.get('d')} {parsed.get('from'):.3f} → {parsed.get('to'):.3f} "
                  f"signal={parsed.get('signal')} "
                  f"metrics={json.dumps(parsed.get('metrics', {}), default=str)[:80]}")

        # ── Summary ──
        print("\n=== Summary ===")
        cycle1_dir = rec1.get("recommendation", "?")
        cycle2_dir = rec2.get("recommendation", "?") if rec2 else "none"
        print(f"Cycle 1: {cycle1_dir} (threshold {threshold} → {rec1.get('recommended_threshold', '?')})")
        print(f"Cycle 2: {cycle2_dir}")

        if rec2 and "ineffective" in rec2.get("reasoning", "").lower():
            print("✓ Outcome tracking caught ineffective adjustment!")
        elif rec2 and rec2.get("recommendation") == "optimal":
            print(f"✓ Recommendation engine returned optimal: {rec2.get('reasoning', '')[:100]}")
        elif rec2 and rec2.get("recommendation") in ("tighten_threshold", "loosen_threshold"):
            print(f"→ Engine recommended another adjustment — outcome tracking did not block")
        else:
            print(f"→ No second cycle ran")

        # Cleanup
        await cache.flush()
        await client.delete(history_key)
        await cache.shutdown()
        await client.aclose()

    print("\nDone.")


if __name__ == "__main__":
    asyncio.run(main())
