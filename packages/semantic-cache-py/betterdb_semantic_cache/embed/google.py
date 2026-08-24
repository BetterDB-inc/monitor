"""Google AI (Gemini) embedding helper for betterdb-semantic-cache.

Uses the Google AI REST API directly via httpx.
Requires the 'httpx' extra: pip install betterdb-semantic-cache[httpx]

Usage::

    from betterdb_semantic_cache.embed.google import create_google_embed
    embed = create_google_embed(model="gemini-embedding-2")
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
    "QUESTION_ANSWERING",
    "FACT_VERIFICATION",
    "CODE_RETRIEVAL_QUERY",
]

_TASK_INSTRUCTIONS: dict[str, str] = {
    "RETRIEVAL_QUERY": "search result",
    "QUESTION_ANSWERING": "question answering",
    "FACT_VERIFICATION": "fact checking",
    "CODE_RETRIEVAL_QUERY": "code retrieval",
    "CLASSIFICATION": "classification",
    "CLUSTERING": "clustering",
    "SEMANTIC_SIMILARITY": "sentence similarity",
}


def _apply_task_instruction(text: str, task_type: str, title: str | None = None) -> str:
    """Carry the task in the input text, the way gemini-embedding-2 expects it.

    That model rejects the ``taskType`` field. Documents take
    ``title: … | text: …``; every other task takes ``task: … | query: …``. A
    task with no documented instruction passes the text through unchanged.
    """
    if task_type == "RETRIEVAL_DOCUMENT":
        return f"title: {title if title is not None else 'none'} | text: {text}"
    instruction = _TASK_INSTRUCTIONS.get(task_type)
    if instruction is None:
        return text
    return f"task: {instruction} | query: {text}"


def create_google_embed(
    *,
    model: str = "gemini-embedding-2",
    api_key: str | None = None,
    base_url: str = "https://generativelanguage.googleapis.com/v1beta",
    task_type: GoogleEmbedTaskType = "RETRIEVAL_QUERY",
    title: str | None = None,
    output_dimensionality: int | None = None,
) -> EmbedFn:
    """Create an EmbedFn backed by the Google AI (Gemini) Embeddings API.

    Args:
        model: Google AI embedding model. Default: 'gemini-embedding-2'.
               Other options: 'gemini-embedding-001'.
               Note: 'text-embedding-004' and 'embedding-001' were shut down by
               Google on 2026-01-14 and 2025-10-30 and no longer resolve.
        api_key: Google AI API key. Default: GOOGLE_API_KEY env var.
        base_url: API base URL.
        task_type: Task type hint. Default: 'RETRIEVAL_QUERY'.
                   Use 'RETRIEVAL_DOCUMENT' when storing documents.
                   gemini-embedding-2 does not accept a taskType field; for that
                   model the task is expressed as a prefix on the input text
                   instead, so this option keeps working and only the request
                   shape differs.
        title: Optional document title. Only used with task_type='RETRIEVAL_DOCUMENT'.
        output_dimensionality: Output dimensionality (Matryoshka truncation).
                               Defaults to 768 for gemini-embedding-2 only,
                               matching the dimensionality this provider has
                               always produced so an existing vector index stays
                               compatible; pass 3072 for that model's full
                               width. For any other model the field is omitted
                               unless set, leaving the model's own default
                               intact. gemini-embedding-2 re-normalizes
                               truncated dimensions itself, but
                               gemini-embedding-001 does not — normalize its
                               output before cosine similarity when requesting
                               anything other than 3072.

    When finished, release the connection pool::

        await embed.close()
    """
    _client: list[Any] = []
    is_gemini_embedding_2 = model == "gemini-embedding-2"
    dimensionality = output_dimensionality
    if dimensionality is None and is_gemini_embedding_2:
        dimensionality = 768

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
        content = _apply_task_instruction(text, task_type, title) if is_gemini_embedding_2 else text
        body: dict[str, Any] = {
            "model": f"models/{model}",
            "content": {"parts": [{"text": content}]},
        }
        if dimensionality is not None:
            body["outputDimensionality"] = dimensionality
        if not is_gemini_embedding_2:
            body["taskType"] = task_type
            if title is not None:
                body["title"] = title

        resp = await client.post(
            f"{base_url}/models/{model}:embedContent",
            headers={"Content-Type": "application/json", "x-goog-api-key": key},
            json=body,
        )
        resp.raise_for_status()
        return resp.json().get("embedding", {}).get("values") or []

    async def close() -> None:
        if _client:
            await _client[0].aclose()
            _client.clear()

    embed.close = close  # type: ignore[attr-defined]
    return embed
