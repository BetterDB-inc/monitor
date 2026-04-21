"""
Anthropic + betterdb-agent-cache example

Demonstrates multi-modal LLM caching with the Anthropic Messages API:
  1. Text-only call  — responses cached by prompt hash
  2. Vision call     — image bytes content-addressed before hashing
  3. Tool call       — tool calls cached through store_multipart

Usage:
  docker run -d --name valkey -p 6379:6379 valkey/valkey:8
  pip install betterdb-agent-cache[anthropic]
  export ANTHROPIC_API_KEY=sk-ant-...
  python main.py
"""
from __future__ import annotations

import asyncio

import valkey.asyncio as valkey_client
import anthropic as sdk

from betterdb_agent_cache import AgentCache, ModelCost, TierDefaults, compose_normalizer, hash_base64
from betterdb_agent_cache.adapters.anthropic import AnthropicPrepareOptions, prepare_params
from betterdb_agent_cache.types import AgentCacheOptions, LlmStoreOptions

_opts = AnthropicPrepareOptions(normalizer=compose_normalizer({"base64": hash_base64}))


async def chat(params: dict, cache: AgentCache, anthropic: sdk.AsyncAnthropic) -> str:
    cache_params = await prepare_params(params, _opts)
    cached = await cache.llm.check(cache_params)

    if cached.hit:
        print(f"  [cache HIT]  {str(cached.response)[:60]}")
        return cached.response or ""

    print("  [cache MISS] calling Anthropic…")
    response = await anthropic.messages.create(**params)

    blocks = []
    for block in response.content:
        if block.type == "text":
            blocks.append({"type": "text", "text": block.text})
        elif block.type == "tool_use":
            blocks.append({"type": "tool_call", "id": block.id, "name": block.name, "args": block.input})
        elif block.type == "thinking":
            blocks.append({"type": "reasoning", "text": block.thinking,
                           "opaque_signature": getattr(block, "signature", None)})

    await cache.llm.store_multipart(cache_params, blocks, LlmStoreOptions(tokens={
        "input":  response.usage.input_tokens,
        "output": response.usage.output_tokens,
    }))

    return " ".join(b["text"] for b in blocks if b.get("type") == "text")


async def main() -> None:
    client = valkey_client.Valkey(host="localhost", port=6399)
    cache = AgentCache(AgentCacheOptions(
        client=client,
        tier_defaults={"llm": TierDefaults(ttl=3600)},
        cost_table={
            "claude-opus-4-6":           ModelCost(input_per_1k=0.015,   output_per_1k=0.075),
            "claude-haiku-4-5-20251001": ModelCost(input_per_1k=0.00025, output_per_1k=0.00125),
        },
    ))
    anthropic = sdk.AsyncAnthropic()
    model = "claude-haiku-4-5-20251001"

    print("\n=== 1. Text-only (run twice to see cache hit) ===")
    for _ in range(2):
        r = await chat({"model": model, "max_tokens": 20, "messages": [
            {"role": "user", "content": "What is 2+2? One word."}
        ]}, cache, anthropic)
        print(f"  Response: {r}")

    print("\n=== 2. Vision with base64 image ===")
    red_pixel = (
        "iVBORw0KGgoAAAANSUhEUgAAADIAAAAyCAIAAACRXR/m"
        "AAAAQ0lEQVR4nO3OMQ0AMAwDsPAnvRHonxyWDMB5yaD+"
        "QEtLS0tLa0N/oKWlpaWltaE/0NLS0tLS2tAfaGlpaWlp"
        "begPTh97K7rEaOcNTQAAAABJRU5ErkJggg=="
    )
    await chat({"model": model, "max_tokens": 20, "messages": [{
        "role": "user",
        "content": [
            {"type": "text", "text": "What colour is this? One word."},
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": red_pixel}},
        ],
    }]}, cache, anthropic)

    print("\n=== 3. Tool call ===")
    await chat({"model": model, "max_tokens": 100,
        "tools": [{"name": "get_weather", "description": "Get weather",
                   "input_schema": {"type": "object",
                                    "properties": {"location": {"type": "string"}},
                                    "required": ["location"]}}],
        "messages": [{"role": "user", "content": "What is the weather in Paris?"}]
    }, cache, anthropic)

    stats = await cache.stats()
    print(f"\n-- Cache Stats --")
    print(f"LLM:        {stats.llm.hits} hits / {stats.llm.misses} misses ({stats.llm.hit_rate:.0%})")
    print(f"Cost saved: ${stats.cost_saved_micros / 1_000_000:.6f}")

    await cache.shutdown()
    await client.aclose()


if __name__ == "__main__":
    asyncio.run(main())
