"""Cohere embedding helper for betterdb-semantic-cache.

Uses the Cohere REST API directly via httpx.
Requires the 'httpx' extra: pip install betterdb-semantic-cache[httpx]

Usage::

    from betterdb_semantic_cache.embed.cohere import create_cohere_embed
    embed = create_cohere_embed(model="embed-english-v3.0")
    cache = SemanticCache(SemanticCacheOptions(client=client, embed_fn=embed))
"""
from __future__ import annotations

import os
from typing import Any, Literal

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
    _client: list[Any] = []

    async def _get_client() -> Any:
        if not _client:
            try:
                import httpx
            except ImportError:
                raise ImportError(
                    'betterdb-semantic-cache embed/cohere requires the "httpx" package. '
                    "Install it: pip install betterdb-semantic-cache[httpx]"
                )
            _client.append(httpx.AsyncClient(timeout=30))
        return _client[0]

    async def embed(text: str) -> list[float]:
        key = api_key or os.environ.get("COHERE_API_KEY")
        if not key:
            raise ValueError(
                "Cohere API key is required. Set COHERE_API_KEY env var or pass api_key."
            )
        client = await _get_client()
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
        )
        resp.raise_for_status()
        return (resp.json().get("embeddings", {}).get("float") or [[]])[0]

    return embed
