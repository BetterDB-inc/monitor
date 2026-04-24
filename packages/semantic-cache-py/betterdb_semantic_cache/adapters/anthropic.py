"""Anthropic Messages API adapter for betterdb-semantic-cache.

Extracts the text to embed from Anthropic Messages API request params.
Keys on the last user message's text content.

Usage::

    from betterdb_semantic_cache.adapters.anthropic import prepare_semantic_params
    params = await prepare_semantic_params(anthropic_params)
    result = await cache.check(params.text)
"""
from __future__ import annotations

import base64
from dataclasses import dataclass
from typing import Any

from ..normalizer import BinaryNormalizer, BinaryRef, default_normalizer
from ..utils import BinaryBlock, TextBlock


@dataclass
class SemanticParams:
    text: str
    blocks: list[TextBlock | BinaryBlock] | None = None
    model: str | None = None


def _get(obj: Any, key: str, default: Any = None) -> Any:
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


async def _normalize_block(
    block: Any,
    normalizer: BinaryNormalizer,
) -> TextBlock | BinaryBlock | None:
    block_type = _get(block, "type")

    if block_type == "text":
        return TextBlock(type="text", text=_get(block, "text", "") or "")

    if block_type == "image":
        src = _get(block, "source", {})
        src_type = _get(src, "type")
        media_type = "image/*"

        if src_type == "base64":
            source: Any = {"type": "base64", "data": _get(src, "data", "")}
            media_type = _get(src, "media_type") or "image/*"
        elif src_type == "url":
            source = {"type": "url", "url": _get(src, "url", "")}
        elif src_type == "file":
            source = {"type": "file_id", "file_id": _get(src, "file_id", ""), "provider": "anthropic"}
        else:
            return None

        ref = await normalizer({"kind": "image", "source": source})  # type: ignore[typeddict-item]
        return BinaryBlock(type="binary", kind="image", mediaType=media_type, ref=ref)

    if block_type == "document":
        src = _get(block, "source", {})
        src_type = _get(src, "type")
        media_type = "application/octet-stream"

        if src_type == "base64":
            source = {"type": "base64", "data": _get(src, "data", "")}
            media_type = _get(src, "media_type") or "application/pdf"
        elif src_type == "text":
            encoded = base64.b64encode((_get(src, "text") or "").encode()).decode()
            source = {"type": "base64", "data": encoded}
            media_type = "text/plain"
        elif src_type == "url":
            source = {"type": "url", "url": _get(src, "url", "")}
            media_type = "application/pdf"
        elif src_type == "file":
            source = {"type": "file_id", "file_id": _get(src, "file_id", ""), "provider": "anthropic"}
        else:
            return None

        ref = await normalizer({"kind": "document", "source": source})  # type: ignore[typeddict-item]
        return BinaryBlock(type="binary", kind="document", mediaType=media_type, ref=ref)

    return None


async def prepare_semantic_params(
    params: Any,
    *,
    normalizer: BinaryNormalizer | None = None,
) -> SemanticParams:
    """Extract semantic cache params from Anthropic Messages API request params."""
    norm = normalizer or default_normalizer
    messages = _get(params, "messages", [])
    model = _get(params, "model")

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
            block = await _normalize_block(part, norm)
            if block is not None:
                blocks.append(block)
        text = " ".join(b["text"] for b in blocks if b.get("type") == "text")
        return SemanticParams(text=text, blocks=blocks, model=model)

    return SemanticParams(text="", model=model)
