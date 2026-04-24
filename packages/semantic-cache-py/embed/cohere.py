"""Cohere embedding helper for betterdb-semantic-cache.

Uses the Cohere REST API directly via httpx.
Requires the 'httpx' extra: pip install betterdb-semantic-cache[httpx]

Usage::

    from embed.cohere import create_cohere_embed
    embed = create_cohere_embed(model="embed-english-v3.0")
    cache = SemanticCache(SemanticCacheOptions(client=client, embed_fn=embed))
"""
from __future__ import annotations

import os
from typing import Literal

from betterdb_semantic_cache.types import EmbedFn


def create_cohere_embed(
    *,
    model: str = "embed-english-v3.0",
    api_key: str | None = None,
    base_url: str = "https://api.cohere.com/v2",
    input_type: Literal[
        "search_query", "search_document", "classification", "clustering"
    ] = "search_query",
) -> EmbedFn:
    """Create an EmbedFn backed by the Cohere Embed API.

    Args:
        model: Cohere embedding model. Default: 'embed-english-v3.0' (1024-dim).
        api_key: Cohere API key. Default: COHERE_API_KEY env var.
        base_url: API base URL.
        input_type: Embedding input type. Default: 'search_query'.
    """

    async def embed(text: str) -> list[float]:
        try:
            import httpx
        except ImportError:
            raise ImportError(
                'betterdb-semantic-cache embed/cohere requires the "httpx" package. '
                "Install it: pip install betterdb-semantic-cache[httpx]"
            )

        key = api_key or os.environ.get("COHERE_API_KEY")
        if not key:
            raise ValueError(
                "Cohere API key is required. Set COHERE_API_KEY env var or pass api_key."
            )

        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{base_url}/embed",
                headers={"Authorization": f"Bearer {key}",
                         "Content-Type": "application/json"},
                json={
                    "model": model,
                    "texts": [text],
                    "input_type": input_type,
                    "embedding_types": ["float"],
                },
                timeout=30,
            )
            resp.raise_for_status()
            data = resp.json()
            return (data.get("embeddings", {}).get("float") or [[]])[0]

    return embed
