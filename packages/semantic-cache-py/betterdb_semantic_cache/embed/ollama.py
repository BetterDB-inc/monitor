"""Ollama embedding helper for betterdb-semantic-cache.

Uses the Ollama REST API directly via httpx.
Requires the 'httpx' extra: pip install betterdb-semantic-cache[httpx]

Usage::

    from betterdb_semantic_cache.embed.ollama import create_ollama_embed
    embed = create_ollama_embed(model="nomic-embed-text")
    cache = SemanticCache(SemanticCacheOptions(client=client, embed_fn=embed))
"""
from __future__ import annotations

import os
from typing import Any

from betterdb_semantic_cache.types import EmbedFn


def create_ollama_embed(
    *,
    model: str = "nomic-embed-text",
    base_url: str | None = None,
) -> EmbedFn:
    """Create an EmbedFn backed by a local Ollama instance.

    Args:
        model: Ollama embedding model. Default: 'nomic-embed-text' (768-dim).
        base_url: Ollama API base URL. Default: OLLAMA_HOST env var or 'http://localhost:11434'.
    """
    _client: list[Any] = []

    async def _get_client() -> Any:
        if not _client:
            try:
                import httpx
            except ImportError:
                raise ImportError(
                    'betterdb-semantic-cache embed/ollama requires the "httpx" package. '
                    "Install it: pip install betterdb-semantic-cache[httpx]"
                )
            _client.append(httpx.AsyncClient(timeout=60))
        return _client[0]

    async def embed(text: str) -> list[float]:
        url = base_url or os.environ.get("OLLAMA_HOST", "http://localhost:11434")
        client = await _get_client()
        resp = await client.post(
            f"{url}/api/embed",
            headers={"Content-Type": "application/json"},
            json={"model": model, "input": text},
        )
        resp.raise_for_status()
        embeddings = resp.json().get("embeddings", [[]])
        return embeddings[0] if embeddings else []

    return embed
