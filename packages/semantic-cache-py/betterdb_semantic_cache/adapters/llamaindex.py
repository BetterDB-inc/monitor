"""LlamaIndex adapter for betterdb-semantic-cache.

Extracts the text to embed from LlamaIndex ChatMessage arrays.
Keys on the last user message's text content.

Usage::

    from betterdb_semantic_cache.adapters.llamaindex import prepare_semantic_params
    params = await prepare_semantic_params(messages, model="gpt-4o")
    result = await cache.check(params.text)
"""
from __future__ import annotations

from typing import Any

from ..normalizer import BinaryNormalizer, BinaryRef, default_normalizer
from ..utils import BinaryBlock, TextBlock
from ._types import SemanticParams, _get

__all__ = ["SemanticParams", "prepare_semantic_params"]


async def _normalize_detail(
    part: Any,
    normalizer: BinaryNormalizer,
) -> TextBlock | BinaryBlock | None:
    part_type = _get(part, "type")

    if part_type == "text":
        return TextBlock(type="text", text=_get(part, "text", "") or "")

    if part_type == "image_url":
        image_url_obj = _get(part, "image_url", {})
        url = _get(image_url_obj, "url", "") if isinstance(image_url_obj, dict) else str(image_url_obj)
        media_type = "image/*"
        if url.startswith("data:"):
            semi = url.find(";")
            if semi > 5:
                media_type = url[5:semi]
            source: Any = {"type": "base64", "data": url}
        else:
            source = {"type": "url", "url": url}
        ref = await normalizer({"kind": "image", "source": source})  # type: ignore[typeddict-item]
        return BinaryBlock(type="binary", kind="image", mediaType=media_type, ref=ref)

    if part_type == "file" and _get(part, "data"):
        data = _get(part, "data", "")
        ref = await normalizer({"kind": "document", "source": {"type": "base64", "data": data}})  # type: ignore[typeddict-item]
        return BinaryBlock(
            type="binary", kind="document",
            mediaType=_get(part, "mimeType") or "application/octet-stream",
            ref=ref,
        )

    if part_type in ("audio", "image") and _get(part, "data"):
        data = _get(part, "data", "")
        kind = "audio" if part_type == "audio" else "image"
        ref = await normalizer({"kind": kind, "source": {"type": "base64", "data": data}})  # type: ignore[typeddict-item]
        default_mt = "audio/*" if kind == "audio" else "image/*"
        return BinaryBlock(
            type="binary", kind=kind,
            mediaType=_get(part, "mimeType") or default_mt,
            ref=ref,
        )

    return None


async def prepare_semantic_params(
    messages: list[Any],
    *,
    model: str | None = None,
    normalizer: BinaryNormalizer | None = None,
) -> SemanticParams:
    """Extract semantic cache params from a LlamaIndex ChatMessage list."""
    norm = normalizer or default_normalizer

    user_messages = [m for m in (messages or []) if _get(m, "role") == "user"]
    if not user_messages:
        return SemanticParams(text="", model=model)

    last_user = user_messages[-1]
    content = _get(last_user, "content")

    if isinstance(content, str):
        return SemanticParams(text=content, model=model)

    if isinstance(content, list):
        blocks: list[TextBlock | BinaryBlock] = []
        for part in content:
            block = await _normalize_detail(part, norm)
            if block is not None:
                blocks.append(block)
        text = " ".join(b["text"] for b in blocks if b.get("type") == "text")
        return SemanticParams(text=text, blocks=blocks, model=model)

    return SemanticParams(text="", model=model)
