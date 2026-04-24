"""OpenAI Responses API adapter for betterdb-semantic-cache.

Extracts the text to embed from OpenAI Responses API request params.
Keys on the last user input text.

Usage::

    from betterdb_semantic_cache.adapters.openai_responses import prepare_semantic_params
    params = await prepare_semantic_params(responses_params)
    result = await cache.check(params.text)
"""
from __future__ import annotations

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


async def _normalize_responses_part(
    part: Any,
    normalizer: BinaryNormalizer,
) -> TextBlock | BinaryBlock | None:
    t = _get(part, "type")

    if t in ("input_text", "output_text"):
        return TextBlock(type="text", text=_get(part, "text", "") or "")

    if t == "input_image":
        file_id = _get(part, "file_id")
        image_url = _get(part, "image_url")
        detail = _get(part, "detail")
        media_type = "image/*"

        if file_id:
            source: Any = {"type": "file_id", "file_id": file_id, "provider": "openai"}
        elif image_url:
            if isinstance(image_url, str) and image_url.startswith("data:"):
                semi = image_url.find(";")
                if semi > 5:
                    media_type = image_url[5:semi]
                source = {"type": "base64", "data": image_url}
            else:
                source = {"type": "url", "url": image_url}
        else:
            return None

        ref = await normalizer({"kind": "image", "source": source})  # type: ignore[typeddict-item]
        block = BinaryBlock(type="binary", kind="image", mediaType=media_type, ref=ref)
        if detail:
            block["detail"] = detail
        return block

    if t == "input_file":
        file_id = _get(part, "file_id")
        file_data = _get(part, "file_data")
        file_url = _get(part, "file_url")
        filename = _get(part, "filename")
        media_type = "application/octet-stream"

        if file_id:
            source = {"type": "file_id", "file_id": file_id, "provider": "openai"}
        elif file_data:
            if isinstance(file_data, str) and file_data.startswith("data:"):
                semi = file_data.find(";")
                if semi > 5:
                    media_type = file_data[5:semi]
            source = {"type": "base64", "data": file_data}
        elif file_url:
            source = {"type": "url", "url": file_url}
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
    """Extract semantic cache params from OpenAI Responses API request params."""
    norm = normalizer or default_normalizer
    model = _get(params, "model")
    input_val = _get(params, "input")
    instructions = _get(params, "instructions")

    if isinstance(input_val, str):
        return SemanticParams(text=input_val, model=model)

    if isinstance(input_val, list):
        user_items = [
            item for item in input_val
            if not _get(item, "role") or _get(item, "role") == "user"
            or _get(item, "type") == "message"
        ]
        last_user = user_items[-1] if user_items else None

        if last_user is not None:
            content = _get(last_user, "content")
            if isinstance(content, str):
                return SemanticParams(text=content, model=model)
            if isinstance(content, list):
                blocks: list[TextBlock | BinaryBlock] = []
                for part in content:
                    block = await _normalize_responses_part(part, norm)
                    if block is not None:
                        blocks.append(block)
                text = " ".join(b["text"] for b in blocks if b.get("type") == "text")
                return SemanticParams(text=text, blocks=blocks, model=model)

    if instructions:
        return SemanticParams(text=instructions, model=model)

    return SemanticParams(text="", model=model)
