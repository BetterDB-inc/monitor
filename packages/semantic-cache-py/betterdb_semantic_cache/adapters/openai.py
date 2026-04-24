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
from ._types import SemanticParams

__all__ = ["SemanticParams", "prepare_semantic_params"]


async def _normalize_content_part(
    part: Any,
    normalizer: BinaryNormalizer,
) -> TextBlock | BinaryBlock | None:
    part_type = part.get("type") if isinstance(part, dict) else getattr(part, "type", None)

    if part_type == "text":
        text = part.get("text") if isinstance(part, dict) else getattr(part, "text", "")
        return TextBlock(type="text", text=text or "")

    if part_type == "image_url":
        image_url = part.get("image_url") if isinstance(part, dict) else getattr(part, "image_url", {})
        if isinstance(image_url, dict):
            url = image_url.get("url", "")
            detail = image_url.get("detail")
        else:
            url = getattr(image_url, "url", "")
            detail = getattr(image_url, "detail", None)

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
        audio_data = part.get("input_audio") if isinstance(part, dict) else getattr(part, "input_audio", {})
        if isinstance(audio_data, dict):
            data = audio_data.get("data", "")
            fmt = audio_data.get("format", "wav")
        else:
            data = getattr(audio_data, "data", "")
            fmt = getattr(audio_data, "format", "wav")
        ref = await normalizer({"kind": "audio", "source": {"type": "base64", "data": data}})  # type: ignore[typeddict-item]
        return BinaryBlock(type="binary", kind="audio", mediaType=f"audio/{fmt}", ref=ref)

    if part_type == "file":
        file_obj = part.get("file") if isinstance(part, dict) else getattr(part, "file", {})
        if isinstance(file_obj, dict):
            file_id = file_obj.get("file_id")
            file_data = file_obj.get("file_data")
            filename = file_obj.get("filename")
        else:
            file_id = getattr(file_obj, "file_id", None)
            file_data = getattr(file_obj, "file_data", None)
            filename = getattr(file_obj, "filename", None)

        media_type = "application/octet-stream"
        if file_id:
            source = {"type": "file_id", "file_id": file_id, "provider": "openai"}  # type: ignore[assignment]
        elif file_data:
            if file_data.startswith("data:"):
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
    messages = params.get("messages") if isinstance(params, dict) else getattr(params, "messages", [])
    model = params.get("model") if isinstance(params, dict) else getattr(params, "model", None)

    user_messages = [m for m in (messages or []) if
                     (m.get("role") if isinstance(m, dict) else getattr(m, "role", None)) == "user"]
    if not user_messages:
        return SemanticParams(text="", model=model)

    last_user = user_messages[-1]
    content = last_user.get("content") if isinstance(last_user, dict) else getattr(last_user, "content", "")

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
