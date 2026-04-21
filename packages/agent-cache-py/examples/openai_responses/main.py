"""
OpenAI Responses API + betterdb-agent-cache example

Demonstrates LLM caching with the OpenAI Responses API (beta):
  1. Text-only call — responses cached by prompt hash
  2. Tool call      — function_call items round-tripped through cache

Usage:
  docker run -d --name valkey -p 6379:6379 valkey/valkey:8
  pip install betterdb-agent-cache[openai]
  export OPENAI_API_KEY=sk-...
  python main.py
"""
from __future__ import annotations

import asyncio
import json

import valkey.asyncio as valkey_client
from openai import AsyncOpenAI

from betterdb_agent_cache import AgentCache, ModelCost, TierDefaults, compose_normalizer, hash_base64
from betterdb_agent_cache.adapters.openai_responses import OpenAIResponsesPrepareOptions, prepare_params
from betterdb_agent_cache.types import AgentCacheOptions, LlmStoreOptions

_opts = OpenAIResponsesPrepareOptions(normalizer=compose_normalizer({"base64": hash_base64}))


async def respond(params: dict, cache: AgentCache, openai: AsyncOpenAI) -> str:
    cache_params = await prepare_params(params, _opts)
    cached = await cache.llm.check(cache_params)

    if cached.hit:
        print(f"  [cache HIT]  {str(cached.response)[:60]}")
        return cached.response or ""

    print("  [cache MISS] calling OpenAI Responses…")
    response = await openai.responses.create(**params)

    # Extract text from output items
    text = " ".join(
        item.content[0].text
        for item in (response.output or [])
        if getattr(item, "type", None) == "message"
        and item.content
        and item.content[0].type == "output_text"
    )

    # Build blocks from output
    blocks = []
    for item in response.output or []:
        t = getattr(item, "type", None)
        if t == "message" and item.content:
            for part in item.content:
                if getattr(part, "type", None) == "output_text":
                    blocks.append({"type": "text", "text": part.text})
        elif t == "function_call":
            try:
                args = json.loads(item.arguments or "{}")
            except json.JSONDecodeError:
                args = {"__raw": item.arguments}
            blocks.append({"type": "tool_call", "id": item.call_id,
                           "name": item.name, "args": args})
        elif t == "reasoning":
            summary_text = " ".join(
                s.text for s in (item.summary or [])
                if getattr(s, "type", None) == "reasoning_text"
            )
            blocks.append({"type": "reasoning", "text": summary_text})

    await cache.llm.store_multipart(cache_params, blocks, LlmStoreOptions(tokens={
        "input":  response.usage.input_tokens  if response.usage else 0,
        "output": response.usage.output_tokens if response.usage else 0,
    }))

    return text


async def main() -> None:
    client = valkey_client.Valkey(host="localhost", port=6399)
    cache = AgentCache(AgentCacheOptions(
        client=client,
        tier_defaults={"llm": TierDefaults(ttl=3600)},
        cost_table={
            "gpt-4o":      ModelCost(input_per_1k=0.0025,  output_per_1k=0.01),
            "gpt-4o-mini": ModelCost(input_per_1k=0.00015, output_per_1k=0.0006),
        },
    ))
    openai = AsyncOpenAI()
    model = "gpt-4o-mini"

    print("\n=== 1. Text-only (run twice to see cache hit) ===")
    for _ in range(2):
        r = await respond({"model": model, "input": "What is 2+2? Answer in one word."}, cache, openai)
        print(f"  Response: {r}")

    print("\n=== 2. Tool call via Responses API ===")
    await respond({
        "model": model,
        "input": "What is the weather in Paris?",
        "tools": [{"type": "function", "name": "get_weather",
                   "description": "Get current weather",
                   "parameters": {"type": "object",
                                  "properties": {"location": {"type": "string"}},
                                  "required": ["location"]}}],
        "tool_choice": "auto",
    }, cache, openai)

    stats = await cache.stats()
    print(f"\n-- Cache Stats --")
    print(f"LLM:        {stats.llm.hits} hits / {stats.llm.misses} misses ({stats.llm.hit_rate:.0%})")
    print(f"Cost saved: ${stats.cost_saved_micros / 1_000_000:.6f}")

    await cache.shutdown()
    await client.aclose()


if __name__ == "__main__":
    asyncio.run(main())
