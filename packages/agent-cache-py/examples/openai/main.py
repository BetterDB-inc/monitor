"""
OpenAI Chat + betterdb-agent-cache example

Demonstrates multi-modal LLM caching with the OpenAI Chat Completions API:
  1. Text-only call  — responses cached by prompt hash
  2. Vision call     — image bytes content-addressed before hashing
  3. Tool call       — tool call arguments round-tripped through cache

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
from betterdb_agent_cache.adapters.openai import OpenAIPrepareOptions, prepare_params
from betterdb_agent_cache.types import AgentCacheOptions

_opts = OpenAIPrepareOptions(normalizer=compose_normalizer({"base64": hash_base64}))


async def chat(params: dict, cache: AgentCache, openai: AsyncOpenAI) -> str:
    cache_params = await prepare_params(params, _opts)
    cached = await cache.llm.check(cache_params)

    if cached.hit:
        print(f"  [cache HIT]  {str(cached.response)[:60]}")
        return cached.response or ""

    print("  [cache MISS] calling OpenAI…")
    response = await openai.chat.completions.create(**params, stream=False)
    choice = response.choices[0]

    blocks = []
    if choice.message.content:
        blocks.append({"type": "text", "text": choice.message.content})
    for tc in choice.message.tool_calls or []:
        try:
            args = json.loads(tc.function.arguments or "{}")
        except json.JSONDecodeError:
            args = {"__raw": tc.function.arguments}
        blocks.append({"type": "tool_call", "id": tc.id, "name": tc.function.name, "args": args})

    from betterdb_agent_cache.types import LlmStoreOptions
    await cache.llm.store_multipart(cache_params, blocks, LlmStoreOptions(tokens={
        "input":  response.usage.prompt_tokens     if response.usage else 0,
        "output": response.usage.completion_tokens if response.usage else 0,
    }))

    return " ".join(b["text"] for b in blocks if b.get("type") == "text")


async def main() -> None:
    # ── 1. Connect to Valkey ─────────────────────────────────────────
    client = valkey_client.Valkey(host="localhost", port=6399)

    # ── 2. Create cache ──────────────────────────────────────────────
    cache = AgentCache(AgentCacheOptions(
        client=client,
        tier_defaults={"llm": TierDefaults(ttl=3600)},
        cost_table={
            "gpt-4o":      ModelCost(input_per_1k=0.0025,  output_per_1k=0.01),
            "gpt-4o-mini": ModelCost(input_per_1k=0.00015, output_per_1k=0.0006),
        },
    ))
    openai = AsyncOpenAI()

    print("\n=== 1. Text-only (run twice to see cache hit) ===")
    for _ in range(2):
        r = await chat({"model": "gpt-4o-mini", "messages": [
            {"role": "user", "content": "What is 2+2? Answer in one word."}
        ], "max_tokens": 10}, cache, openai)
        print(f"  Response: {r}")

    print("\n=== 2. Vision with base64 data URL ===")
    red_pixel = (
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADIAAAAyCAIAAACRXR/m"
        "AAAAQ0lEQVR4nO3OMQ0AMAwDsPAnvRHonxyWDMB5yaD+QEtLS0tLa0N/oKWlpaWl"
        "taE/0NLS0tLS2tAfaGlpaWlpbegPTh97K7rEaOcNTQAAAABJRU5ErkJggg=="
    )
    await chat({"model": "gpt-4o-mini", "messages": [{
        "role": "user",
        "content": [
            {"type": "text", "text": "What colour is this? One word."},
            {"type": "image_url", "image_url": {"url": red_pixel, "detail": "low"}},
        ],
    }], "max_tokens": 10}, cache, openai)

    print("\n=== 3. Tool call ===")
    await chat({"model": "gpt-4o-mini", "messages": [
        {"role": "user", "content": "What is the weather in Paris?"}
    ], "tools": [{"type": "function", "function": {
        "name": "get_weather",
        "description": "Get current weather",
        "parameters": {"type": "object", "properties": {"location": {"type": "string"}}, "required": ["location"]},
    }}], "tool_choice": "auto", "max_tokens": 100}, cache, openai)

    stats = await cache.stats()
    print(f"\n-- Cache Stats --")
    print(f"LLM:        {stats.llm.hits} hits / {stats.llm.misses} misses ({stats.llm.hit_rate:.0%})")
    print(f"Cost saved: ${stats.cost_saved_micros / 1_000_000:.6f}")

    await cache.shutdown()
    await client.aclose()


if __name__ == "__main__":
    asyncio.run(main())
