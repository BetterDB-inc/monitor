"""Ollama embedding helper for betterdb-semantic-cache.

Uses the Ollama REST API directly via httpx.
Requires the 'httpx' extra: pip install betterdb-semantic-cache[httpx]

Usage::

    from embed.ollama import create_ollama_embed
    embed = create_ollama_embed(model="nomic-embed-text")
    cache = SemanticCache(SemanticCacheOptions(client=client, embed_fn=embed))
"""
from __future__ import annotations

import os

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

    async def embed(text: str) -> list[float]:
        try:
            import httpx
        except ImportError:
            raise ImportError(
                'betterdb-semantic-cache embed/ollama requires the "httpx" package. '
                "Install it: pip install betterdb-semantic-cache[httpx]"
            )

        url = base_url or os.environ.get("OLLAMA_HOST", "http://localhost:11434")

        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{url}/api/embed",
                headers={"Content-Type": "application/json"},
                json={"model": model, "input": text},
                timeout=60,
            )
            resp.raise_for_status()
            data = resp.json()
            embeddings = data.get("embeddings", [[]])
            return embeddings[0] if embeddings else []

    return embed
