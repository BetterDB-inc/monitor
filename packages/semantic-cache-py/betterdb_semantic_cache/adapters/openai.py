"""OpenAI Chat Completions adapter for betterdb-semantic-cache.

Extracts the text to embed from OpenAI Chat Completions request params.
Semantic caching keys on the last user message's text content because that
is the actual query that changes between requests.

Usage::

    from betterdb_semantic_cache.adapters.openai import prepare_semantic_params
    params = await prepare_semantic_params(openai_params)
    result = await cache.check(params.text or params.blocks)
"""
from __future__ import annotations

from typing import Any

from ..normalizer import BinaryNormalizer, BinaryRef, default_normalizer
from ..utils import BinaryBlock, TextBlock
from ._types import SemanticParams, _get

__all__ = ["SemanticParams", "prepare_semantic_params"]


async def _normalize_content_part(
    part: Any,
    normalizer: BinaryNormalizer,
) -> TextBlock | BinaryBlock | None:
    part_type = _get(part, "type")

    if part_type == "text":
        return TextBlock(type="text", text=_get(part, "text", "") or "")

    if part_type == "image_url":
        image_url = _get(part, "image_url", {})
        url = _get(image_url, "url", "")
        detail = _get(image_url, "detail")

        media_type = "image/*"
        source: BinaryRef["source"]
        if url.startswith("data:"):
            semi = url.find(";")
            if semi > 5:
                media_type = url[5:semi]
            source = {"type": "base64", "data": url}  # type: ignore[assignment]
        else:
            source = {"type": "url", "url": url}  # type: ignore[assignment]

        ref = await normalizer({"kind": "image", "source": source})  # type: ignore[typeddict-item]
        block = BinaryBlock(type="binary", kind="image", mediaType=media_type, ref=ref)
        if detail:
            block["detail"] = detail
        return block

    if part_type == "input_audio":
        audio_data = _get(part, "input_audio", {})
        data = _get(audio_data, "data", "")
        fmt = _get(audio_data, "format", "wav")
        ref = await normalizer({"kind": "audio", "source": {"type": "base64", "data": data}})  # type: ignore[typeddict-item]
        return BinaryBlock(type="binary", kind="audio", mediaType=f"audio/{fmt}", ref=ref)

    if part_type == "file":
        file_obj = _get(part, "file", {})
        file_id = _get(file_obj, "file_id")
        file_data = _get(file_obj, "file_data")
        filename = _get(file_obj, "filename")

        media_type = "application/octet-stream"
        if file_id:
            source = {"type": "file_id", "file_id": file_id, "provider": "openai"}  # type: ignore[assignment]
        elif file_data:
            if isinstance(file_data, str) and file_data.startswith("data:"):
                semi = file_data.find(";")
                if semi > 5:
                    media_type = file_data[5:semi]
            source = {"type": "base64", "data": file_data}  # type: ignore[assignment]
        else:
            return None

        ref = await normalizer({"kind": "document", "source": source})  # type: ignore[typeddict-item]
        block = BinaryBlock(type="binary", kind="document", mediaType=media_type, ref=ref)
        if filename:
            block["filename"] = filename
        return block

    return None


async def prepare_semantic_params(
    params: Any,
    *,
    normalizer: BinaryNormalizer | None = None,
) -> SemanticParams:
    """Extract semantic cache params from OpenAI Chat Completions request params.

    Extracts the last user message for semantic similarity matching.
    """
    norm = normalizer or default_normalizer
    messages = _get(params, "messages", [])
    model = _get(params, "model")

    user_messages = [m for m in (messages or []) if _get(m, "role") == "user"]
    if not user_messages:
        return SemanticParams(text="", model=model)

    last_user = user_messages[-1]
    content = _get(last_user, "content", "")

    if isinstance(content, str):
        return SemanticParams(text=content, model=model)

    if isinstance(content, list):
        blocks: list[TextBlock | BinaryBlock] = []
        for part in content:
            block = await _normalize_content_part(part, norm)
            if block is not None:
                blocks.append(block)
        text = " ".join(b["text"] for b in blocks if b.get("type") == "text")
        return SemanticParams(text=text, blocks=blocks, model=model)

    return SemanticParams(text="", model=model)
