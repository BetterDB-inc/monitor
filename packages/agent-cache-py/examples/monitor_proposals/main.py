"""
BetterDB Monitor — cache_propose_tool_ttl_adjust live demo

Shows the full no-restart configuration loop:

  1. AgentCache starts with no TTL on the "search" tool (policy-free).
  2. Claude + BetterDB MCP observes high hit rates and proposes a TTL:
       mcp__betterdb__cache_propose_tool_ttl_adjust({ ... })
  3. A human approves the proposal in the Monitor web UI (or via MCP).
  4. Monitor's dispatcher writes the new policy to Valkey:
       HSET {name}:__tool_policies search '{"ttl":3600}'
  5. AgentCache picks up the change on the next refresh tick — no restart.

This demo simulates steps 4-5 locally by writing directly to Valkey, so
you can see the full cycle without running Monitor itself.

Prerequisites:
  Valkey (standalone) at localhost:6379:
    docker run -d --name valkey -p 6379:6379 valkey/valkey:8

Usage:
  pip install betterdb-agent-cache
  python main.py
"""
from __future__ import annotations

import asyncio
import json
import os

import valkey.asyncio as valkey_client

from betterdb_agent_cache import AgentCache
from betterdb_agent_cache.types import AgentCacheOptions, ConfigRefreshOptions

CACHE_NAME = "demo_ac"
TOOL_NAME = "search"
NEW_TTL_SECONDS = 3600
REFRESH_INTERVAL_S = 5  # short for the demo; production default is 30 s

HOST = os.environ.get("VALKEY_HOST", "localhost")
PORT = int(os.environ.get("VALKEY_PORT", "6379"))


def sep(label: str = "") -> None:
    if label:
        pad = max(0, 60 - len(label) - 4)
        print(f"\n{'─' * 2} {label} {'─' * pad}")
    else:
        print("─" * 62)


def log(msg: str) -> None:
    print(f"  {msg}")


async def countdown(seconds: int) -> None:
    print("  Refresh fires in: ", end="", flush=True)
    for i in range(seconds, 0, -1):
        print(f"{i}… ", end="", flush=True)
        await asyncio.sleep(1)
    print()


async def main() -> None:
    print()
    print("╔══════════════════════════════════════════════════════════╗")
    print("║  BetterDB Monitor — cache_propose_tool_ttl_adjust demo  ║")
    print("╚══════════════════════════════════════════════════════════╝")
    print()

    # ── 1. Setup ──────────────────────────────────────────────────────────────
    sep("1 · Setup")

    client = valkey_client.Valkey(host=HOST, port=PORT)
    policies_key = f"{CACHE_NAME}:__tool_policies"
    await client.delete(policies_key)
    log(f"Cleared {policies_key}")

    cache = AgentCache(AgentCacheOptions(
        client=client,
        name=CACHE_NAME,
        config_refresh=ConfigRefreshOptions(
            enabled=True,
            interval_ms=REFRESH_INTERVAL_S * 1000,
        ),
    ))
    log(f'AgentCache "{CACHE_NAME}" created')
    log(f"config_refresh.interval_ms = {REFRESH_INTERVAL_S * 1000} ms  "
        f"(production default: 30 000 ms)")

    # ── 2. Normal operation — no TTL policy ───────────────────────────────────
    sep('2 · Normal operation (no TTL policy on "search")')

    args1 = {"query": "Paris weather today"}
    args2 = {"query": "London weather today"}

    await cache.tool.store(TOOL_NAME, args1, json.dumps({"temp": "22°C", "sky": "sunny"}))
    log(f"store: search({json.dumps(args1)}) → cached")

    await cache.tool.store(TOOL_NAME, args2, json.dumps({"temp": "15°C", "sky": "cloudy"}))
    log(f"store: search({json.dumps(args2)}) → cached")

    hit = await cache.tool.check(TOOL_NAME, args1)
    log(f"check: search({json.dumps(args1)}) → {'HIT ✓' if hit.hit else 'MISS'}")

    initial_policy = cache.tool.get_policy(TOOL_NAME)
    log(f'\n  tool.get_policy("{TOOL_NAME}") = '
        f'{json.dumps({"ttl": initial_policy.ttl}) if initial_policy else "None (no TTL applied)"}')
    log("  Entries stored without EX — they never expire.")

    # ── 3. The Monitor / MCP side ─────────────────────────────────────────────
    sep("3 · Monitor agent proposes a TTL via MCP")

    log("Claude, connected to BetterDB Monitor via MCP, calls:")
    print()
    print(f'  mcp__betterdb__cache_propose_tool_ttl_adjust({{')
    print(f'    cache_name:      "{CACHE_NAME}",')
    print(f'    tool_name:       "{TOOL_NAME}",')
    print(f'    new_ttl_seconds: {NEW_TTL_SECONDS},')
    print(f'    reasoning: "search tool hit rate is 89% over 7 days — capping')
    print(f'                at 1 h TTL controls memory and keeps data fresh."')
    print(f'  }})')
    print()
    log("→ Monitor creates a pending proposal (status: pending).")
    log("→ A human reviews it in the Monitor UI and clicks Approve.")
    log("→ Monitor's dispatcher applies the proposal immediately.")

    # ── 4. Simulate the dispatcher write ──────────────────────────────────────
    sep("4 · Dispatcher writes to Valkey (simulated)")

    policy_json = json.dumps({"ttl": NEW_TTL_SECONDS})
    # Exact call CacheApplyDispatcher.applyAgentToolTtlAdjust() makes:
    await client.hset(policies_key, TOOL_NAME, policy_json)

    log(f"HSET {policies_key}")
    log(f"      {TOOL_NAME} = {policy_json}")
    log("")
    log("The running AgentCache process has NOT been restarted.")
    log(f"It will pick up the change within {REFRESH_INTERVAL_S} s.")

    # ── 5. Wait for refresh ───────────────────────────────────────────────────
    sep("5 · Waiting for refresh tick")
    await countdown(REFRESH_INTERVAL_S)

    # ── 6. Verify ─────────────────────────────────────────────────────────────
    sep("6 · Verify — policy active without restart")

    updated_policy = cache.tool.get_policy(TOOL_NAME)
    log(f'tool.get_policy("{TOOL_NAME}") = '
        f'{json.dumps({"ttl": updated_policy.ttl}) if updated_policy else "None"}')

    if updated_policy and updated_policy.ttl == NEW_TTL_SECONDS:
        log(f"✓  TTL updated to {NEW_TTL_SECONDS} s — change is live.")
    else:
        log(f"✗  Policy not updated (got: {updated_policy})")

    args3 = {"query": "Tokyo weather today"}
    key = await cache.tool.store(TOOL_NAME, args3,
                                 json.dumps({"temp": "28°C", "sky": "humid"}))
    log(f"\n  store: search({json.dumps(args3)}) → key: {key}")

    pttl = await client.pttl(key)
    if pttl > 0:
        log(f"  PTTL on stored key: {round(pttl / 1000)} s  ✓  (EX {NEW_TTL_SECONDS} applied)")
    else:
        log(f"  PTTL: {pttl}  (negative = key not found or no expiry set)")

    # ── 7. Stats ──────────────────────────────────────────────────────────────
    sep("7 · Cache stats")

    stats = await cache.stats()
    log(f"LLM:  {stats.llm.hits} hits / {stats.llm.misses} misses")
    log(f"Tool: {stats.tool.hits} hits / {stats.tool.misses} misses  "
        f"({stats.tool.hit_rate * 100:.0f}% hit rate)")

    sep()
    log("Done. The full loop ran without a process restart.")
    log("")
    log("In production:")
    log("  • Keep config_refresh.interval_ms at the default 30 000 ms.")
    log("  • Use Monitor's MCP tools or web UI to create and approve proposals.")
    log("  • Changes propagate to all running instances within one refresh window.")

    await cache.shutdown()
    await client.aclose()


if __name__ == "__main__":
    asyncio.run(main())
