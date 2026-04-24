"""Voyage AI embedding helper for betterdb-semantic-cache.

Uses the Voyage AI REST API directly via httpx.
Requires the 'httpx' extra: pip install betterdb-semantic-cache[httpx]

Usage::

    from betterdb_semantic_cache.embed.voyage import create_voyage_embed
    embed = create_voyage_embed(model="voyage-3-lite")
    cache = SemanticCache(SemanticCacheOptions(client=client, embed_fn=embed))
"""
from __future__ import annotations

import os
from typing import Any, Literal

from betterdb_semantic_cache.types import EmbedFn


def create_voyage_embed(
    *,
    model: str = "voyage-3-lite",
    api_key: str | None = None,
    base_url: str = "https://api.voyageai.com/v1",
    input_type: Literal["query", "document"] = "query",
) -> EmbedFn:
    """Create an EmbedFn backed by the Voyage AI Embeddings API.

    Args:
        model: Voyage AI embedding model. Default: 'voyage-3-lite' (512-dim).
        api_key: Voyage AI API key. Default: VOYAGE_API_KEY env var.
        base_url: API base URL.
        input_type: Input type hint. Default: 'query'.
    """
    _client: list[Any] = []

    async def _get_client() -> Any:
        if not _client:
            try:
                import httpx
            except ImportError:
                raise ImportError(
                    'betterdb-semantic-cache embed/voyage requires the "httpx" package. '
                    "Install it: pip install betterdb-semantic-cache[httpx]"
                )
            _client.append(httpx.AsyncClient(timeout=30))
        return _client[0]

    async def embed(text: str) -> list[float]:
        key = api_key or os.environ.get("VOYAGE_API_KEY")
        if not key:
            raise ValueError(
                "Voyage AI API key is required. Set VOYAGE_API_KEY env var or pass api_key."
            )
        client = await _get_client()
        resp = await client.post(
            f"{base_url}/embeddings",
            headers={"Authorization": f"Bearer {key}",
                     "Content-Type": "application/json"},
            json={"model": model, "input": [text], "input_type": input_type},
        )
        resp.raise_for_status()
        return resp.json()["data"][0]["embedding"]

    return embed
