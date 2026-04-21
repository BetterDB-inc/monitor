"""Anthropic Messages adapter.

Converts params for ``anthropic.messages.create()`` into ``LlmCacheParams``.

Usage::

    from betterdb_agent_cache.adapters.anthropic import prepare_params

    params = await prepare_params({"model": "claude-opus-4-5", "messages": [...], "max_tokens": 1024})
    result = await cache.llm.check(params)
"""
from __future__ import annotations

import base64
import hashlib
import json
from dataclasses import dataclass, field
from typing import Any

from ..normalizer import BinaryNormalizer, default_normalizer
from ..types import (
    BinaryBlock,
    BlockHints,
    ContentBlock,
    LlmCacheParams,
    ReasoningBlock,
    TextBlock,
    ToolCallBlock,
    ToolResultBlock,
)


@dataclass
class AnthropicPrepareOptions:
    normalizer: BinaryNormalizer = field(default_factory=lambda: default_normalizer)


def _build_cache_hints(cache_control: dict[str, Any] | None) -> BlockHints | None:
    if not cache_control:
        return None
    hint: BlockHints = {"anthropic_cache_control": {"type": "ephemeral"}}
    if cache_control.get("ttl"):
        hint["anthropic_cache_control"]["ttl"] = cache_control["ttl"]  # type: ignore[typeddict-item]
    return hint


async def _normalize_block(
    block: dict[str, Any],
    normalizer: BinaryNormalizer,
) -> ContentBlock | None:
    t = block.get("type")

    if t == "text":
        result: TextBlock = {"type": "text", "text": block["text"]}
        hints = _build_cache_hints(block.get("cache_control"))
        if hints:
            result["hints"] = hints
        return result

    if t == "image":
        src = block.get("source", {})
        src_type = src.get("type")
        media_type = "image/*"

        if src_type == "base64":
            source: dict[str, Any] = {"type": "base64", "data": src["data"]}
            media_type = src.get("media_type", "image/*")
        elif src_type == "url":
            source = {"type": "url", "url": src["url"]}
        elif src_type == "file":
            source = {"type": "file_id", "file_id": src["file_id"], "provider": "anthropic"}
        else:
            return None

        ref = await normalizer({"kind": "image", "source": source})
        img_block: BinaryBlock = {"type": "binary", "kind": "image", "media_type": media_type, "ref": ref}
        hints = _build_cache_hints(block.get("cache_control"))
        if hints:
            img_block["hints"] = hints
        return img_block

    if t == "document":
        src = block.get("source", {})
        src_type = src.get("type")

        if src_type == "content":
            full_json = json.dumps(src.get("content"))
            digest = hashlib.sha256(full_json.encode()).hexdigest()
            ref = f"nested:sha256:{digest}"
            doc_block: BinaryBlock = {
                "type": "binary", "kind": "document",
                "media_type": "application/x-nested-content", "ref": ref,
            }
            return doc_block

        media_type = "application/octet-stream"
        if src_type == "base64":
            source = {"type": "base64", "data": src["data"]}
            media_type = src.get("media_type", "application/pdf")
        elif src_type == "text":
            encoded = base64.b64encode(src["text"].encode()).decode()
            source = {"type": "base64", "data": encoded}
            media_type = "text/plain"
        elif src_type == "url":
            source = {"type": "url", "url": src["url"]}
            media_type = "application/pdf"
        elif src_type == "file":
            source = {"type": "file_id", "file_id": src["file_id"], "provider": "anthropic"}
        else:
            return None

        ref = await normalizer({"kind": "document", "source": source})
        doc_b: BinaryBlock = {"type": "binary", "kind": "document", "media_type": media_type, "ref": ref}
        hints = _build_cache_hints(block.get("cache_control"))
        if hints:
            doc_b["hints"] = hints
        return doc_b

    if t == "tool_use":
        return {
            "type": "tool_call",
            "id": block["id"],
            "name": block["name"],
            "args": block.get("input", {}),
        }

    if t == "thinking":
        result_r: ReasoningBlock = {"type": "reasoning", "text": block["thinking"]}
        if block.get("signature"):
            result_r["opaque_signature"] = block["signature"]
        return result_r

    if t == "redacted_thinking":
        return {
            "type": "reasoning",
            "text": "",
            "redacted": True,
            "opaque_signature": block.get("data", ""),
        }

    return None


async def _normalize_tool_result_content(
    content: str | list[dict[str, Any]],
    normalizer: BinaryNormalizer,
) -> list[TextBlock | BinaryBlock]:
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    blocks: list[TextBlock | BinaryBlock] = []
    for item in content:
        if item.get("type") == "text":
            blocks.append({"type": "text", "text": item["text"]})
        elif item.get("type") == "image":
            b = await _normalize_block(item, normalizer)
            if b and b.get("type") == "binary":
                blocks.append(b)  # type: ignore[arg-type]
    return blocks


async def prepare_params(
    params: dict[str, Any],
    opts: AnthropicPrepareOptions | None = None,
) -> LlmCacheParams:
    """Normalise Anthropic Messages params to ``LlmCacheParams``."""
    normalizer = opts.normalizer if opts else default_normalizer
    messages: list[Any] = []

    # System message
    system = params.get("system")
    if system:
        if isinstance(system, str):
            messages.append({"role": "system", "content": system})
        else:
            sys_blocks: list[TextBlock] = []
            for b in system:
                tb: TextBlock = {"type": "text", "text": b["text"]}
                hints = _build_cache_hints(b.get("cache_control"))
                if hints:
                    tb["hints"] = hints
                sys_blocks.append(tb)
            messages.append({"role": "system", "content": sys_blocks})

    for msg in params.get("messages", []):
        role = msg["role"]
        content = msg["content"]

        if role == "assistant":
            if isinstance(content, str):
                messages.append({
                    "role": "assistant",
                    "content": [{"type": "text", "text": content}],
                })
            else:
                blocks: list[ContentBlock] = []
                for blk in content:
                    b = await _normalize_block(blk, normalizer)
                    if b is not None:
                        blocks.append(b)
                messages.append({"role": "assistant", "content": blocks})

        else:  # user
            if isinstance(content, str):
                messages.append({
                    "role": "user",
                    "content": [{"type": "text", "text": content}],
                })
                continue

            tool_results = [p for p in content if p.get("type") == "tool_result"]
            others = [p for p in content if p.get("type") != "tool_result"]

            for tr in tool_results:
                tr_content = await _normalize_tool_result_content(
                    tr.get("content") or "", normalizer
                )
                messages.append({
                    "role": "tool",
                    "tool_call_id": tr["tool_use_id"],
                    "content": tr_content,
                })

            if others:
                user_blocks: list[ContentBlock] = []
                for blk in others:
                    b = await _normalize_block(blk, normalizer)
                    if b is not None:
                        user_blocks.append(b)
                messages.append({"role": "user", "content": user_blocks})

    result: LlmCacheParams = {"model": params["model"], "messages": messages}
    if params.get("temperature") is not None:
        result["temperature"] = params["temperature"]
    if params.get("top_p") is not None:
        result["top_p"] = params["top_p"]
    if params.get("max_tokens") is not None:
        result["max_tokens"] = params["max_tokens"]
    if params.get("tools") is not None:
        result["tools"] = params["tools"]
    if params.get("tool_choice") is not None:
        result["tool_choice"] = params["tool_choice"]
    if params.get("stop_sequences") is not None:
        result["stop"] = params["stop_sequences"]

    return result
