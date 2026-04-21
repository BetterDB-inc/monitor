from __future__ import annotations

import hashlib
import json
import re
from typing import Any

from .types import LlmCacheParams


def sha256(value: str) -> str:
    """SHA-256 hex digest of a UTF-8 string."""
    return hashlib.sha256(value.encode()).hexdigest()


def escape_glob_pattern(s: str) -> str:
    """Escape glob metacharacters for use in Valkey SCAN MATCH patterns.
    Backslash is escaped first so subsequent replacements don't double-escape.
    """
    s = s.replace("\\", "\\\\")
    return re.sub(r"([*?\[\]])", r"\\\1", s)


def canonical_json(obj: Any) -> str:
    """Serialise with recursively sorted object keys for deterministic hashing.
    Arrays preserve insertion order. Produces compact JSON (no spaces).
    """

    def _sort(value: Any) -> Any:
        if isinstance(value, dict):
            return {k: _sort(v) for k, v in sorted(value.items())}
        if isinstance(value, list):
            return [_sort(item) for item in value]
        return value

    return json.dumps(_sort(obj), separators=(",", ":"), ensure_ascii=False)


def llm_cache_hash(params: LlmCacheParams) -> str:
    """Stable hash over all cache-relevant LLM parameters.

    None / missing optional fields are omitted, mirroring TypeScript's
    JSON.stringify dropping undefined values for backward compatibility.
    """
    tools = params.get("tools")
    if tools is not None:
        # Support both Chat Completions format {"function": {"name": ...}}
        # and Responses API format {"name": ...}
        tools = sorted(
            tools,
            key=lambda t: (t.get("function") or {}).get("name") or t.get("name") or "",
        )

    d: dict[str, Any] = {
        "model": params["model"],
        "messages": params["messages"],
        "temperature": params.get("temperature", 1),
        "top_p": params.get("top_p", 1),
    }
    for src_key, out_key in (
        ("max_tokens", "max_tokens"),
        ("tool_choice", "toolChoice"),
        ("seed", "seed"),
        ("stop", "stop"),
        ("response_format", "responseFormat"),
        ("reasoning_effort", "reasoningEffort"),
        ("prompt_cache_key", "promptCacheKey"),
    ):
        val = params.get(src_key)
        if val is not None:
            d[out_key] = val
    if tools is not None:
        d["tools"] = tools

    return sha256(canonical_json(d))


def tool_cache_hash(args: Any) -> str:
    """Stable hash over tool call arguments."""
    return sha256(canonical_json(args if args is not None else {}))


def parse_tool_call_args(raw: str) -> Any:
    """Parse JSON-encoded tool call arguments, falling back to {'__raw': raw}."""
    try:
        return json.loads(raw or "{}")
    except (json.JSONDecodeError, ValueError):
        return {"__raw": raw}
