"""OpenAI Chat Completions adapter.

Converts the params dict passed to ``openai.chat.completions.create()`` into
the canonical ``LlmCacheParams`` format used by the cache.

Usage::

    from betterdb_agent_cache.adapters.openai import prepare_params

    params = await prepare_params({"model": "gpt-4o", "messages": [...]})
    result = await cache.llm.check(params)
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..normalizer import BinaryNormalizer, default_normalizer
from ..types import (
    BinaryBlock,
    ContentBlock,
    LlmCacheParams,
    TextBlock,
    ToolCallBlock,
)
from ..utils import parse_tool_call_args


@dataclass
class OpenAIPrepareOptions:
    normalizer: BinaryNormalizer = field(default_factory=lambda: default_normalizer)


async def _normalize_user_content(
    content: str | list[dict[str, Any]],
    normalizer: BinaryNormalizer,
) -> list[ContentBlock]:
    if isinstance(content, str):
        return [{"type": "text", "text": content}]

    blocks: list[ContentBlock] = []
    for part in content:
        t = part.get("type")

        if t == "text":
            blocks.append({"type": "text", "text": part["text"]})

        elif t == "image_url":
            image_url = part["image_url"]
            url: str = image_url["url"]
            media_type = "image/*"
            if url.startswith("data:"):
                semi = url.find(";")
                if semi > 5:
                    media_type = url[5:semi]
                source: dict[str, Any] = {"type": "base64", "data": url}
            else:
                source = {"type": "url", "url": url}
            ref = await normalizer({"kind": "image", "source": source})
            block: BinaryBlock = {"type": "binary", "kind": "image", "media_type": media_type, "ref": ref}
            if image_url.get("detail"):
                block["detail"] = image_url["detail"]
            blocks.append(block)

        elif t == "input_audio":
            audio = part["input_audio"]
            ref = await normalizer({
                "kind": "audio",
                "source": {"type": "base64", "data": audio["data"]},
            })
            blocks.append({
                "type": "binary", "kind": "audio",
                "media_type": f"audio/{audio['format']}",
                "ref": ref,
            })

        elif t == "file":
            file_info = part["file"]
            file_id = file_info.get("file_id")
            file_data = file_info.get("file_data")
            media_type = "application/octet-stream"
            if file_id:
                src: dict[str, Any] = {"type": "file_id", "file_id": file_id, "provider": "openai"}
            elif file_data:
                if file_data.startswith("data:"):
                    semi = file_data.find(";")
                    if semi > 5:
                        media_type = file_data[5:semi]
                src = {"type": "base64", "data": file_data}
            else:
                continue
            ref = await normalizer({"kind": "document", "source": src})
            doc_block: BinaryBlock = {
                "type": "binary", "kind": "document", "media_type": media_type, "ref": ref,
            }
            if file_info.get("filename"):
                doc_block["filename"] = file_info["filename"]
            blocks.append(doc_block)

    return blocks


async def prepare_params(
    params: dict[str, Any],
    opts: OpenAIPrepareOptions | None = None,
) -> LlmCacheParams:
    """Normalise OpenAI Chat Completions params to ``LlmCacheParams``."""
    normalizer = opts.normalizer if opts else default_normalizer
    messages: list[Any] = []

    for msg in params.get("messages", []):
        role: str = msg.get("role", "user")

        if role in ("system", "developer"):
            content = msg["content"]
            if isinstance(content, str):
                messages.append({"role": "system", "content": content})
            else:
                blocks: list[TextBlock] = [
                    {"type": "text", "text": p["text"]}
                    for p in content
                    if p.get("type") == "text" and p.get("text") is not None
                ]
                messages.append({"role": "system", "content": blocks})

        elif role == "user":
            content = msg["content"]
            normalized = await _normalize_user_content(content, normalizer)
            entry: dict[str, Any] = {"role": "user", "content": normalized}
            if msg.get("name"):
                entry["name"] = msg["name"]
            messages.append(entry)

        elif role == "assistant":
            content = msg.get("content")
            tool_calls = msg.get("tool_calls")
            blocks_a: list[ContentBlock] = []

            if content:
                if isinstance(content, str):
                    blocks_a.append({"type": "text", "text": content})
                else:
                    for part in content:
                        if part.get("type") == "text" and part.get("text") is not None:
                            blocks_a.append({"type": "text", "text": part["text"]})

            if tool_calls:
                for tc in tool_calls:
                    if tc.get("type") != "function":
                        continue
                    fn = tc["function"]
                    blocks_a.append({
                        "type": "tool_call",
                        "id": tc["id"],
                        "name": fn["name"],
                        "args": parse_tool_call_args(fn.get("arguments", "{}")),
                    })

            messages.append({"role": "assistant", "content": blocks_a})

        elif role == "tool":
            content = msg["content"]
            if isinstance(content, str):
                text = content
            else:
                text = "".join(
                    p.get("text", "")
                    for p in content
                    if p.get("type") == "text"
                )
            messages.append({
                "role": "tool",
                "toolCallId": msg["tool_call_id"],
                "content": [{"type": "text", "text": text}],
            })

        elif role == "function":
            messages.append({
                "role": "tool",
                "toolCallId": f"legacy:{msg['name']}",
                "content": [{"type": "text", "text": msg.get("content") or ""}],
            })

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
    if params.get("seed") is not None:
        result["seed"] = params["seed"]
    if params.get("stop") is not None:
        stop = params["stop"]
        result["stop"] = [stop] if isinstance(stop, str) else stop
    if params.get("response_format") is not None:
        result["response_format"] = params["response_format"]
    if params.get("prompt_cache_key") is not None:
        result["prompt_cache_key"] = params["prompt_cache_key"]

    return result
