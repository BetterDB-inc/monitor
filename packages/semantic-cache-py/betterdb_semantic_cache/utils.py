from __future__ import annotations

import hashlib
import re
import struct
from typing import Any, Literal, NotRequired, Required, TypedDict


def sha256(text: str) -> str:
    """SHA-256 hex digest of a UTF-8 string."""
    return hashlib.sha256(text.encode()).hexdigest()


_TAG_ESCAPE_RE = re.compile(r'([,.<>{}\[\]"\'!@#$%^&*()\-+=~|/\\:; ])')


def escape_tag(value: str) -> str:
    """Escape a string for safe use as a Valkey Search TAG filter value.

    Spaces are escaped because Valkey Search treats unescaped spaces in TAG
    values as term separators (OR semantics), which would broaden the filter.
    """
    return _TAG_ESCAPE_RE.sub(r'\\\1', value)


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


def encode_float32(vec: list[float]) -> bytes:
    """Encode a float list as little-endian Float32 bytes."""
    return struct.pack(f"<{len(vec)}f", *vec)


def decode_float32(data: bytes) -> list[float]:
    """Decode little-endian Float32 bytes into a float list."""
    n = len(data) // 4
    return list(struct.unpack_from(f"<{n}f", data))


def parse_ft_search_response(raw: Any) -> list[dict[str, Any]]:
    """Parse a raw FT.SEARCH response from valkey-py's execute_command().

    valkey-py returns FT.SEARCH results as a mixed bytes/str list:
      [totalCount, key1, [field1, val1, ...], key2, [...], ...]

    Returns a list of {'key': str, 'fields': dict[str, str]}.
    Returns [] if totalCount is 0 or the response is malformed.
    Never raises — on any parse error, returns [].
    """
    try:
        if not isinstance(raw, (list, tuple)) or len(raw) < 1:
            return []

        total_raw = raw[0]
        if isinstance(total_raw, bytes):
            total = int(total_raw.decode())
        elif isinstance(total_raw, str):
            total = int(total_raw)
        else:
            total = int(total_raw)

        if total <= 0:
            return []

        results = []
        i = 1
        while i < len(raw):
            key = raw[i]
            if isinstance(key, bytes):
                key = key.decode()
            elif not isinstance(key, str):
                i += 1
                continue

            if i + 1 >= len(raw):
                results.append({"key": key, "fields": {}})
                break

            field_list = raw[i + 1]
            fields: dict[str, str] = {}

            if isinstance(field_list, (list, tuple)):
                j = 0
                while j < len(field_list) - 1:
                    fname = field_list[j]
                    fval = field_list[j + 1]
                    if isinstance(fname, bytes):
                        fname = fname.decode()
                    else:
                        fname = str(fname)
                    if isinstance(fval, bytes):
                        try:
                            fval = fval.decode()
                        except (UnicodeDecodeError, AttributeError):
                            # Binary field (e.g. embedding bytes) — skip it
                            j += 2
                            continue
                    else:
                        fval = str(fval)
                    fields[fname] = fval
                    j += 2
                i += 2
            else:
                results.append({"key": key, "fields": {}})
                i += 1
                continue

            results.append({"key": key, "fields": fields})

        return results
    except Exception:
        return []
