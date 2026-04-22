"""OpenAI Responses API adapter.

Converts params for ``openai.responses.create()`` into ``LlmCacheParams``.

Usage::

    from betterdb_agent_cache.adapters.openai_responses import prepare_params

    params = await prepare_params({"model": "gpt-4o", "input": [...]})
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
    ReasoningBlock,
    TextBlock,
    ToolCallBlock,
)
from ..utils import parse_tool_call_args


@dataclass
class OpenAIResponsesPrepareOptions:
    normalizer: BinaryNormalizer = field(default_factory=lambda: default_normalizer)


async def _normalize_part(
    part: dict[str, Any],
    normalizer: BinaryNormalizer,
) -> ContentBlock | None:
    t = part.get("type")

    if t in ("input_text", "output_text"):
        return {"type": "text", "text": part.get("text") or ""}

    if t == "input_image":
        file_id = part.get("file_id")
        image_url = part.get("image_url")
        detail = part.get("detail")
        media_type = "image/*"

        if file_id:
            source: dict[str, Any] = {"type": "file_id", "file_id": file_id, "provider": "openai"}
        elif image_url:
            if image_url.startswith("data:"):
                semi = image_url.find(";")
                if semi > 5:
                    media_type = image_url[5:semi]
                source = {"type": "base64", "data": image_url}
            else:
                source = {"type": "url", "url": image_url}
        else:
            return None

        ref = await normalizer({"kind": "image", "source": source})
        block: BinaryBlock = {"type": "binary", "kind": "image", "mediaType": media_type, "ref": ref}
        if detail:
            block["detail"] = detail
        return block

    if t == "input_file":
        file_id = part.get("file_id")
        file_data = part.get("file_data")
        file_url = part.get("file_url")
        filename = part.get("filename")
        media_type = "application/octet-stream"

        if file_id:
            source = {"type": "file_id", "file_id": file_id, "provider": "openai"}
        elif file_data:
            if file_data.startswith("data:"):
                semi = file_data.find(";")
                if semi > 5:
                    media_type = file_data[5:semi]
            source = {"type": "base64", "data": file_data}
        elif file_url:
            source = {"type": "url", "url": file_url}
        else:
            return None

        ref = await normalizer({"kind": "document", "source": source})
        doc_block: BinaryBlock = {
            "type": "binary", "kind": "document", "mediaType": media_type, "ref": ref,
        }
        if filename:
            doc_block["filename"] = filename
        return doc_block

    return None


async def _normalize_message_content(
    content: str | list[dict[str, Any]],
    normalizer: BinaryNormalizer,
) -> str | list[ContentBlock]:
    if isinstance(content, str):
        return content
    blocks: list[ContentBlock] = []
    for part in content:
        b = await _normalize_part(part, normalizer)
        if b is not None:
            blocks.append(b)
    return blocks


async def prepare_params(
    params: dict[str, Any],
    opts: OpenAIResponsesPrepareOptions | None = None,
) -> LlmCacheParams:
    """Normalise OpenAI Responses API params to ``LlmCacheParams``."""
    normalizer = opts.normalizer if opts else default_normalizer
    messages: list[Any] = []

    if params.get("instructions"):
        messages.append({"role": "system", "content": params["instructions"]})

    input_ = params.get("input")
    if isinstance(input_, str):
        messages.append({"role": "user", "content": input_})

    elif isinstance(input_, list):
        current_assistant: dict[str, Any] | None = None

        def flush() -> None:
            nonlocal current_assistant
            if current_assistant and current_assistant["content"]:
                messages.append(dict(current_assistant))
            current_assistant = None

        for raw_item in input_:
            item: dict[str, Any] = raw_item
            item_type = item.get("type")

            if item_type == "function_call":
                if current_assistant is None:
                    current_assistant = {"role": "assistant", "content": []}
                current_assistant["content"].append({
                    "type": "tool_call",
                    "id": item.get("call_id", ""),
                    "name": item.get("name", ""),
                    "args": parse_tool_call_args(item.get("arguments") or "{}"),
                })
                continue

            if item_type == "reasoning":
                if current_assistant is None:
                    current_assistant = {"role": "assistant", "content": []}
                summary = item.get("summary") or []
                text = "".join(
                    s.get("text", "")
                    for s in summary
                    if s.get("type") == "reasoning_text"
                )
                reasoning_block: ReasoningBlock = {"type": "reasoning", "text": text}
                if item.get("encrypted_content"):
                    reasoning_block["opaqueSignature"] = item["encrypted_content"]
                current_assistant["content"].append(reasoning_block)
                continue

            if item_type == "function_call_output":
                flush()
                output = item.get("output")
                if isinstance(output, str):
                    text_val = output
                elif output is not None:
                    import json as _json
                    text_val = _json.dumps(output)
                else:
                    text_val = ""
                messages.append({
                    "role": "tool",
                    "toolCallId": item.get("call_id", ""),
                    "content": [{"type": "text", "text": text_val}],
                })
                continue

            # Message item (type == "message" or has role)
            flush()
            role = item.get("role") or "user"
            content = item.get("content")
            if content is None:
                continue
            normalized = await _normalize_message_content(content, normalizer)
            messages.append({"role": role, "content": normalized})

        flush()

    result: LlmCacheParams = {"model": params["model"], "messages": messages}
    if params.get("temperature") is not None:
        result["temperature"] = params["temperature"]
    if params.get("top_p") is not None:
        result["top_p"] = params["top_p"]
    if params.get("max_output_tokens") is not None:
        result["max_tokens"] = params["max_output_tokens"]
    if params.get("tools") is not None:
        result["tools"] = params["tools"]
    if params.get("tool_choice") is not None:
        result["tool_choice"] = params["tool_choice"]
    reasoning = params.get("reasoning")
    if isinstance(reasoning, dict) and reasoning.get("effort") is not None:
        result["reasoning_effort"] = reasoning["effort"]
    if params.get("prompt_cache_key") is not None:
        result["prompt_cache_key"] = params["prompt_cache_key"]

    return result
