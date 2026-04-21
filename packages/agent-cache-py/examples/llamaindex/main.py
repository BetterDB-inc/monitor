"""
LlamaIndex + betterdb-agent-cache example

Demonstrates LLM caching with the LlamaIndex OpenAI adapter:
  1. Text-only call — responses cached by prompt hash
  2. Vision call    — image bytes content-addressed before hashing

Usage:
  docker run -d --name valkey -p 6379:6379 valkey/valkey:8
  pip install betterdb-agent-cache[llamaindex] llama-index-llms-openai
  export OPENAI_API_KEY=sk-...
  python main.py
"""
from __future__ import annotations

import asyncio

import valkey.asyncio as valkey_client
from llama_index.llms.openai import OpenAI
from llama_index.core.base.llms.types import ChatMessage as LIChatMessage, ImageBlock, TextBlock

from betterdb_agent_cache import AgentCache, ModelCost, TierDefaults, compose_normalizer, hash_base64
from betterdb_agent_cache.adapters.llamaindex import prepare_params
from betterdb_agent_cache.types import AgentCacheOptions, LlmStoreOptions


def _to_li_message(m: dict) -> LIChatMessage:
    """Convert our dict-format message to a LlamaIndex ChatMessage."""
    content = m["content"]
    if isinstance(content, str):
        return LIChatMessage(role=m["role"], content=content)
    blocks = []
    for part in content:
        if part.get("type") == "text":
            blocks.append(TextBlock(text=part["text"]))
        elif part.get("type") == "image_url":
            blocks.append(ImageBlock(url=part["image_url"]["url"]))
    return LIChatMessage(role=m["role"], blocks=blocks)

_normalizer = compose_normalizer({"base64": hash_base64})
MODEL = "gpt-4o-mini"


async def chat(messages: list[dict], cache: AgentCache, llm: OpenAI) -> str:
    cache_params = await prepare_params(messages, model=MODEL, normalizer=_normalizer)
    cached = await cache.llm.check(cache_params)

    if cached.hit:
        print(f"  [cache HIT]  {str(cached.response)[:60]}")
        return cached.response or ""

    print("  [cache MISS] calling LlamaIndex/OpenAI…")
    li_messages = [_to_li_message(m) for m in messages]
    response = await llm.achat(li_messages)

    text: str = response.message.content or ""
    blocks = [{"type": "text", "text": text}]

    raw = getattr(response, "raw", None)
    inp, out = 0, 0
    if raw is not None:
        if hasattr(raw, "usage") and raw.usage is not None:
            inp = raw.usage.prompt_tokens or 0
            out = raw.usage.completion_tokens or 0
        elif isinstance(raw, dict):
            usage = raw.get("usage") or {}
            inp = usage.get("prompt_tokens", 0)
            out = usage.get("completion_tokens", 0)
    await cache.llm.store_multipart(cache_params, blocks, LlmStoreOptions(tokens={"input": inp, "output": out}))

    return text


async def main() -> None:
    client = valkey_client.Valkey(host="localhost", port=6399)
    cache = AgentCache(AgentCacheOptions(
        client=client,
        tier_defaults={"llm": TierDefaults(ttl=3600)},
        cost_table={"gpt-4o-mini": ModelCost(input_per_1k=0.00015, output_per_1k=0.0006)},
    ))
    llm = OpenAI(model=MODEL)

    print("\n=== 1. Text-only (run twice to see cache hit) ===")
    for _ in range(2):
        r = await chat([{"role": "user", "content": "What is the capital of France? One word."}], cache, llm)
        print(f"  Response: {r}")

    print("\n=== 2. Vision with base64 data URL ===")
    red_pixel = (
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADIAAAAyCAIAAACRXR/m"
        "AAAAQ0lEQVR4nO3OMQ0AMAwDsPAnvRHonxyWDMB5yaD+QEtLS0tLa0N/oKWlpaWl"
        "taE/0NLS0tLS2tAfaGlpaWlpbegPTh97K7rEaOcNTQAAAABJRU5ErkJggg=="
    )
    await chat([{"role": "user", "content": [
        {"type": "text", "text": "What colour is this? One word."},
        {"type": "image_url", "image_url": {"url": red_pixel}},
    ]}], cache, llm)

    stats = await cache.stats()
    print(f"\n-- Cache Stats --")
    print(f"LLM:        {stats.llm.hits} hits / {stats.llm.misses} misses ({stats.llm.hit_rate:.0%})")
    print(f"Cost saved: ${stats.cost_saved_micros / 1_000_000:.6f}")

    await cache.shutdown()
    await client.aclose()


if __name__ == "__main__":
    asyncio.run(main())
