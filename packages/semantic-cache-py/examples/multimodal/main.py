"""Multi-modal prompt caching example for betterdb-semantic-cache

Demonstrates:
  1. ContentBlock[] prompts with TextBlock and BinaryBlock
  2. Same text + same image -> cache hit
  3. Same text + different image -> cache miss
  4. store_multipart() storing structured response blocks

No API key required - uses a mock embedder with hardcoded vectors.

Prerequisites:
  - Valkey 8.0+ with valkey-search at localhost:6379

Usage:
  python examples/multimodal/main.py
"""
from __future__ import annotations

import asyncio
import math
import os
import re

from betterdb_semantic_cache.normalizer import hash_base64
from betterdb_semantic_cache.utils import BinaryBlock, ContentBlock, TextBlock


# Small 1x1 PNG images in base64 (same as TS example)
RED_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg=="
BLUE_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="


# charcode 8-dim mock embedder — mirrors TS multimodal mock exactly
def _mock_embed(text: str) -> list[float]:
    words = [w for w in re.split(r'\W+', text.lower()) if w]
    dim = 8
    vec = [0.0] * dim
    for word in words:
        for i in range(min(len(word), dim)):
            vec[i] += ord(word[i]) / 1000.0
    norm = math.sqrt(sum(x * x for x in vec)) or 1.0
    return [x / norm for x in vec]


async def mock_embed(text: str) -> list[float]:
    return _mock_embed(text)


def make_image_prompt(text: str, image_b64: str) -> list[ContentBlock]:
    return [
        TextBlock(type="text", text=text),
        BinaryBlock(type="binary", kind="image", mediaType="image/png", ref=hash_base64(image_b64)),
    ]


async def main() -> None:
    import valkey.asyncio as valkey

    from betterdb_semantic_cache import SemanticCache, SemanticCacheOptions

    host = os.environ.get("VALKEY_HOST", "localhost")
    port = int(os.environ.get("VALKEY_PORT", "6379"))
    client = valkey.Valkey(host=host, port=port)

    cache = SemanticCache(SemanticCacheOptions(
        client=client,
        embed_fn=mock_embed,
        name="example_multimodal",
        default_threshold=0.05,
        default_ttl=300,
    ))

    print("=== Multi-modal caching example ===\n")

    print("WARNING: Flushing cache - deletes all existing cache data.")
    await cache.initialize()
    await cache.flush()
    await cache.initialize()
    print("Cache initialized and flushed.\n")

    prompt = "Describe the color of this image."

    # -- Store with RED image --
    print('-- Storing: "Describe the color..." + red image --')
    red_prompt = make_image_prompt(prompt, RED_PNG_B64)
    red_response: list[ContentBlock] = [TextBlock(type="text", text="The image is red.")]
    await cache.store_multipart(red_prompt, red_response)
    print("  Stored entry with red image.\n")

    # -- Check 1: Same text + same image -> HIT --
    print("-- Check 1: Same text + same image --")
    check1 = await cache.check(make_image_prompt(prompt, RED_PNG_B64))
    if check1.hit:
        print(f'  HIT - response: "{check1.response}" | similarity: {check1.similarity:.4f}')
        if check1.content_blocks:
            import json
            print(f"  Content blocks: {json.dumps(check1.content_blocks, separators=(',', ':'))}")
    else:
        print("  MISS (unexpected)")
    print()

    # -- Check 2: Same text + different image -> MISS --
    print("-- Check 2: Same text + different image (blue) --")
    check2 = await cache.check(make_image_prompt(prompt, BLUE_PNG_B64))
    if check2.hit:
        print("  HIT (unexpected - images should differ)")
    else:
        print("  MISS - different image ref, no cache hit.")
    print()

    # -- Check 3: Same text, no image --
    print("-- Check 3: Same text, no image (text-only) --")
    check3 = await cache.check(prompt)
    if check3.hit:
        print("  HIT - text-only prompt matched the multi-modal entry (binary filter not applied)")
        print("  (This is expected: binary filtering only activates when the query has binary blocks.)")
    else:
        print("  MISS")
    print()

    # -- Stats --
    stats = await cache.stats()
    print("-- Cache Stats --")
    print(f"Hits: {stats.hits} | Misses: {stats.misses}")

    await cache.flush()
    await client.aclose()


if __name__ == "__main__":
    asyncio.run(main())
