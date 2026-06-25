from __future__ import annotations

import hashlib
from typing import Any, Literal, NotRequired, Required, TypedDict

from betterdb_valkey_search_kit import (
    decode_float32 as decode_float32,
    encode_float32 as encode_float32,
    escape_tag as escape_tag,
    parse_ft_search_response as parse_ft_search_response,
)


def sha256(text: str) -> str:
    """SHA-256 hex digest of a UTF-8 string."""
    return hashlib.sha256(text.encode()).hexdigest()


# --- Content block types ---

class BlockHints(TypedDict, total=False):
    anthropicCacheControl: NotRequired[dict]


class TextBlock(TypedDict):
    type: Literal["text"]
    text: str
    hints: NotRequired[BlockHints]


class BinaryBlock(TypedDict):
    type: Literal["binary"]
    kind: Literal["image", "audio", "document"]
    mediaType: str
    ref: str
    detail: NotRequired[Literal["auto", "low", "high", "original"]]
    filename: NotRequired[str]
    hints: NotRequired[BlockHints]


class ToolCallBlock(TypedDict):
    type: Literal["tool_call"]
    id: str
    name: str
    args: Any
    hints: NotRequired[BlockHints]


class ToolResultBlock(TypedDict):
    type: Literal["tool_result"]
    toolCallId: str
    content: list  # list[TextBlock | BinaryBlock]
    isError: NotRequired[bool]
    hints: NotRequired[BlockHints]


class ReasoningBlock(TypedDict):
    type: Literal["reasoning"]
    text: str
    opaqueSignature: NotRequired[str]
    redacted: NotRequired[bool]
    hints: NotRequired[BlockHints]


ContentBlock = TextBlock | BinaryBlock | ToolCallBlock | ToolResultBlock | ReasoningBlock


def extract_text(blocks: list[ContentBlock]) -> str:
    """Extract all text from a ContentBlock list, joining TextBlock.text values with a space."""
    parts = [b["text"] for b in blocks if b.get("type") == "text" and isinstance(b.get("text"), str)]
    return " ".join(parts)


def extract_binary_refs(blocks: list[ContentBlock]) -> list[str]:
    """Extract all binary refs from a ContentBlock list, sorted for stability."""
    refs = [b["ref"] for b in blocks if b.get("type") == "binary" and isinstance(b.get("ref"), str)]
    return sorted(refs)
