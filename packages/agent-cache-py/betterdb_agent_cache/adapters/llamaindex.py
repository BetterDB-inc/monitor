"""LlamaIndex adapter.

Converts a list of ``ChatMessage`` dicts (as used by LlamaIndex) into
``LlmCacheParams``.

Usage::

    from betterdb_agent_cache.adapters.llamaindex import prepare_params

    params = await prepare_params(messages, model="gpt-4o")
    result = await cache.llm.check(params)
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from ..normalizer import BinaryNormalizer, default_normalizer
from ..types import BinaryBlock, ContentBlock, LlmCacheParams, TextBlock, ToolCallBlock


@dataclass
class LlamaIndexPrepareOptions:
    model: str = ""
    normalizer: BinaryNormalizer = field(default_factory=lambda: default_normalizer)
    temperature: float | None = None
    top_p: float | None = None
    max_tokens: int | None = None


def _parse_input(value: Any) -> Any:
    if isinstance(value, str):
        try:
            return json.loads(value)
        except (json.JSONDecodeError, ValueError):
            return {"__raw": value}
    return value


async def _normalize_detail(
    part: dict[str, Any],
    normalizer: BinaryNormalizer,
) -> ContentBlock | None:
    t = part.get("type")

    if t == "text":
        return {"type": "text", "text": part.get("text") or ""}

    if t == "image_url" and part.get("image_url"):
        url: str = part["image_url"]["url"]
        media_type = "image/*"
        if url.startswith("data:"):
            semi = url.find(";")
            if semi > 5:
                media_type = url[5:semi]
            source: dict[str, Any] = {"type": "base64", "data": url}
        else:
            source = {"type": "url", "url": url}
        ref = await normalizer({"kind": "image", "source": source})
        return {"type": "binary", "kind": "image", "mediaType": media_type, "ref": ref}

    if t == "file" and part.get("data"):
        ref = await normalizer({
            "kind": "document",
            "source": {"type": "base64", "data": part["data"]},
        })
        return {
            "type": "binary", "kind": "document",
            "mediaType": part.get("mime_type") or "application/octet-stream",
            "ref": ref,
        }

    if t in ("audio", "image") and part.get("data"):
        kind = "audio" if t == "audio" else "image"
        ref = await normalizer({
            "kind": kind,
            "source": {"type": "base64", "data": part["data"]},
        })
        default_media = "audio/*" if kind == "audio" else "image/*"
        return {
            "type": "binary", "kind": kind,
            "mediaType": part.get("mime_type") or default_media,
            "ref": ref,
        }

    return None


async def prepare_params(
    messages: list[dict[str, Any]],
    opts: LlamaIndexPrepareOptions | None = None,
    *,
    model: str | None = None,
    normalizer: BinaryNormalizer | None = None,
    temperature: float | None = None,
    top_p: float | None = None,
    max_tokens: int | None = None,
) -> LlmCacheParams:
    """Normalise a LlamaIndex message list to ``LlmCacheParams``.

    Either pass an ``LlamaIndexPrepareOptions`` instance or use the keyword
    arguments directly::

        params = await prepare_params(msgs, model="gpt-4o", temperature=0.7)
    """
    if opts is None:
        opts = LlamaIndexPrepareOptions(
            model=model or "",
            normalizer=normalizer or default_normalizer,
            temperature=temperature,
            top_p=top_p,
            max_tokens=max_tokens,
        )

    norm = opts.normalizer
    out: list[Any] = []

    for msg in messages:
        options: dict[str, Any] = msg.get("options") or {}

        if options.get("tool_result"):
            tr = options["tool_result"]
            out.append({
                "role": "tool",
                "toolCallId": tr["id"],
                "content": [{"type": "text", "text": tr.get("result", "")}],
            })
            continue

        raw_role: str = msg.get("role", "user")
        role = "system" if raw_role in ("memory", "developer") else raw_role

        blocks: list[ContentBlock] = []
        content = msg.get("content")
        if isinstance(content, str):
            if content:
                blocks.append({"type": "text", "text": content})
        elif isinstance(content, list):
            for part in content:
                b = await _normalize_detail(part, norm)
                if b is not None:
                    blocks.append(b)

        tool_calls = options.get("tool_call")
        if tool_calls:
            calls = tool_calls if isinstance(tool_calls, list) else [tool_calls]
            for tc in calls:
                blocks.append({
                    "type": "tool_call",
                    "id": tc["id"],
                    "name": tc["name"],
                    "args": _parse_input(tc.get("input")),
                })

        out.append({"role": role, "content": blocks})

    result: LlmCacheParams = {"model": opts.model, "messages": out}
    if opts.temperature is not None:
        result["temperature"] = opts.temperature
    if opts.top_p is not None:
        result["top_p"] = opts.top_p
    if opts.max_tokens is not None:
        result["max_tokens"] = opts.max_tokens

    return result
