"""Google AI (Gemini) embedding helper for betterdb-semantic-cache.

Uses the Google AI REST API directly via httpx.
Requires the 'httpx' extra: pip install betterdb-semantic-cache[httpx]

Usage::

    from betterdb_semantic_cache.embed.google import create_google_embed
    embed = create_google_embed(model="text-embedding-004")
    cache = SemanticCache(SemanticCacheOptions(client=client, embed_fn=embed))
"""
from __future__ import annotations

import os
from typing import Any, Literal

from betterdb_semantic_cache.types import EmbedFn

GoogleEmbedTaskType = Literal[
    "RETRIEVAL_QUERY",
    "RETRIEVAL_DOCUMENT",
    "SEMANTIC_SIMILARITY",
    "CLASSIFICATION",
    "CLUSTERING",
]


def create_google_embed(
    *,
    model: str = "text-embedding-004",
    api_key: str | None = None,
    base_url: str = "https://generativelanguage.googleapis.com/v1beta",
    task_type: GoogleEmbedTaskType = "RETRIEVAL_QUERY",
    title: str | None = None,
    output_dimensionality: int | None = None,
) -> EmbedFn:
    """Create an EmbedFn backed by the Google AI (Gemini) Embeddings API.

    Args:
        model: Google AI embedding model. Default: 'text-embedding-004' (768-dim).
               Other options: 'text-multilingual-embedding-002', 'embedding-001'.
        api_key: Google AI API key. Default: GOOGLE_API_KEY env var.
        base_url: API base URL.
        task_type: Task type hint. Default: 'RETRIEVAL_QUERY'.
                   Use 'RETRIEVAL_DOCUMENT' when storing documents.
        title: Optional document title. Only used with task_type='RETRIEVAL_DOCUMENT'.
        output_dimensionality: Optional output dimensionality (truncation).
                               Supported by text-embedding-004+.
    """
    _client: list[Any] = []

    async def _get_client() -> Any:
        if not _client:
            try:
                import httpx
            except ImportError:
                raise ImportError(
                    'betterdb-semantic-cache embed/google requires the "httpx" package. '
                    "Install it: pip install betterdb-semantic-cache[httpx]"
                )
            _client.append(httpx.AsyncClient(timeout=30))
        return _client[0]

    async def embed(text: str) -> list[float]:
        key = api_key or os.environ.get("GOOGLE_API_KEY")
        if not key:
            raise ValueError(
                "Google API key is required. Set GOOGLE_API_KEY env var or pass api_key."
            )
        client = await _get_client()
        body: dict[str, Any] = {
            "model": f"models/{model}",
            "content": {"parts": [{"text": text}]},
            "taskType": task_type,
        }
        if title is not None:
            body["title"] = title
        if output_dimensionality is not None:
            body["outputDimensionality"] = output_dimensionality

        resp = await client.post(
            f"{base_url}/models/{model}:embedContent",
            params={"key": key},
            headers={"Content-Type": "application/json"},
            json=body,
        )
        resp.raise_for_status()
        return resp.json().get("embedding", {}).get("values") or []

    return embed
