"""OpenAI embedding helper for betterdb-semantic-cache.

Creates an EmbedFn backed by the OpenAI Embeddings API.
Requires the 'openai' extra: pip install betterdb-semantic-cache[openai]

Usage::

    from betterdb_semantic_cache.embed.openai import create_openai_embed
    embed = create_openai_embed(model="text-embedding-3-small")
    cache = SemanticCache(SemanticCacheOptions(client=client, embed_fn=embed))
"""
from __future__ import annotations

from typing import Any

from betterdb_semantic_cache.types import EmbedFn


def create_openai_embed(
    *,
    client: Any = None,
    model: str = "text-embedding-3-small",
    api_key: str | None = None,
) -> EmbedFn:
    """Create an EmbedFn backed by the OpenAI Embeddings API.

    Args:
        client: Pre-configured AsyncOpenAI client. If not provided, a new
            client is created using the OPENAI_API_KEY env var.
        model: Embedding model ID. Default: 'text-embedding-3-small'.
        api_key: OpenAI API key. Used only when client is not provided.
    """
    import os

    _client_cache: list[Any] = []

    async def _get_client() -> Any:
        if _client_cache:
            return _client_cache[0]
        if client is not None:
            _client_cache.append(client)
            return client
        try:
            from openai import AsyncOpenAI
            c = AsyncOpenAI(api_key=api_key or os.environ.get("OPENAI_API_KEY"))
            _client_cache.append(c)
            return c
        except ImportError:
            raise ImportError(
                'betterdb-semantic-cache embed/openai requires the "openai" package. '
                "Install it: pip install betterdb-semantic-cache[openai]"
            )

    async def embed(text: str) -> list[float]:
        c = await _get_client()
        response = await c.embeddings.create(input=text, model=model)
        return response.data[0].embedding

    return embed
