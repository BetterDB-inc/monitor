"""
LangChain + betterdb-agent-cache example

Demonstrates two caching tiers:
  1. LLM response caching — identical prompts return instantly from Valkey
  2. Tool result caching  — repeated tool calls skip the (simulated) API

Usage:
  docker run -d --name valkey -p 6379:6379 valkey/valkey:8
  pip install betterdb-agent-cache[langchain] langchain-openai
  export OPENAI_API_KEY=sk-...
  python main.py
"""
from __future__ import annotations

import asyncio
import json
import random

import valkey.asyncio as valkey_client
from langchain_openai import ChatOpenAI
from langchain_core.messages import HumanMessage

from betterdb_agent_cache import AgentCache, ModelCost, TierDefaults
from betterdb_agent_cache.adapters.langchain import BetterDBLlmCache
from betterdb_agent_cache.types import AgentCacheOptions


async def main() -> None:
    client = valkey_client.Valkey(host="localhost", port=6399)
    cache = AgentCache(AgentCacheOptions(
        client=client,
        tier_defaults={
            "llm":  TierDefaults(ttl=3600),
            "tool": TierDefaults(ttl=300),
        },
        cost_table={
            "gpt-4o-mini": ModelCost(input_per_1k=0.00015, output_per_1k=0.0006),
            "gpt-4o":      ModelCost(input_per_1k=0.0025,  output_per_1k=0.01),
        },
    ))
    model = ChatOpenAI(
        model="gpt-4o-mini",
        temperature=0,
        cache=BetterDBLlmCache(cache=cache),
    )

    async def get_weather(city: str) -> str:
        cached = await cache.tool.check("get_weather", {"city": city})
        if cached.hit:
            print(f"  [tool cache HIT]  get_weather({city!r})")
            return cached.response or ""
        print(f"  [tool cache MISS] get_weather({city!r}) — calling API…")
        result = json.dumps({
            "city": city,
            "temperature": round(15 + random.random() * 15),
            "condition": random.choice(["sunny", "cloudy", "rainy"]),
        })
        await cache.tool.store("get_weather", {"city": city}, result)
        return result

    print("═══ Part 1: LLM Response Caching ═══")
    print("Same prompt twice — second call returns from Valkey.\n")
    for _ in range(2):
        start = asyncio.get_event_loop().time()
        response = await model.ainvoke([HumanMessage("What is the capital of Bulgaria?")])
        elapsed = asyncio.get_event_loop().time() - start
        print(f"  Assistant: {response.content}  ({elapsed * 1000:.0f} ms)")

    print("\n═══ Part 2: Tool Result Caching ═══")
    print("Same tool calls twice — second round served from cache.\n")
    for _ in range(2):
        await get_weather("Sofia")
        await get_weather("Berlin")
        print()

    stats = await cache.stats()
    print("── Cache Stats ──")
    print(f"LLM tier:   {stats.llm.hits} hits / {stats.llm.misses} misses ({stats.llm.hit_rate:.0%})")
    print(f"Tool tier:  {stats.tool.hits} hits / {stats.tool.misses} misses ({stats.tool.hit_rate:.0%})")
    print(f"Cost saved: ${stats.cost_saved_micros / 1_000_000:.6f}")

    await cache.shutdown()
    await client.aclose()


if __name__ == "__main__":
    asyncio.run(main())
