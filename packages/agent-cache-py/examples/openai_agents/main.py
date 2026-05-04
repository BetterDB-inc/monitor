"""
OpenAI Agents SDK + betterdb-agent-cache example

Demonstrates caching agent responses with two scenarios:
  1. Simple text agent       — responses cached by prompt hash
  2. Agent with tools        — tool calls round-trip through cache

Usage:
  docker run -d --name valkey -p 6379:6379 valkey/valkey:8
  pip install "betterdb-agent-cache[openai_agents]"
  export OPENAI_API_KEY=sk-...
  python main.py
"""
from __future__ import annotations

import asyncio

import valkey.asyncio as valkey_client
from agents import Agent, Runner, RunConfig, function_tool, OpenAIProvider

from betterdb_agent_cache import AgentCache, ModelCost, TierDefaults
from betterdb_agent_cache.adapters.openai_agents import CachedModelProvider
from betterdb_agent_cache.types import AgentCacheOptions


@function_tool
def get_weather(city: str) -> str:
    """Get the current weather for a city."""
    return f"Weather in {city}: sunny, 22°C"


async def main() -> None:
    client = valkey_client.Valkey(host="localhost", port=6379)
    cache = AgentCache(
        AgentCacheOptions(
            client=client,
            tier_defaults={"llm": TierDefaults(ttl=3600)},
            cost_table={
                "gpt-4o-mini": ModelCost(input_per_1k=0.00015, output_per_1k=0.0006),
            },
        ),
    )

    cached_provider = CachedModelProvider(OpenAIProvider(), cache=cache)
    run_config = RunConfig(model="gpt-4o-mini", model_provider=cached_provider)

    text_agent = Agent(name="Concise", instructions="You are concise.")
    print("\n=== 1. Simple text agent ===")
    for i in range(2):
        result = await Runner.run(text_agent, "What is 2+2? One word.", run_config=run_config)
        print(f"  [{i + 1}] {result.final_output}")

    tools_agent = Agent(name="Weather", instructions="Use tools.", tools=[get_weather])
    print("\n=== 2. Agent with tools ===")
    for i in range(2):
        result = await Runner.run(tools_agent, "Weather in London?", run_config=run_config)
        print(f"  [{i + 1}] {result.final_output}")

    stats = await cache.stats()
    print("\n-- Cache Stats --")
    print(
        "LLM:        "
        f"{stats.llm.hits} hits / {stats.llm.misses} misses ({stats.llm.hit_rate:.0%})",
    )
    print(f"Cost saved: ${stats.cost_saved_micros / 1_000_000:.6f}")

    await cache.shutdown()
    await client.aclose()


if __name__ == "__main__":
    asyncio.run(main())
