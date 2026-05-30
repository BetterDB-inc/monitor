"""
Pydantic AI + betterdb-agent-cache example

Demonstrates caching Pydantic AI agent responses with three scenarios:
  1. Simple text agent       — responses cached by prompt hash
  2. Agent with tools        — tool calls round-trip through cache
  3. Multi-turn conversation — conversation state cached across turns

Usage:
  docker run -d --name valkey -p 6379:6379 valkey/valkey:8
  pip install "betterdb-agent-cache[pydantic_ai]"
  export OPENAI_API_KEY=sk-...
  python main.py
"""
from __future__ import annotations

import asyncio

import valkey.asyncio as valkey_client
from pydantic_ai import Agent, RunContext
from pydantic_ai.models.openai import OpenAIModel

from betterdb_agent_cache import AgentCache, ModelCost, TierDefaults
from betterdb_agent_cache.adapters.pydantic_ai import CachedModel
from betterdb_agent_cache.types import AgentCacheOptions


async def main() -> None:
    client = valkey_client.Valkey(host="localhost", port=6379)
    cache = AgentCache(AgentCacheOptions(
        client=client,
        tier_defaults={"llm": TierDefaults(ttl=3600)},
        cost_table={"gpt-4o-mini": ModelCost(input_per_1k=0.00015, output_per_1k=0.0006)},
    ))

    base_model = OpenAIModel("gpt-4o-mini")
    cached_model = CachedModel(base_model, cache=cache)

    text_agent = Agent(cached_model, system_prompt="You are concise.")

    print("\n=== 1. Simple text agent ===")
    for _ in range(2):
        result = await text_agent.run("What is 2+2? Reply with one word.")
        print("Result:", result.output)

    tools_agent = Agent(cached_model, system_prompt="Use tools when helpful.")

    @tools_agent.tool
    def weather(ctx: RunContext[None], city: str) -> str:
        return f"Weather in {city}: sunny"

    print("\n=== 2. Agent with tools ===")
    for _ in range(2):
        result = await tools_agent.run("What is the weather in London?")
        print("Result:", result.output)

    print("\n=== 3. Multi-turn conversation ===")
    history = None
    for prompt in ("Remember my name is Amit.", "What is my name?"):
        result = await text_agent.run(prompt, message_history=history)
        history = result.new_messages()
        print("User:", prompt)
        print("Assistant:", result.output)

    stats = await cache.stats()
    print("\n-- Cache Stats --")
    print(f"LLM:        {stats.llm.hits} hits / {stats.llm.misses} misses ({stats.llm.hit_rate:.0%})")
    print(f"Cost saved: ${stats.cost_saved_micros / 1_000_000:.6f}")

    await cache.shutdown()
    await client.aclose()


if __name__ == "__main__":
    asyncio.run(main())
