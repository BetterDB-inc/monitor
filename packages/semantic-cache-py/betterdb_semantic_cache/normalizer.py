from __future__ import annotations

import base64
import hashlib
from collections.abc import Awaitable, Callable
from typing import Any, Literal, NotRequired, Required, TypedDict
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse


# ─── Types ────────────────────────────────────────────────────────────────────

class Base64Source(TypedDict):
    type: Literal["base64"]
    data: str
    media_type: NotRequired[str]


class UrlSource(TypedDict):
    type: Literal["url"]
    url: str


class FileIdSource(TypedDict):
    type: Literal["file_id"]
    file_id: str
    provider: str


class BytesSource(TypedDict):
    type: Literal["bytes"]
    data: bytes


BinarySource = Base64Source | UrlSource | FileIdSource | BytesSource


class BinaryRef(TypedDict):
    kind: Literal["image", "audio", "document"]
    source: BinarySource
    context: NotRequired[dict[str, Any]]


BinaryNormalizer = Callable[[BinaryRef], Awaitable[str]]


class NormalizerConfig(TypedDict, total=False):
    base64: Callable[[str], str | Awaitable[str]]
    url: Callable[[str], str | Awaitable[str]]
    file_id: Callable[[str, str], str | Awaitable[str]]
    bytes: Callable[[bytes], str | Awaitable[str]]
    by_kind: dict[Literal["image", "audio", "document"], BinaryNormalizer]


# ─── Built-in normalizer helpers ──────────────────────────────────────────────

def hash_base64(data: str) -> str:
    """Strip any data-URL prefix, decode the bytes, and return 'sha256:<hex>'."""
    if ";base64," in data:
        data = data.split(";base64,", 1)[1]
    raw = base64.b64decode(data + "==")  # padding-tolerant
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def hash_bytes(data: bytes) -> str:
    """Return 'sha256:<hex>' of the raw bytes."""
    return "sha256:" + hashlib.sha256(data).hexdigest()


def hash_url(url_str: str) -> str:
    """Normalise a URL (lowercase scheme+host, sorted query params) and return 'url:<normalised>'."""
    parsed = urlparse(url_str)
    sorted_query = urlencode(sorted(parse_qsl(parsed.query)))
    normalised = urlunparse((
        parsed.scheme.lower(),
        parsed.netloc.lower(),
        parsed.path,
        parsed.params,
        sorted_query,
        parsed.fragment,
    ))
    return "url:" + normalised


async def fetch_and_hash(url: str) -> str:
    """Fetch a URL and return 'sha256:<hex>' of the response body.
    Requires httpx: pip install httpx
    """
    import httpx

    async with httpx.AsyncClient() as client:
        resp = await client.get(url)
        resp.raise_for_status()
        return "sha256:" + hashlib.sha256(resp.content).hexdigest()


def passthrough(ref: BinaryRef) -> str:
    """Return a scheme-prefixed reference without any transformation."""
    source = ref["source"]
    t = source["type"]
    if t == "base64":
        return "base64:" + source["data"]  # type: ignore[index]
    if t == "url":
        return "url:" + source["url"]  # type: ignore[index]
    if t == "file_id":
        return f"fileid:{source['provider']}:{source['file_id']}"  # type: ignore[index]
    # bytes — hash them (can't round-trip raw bytes as a string)
    return hash_bytes(source["data"])  # type: ignore[index]


# ─── Factory ──────────────────────────────────────────────────────────────────

def compose_normalizer(cfg: NormalizerConfig | None = None) -> BinaryNormalizer:
    """Build a BinaryNormalizer from a config.

    Dispatch priority:
    1. cfg['by_kind'][ref.kind] — kind-specific override.
    2. cfg per-source-type handler (base64 / url / file_id / bytes).
    3. passthrough fallback.
    """
    import asyncio

    c: NormalizerConfig = cfg or {}

    async def normalizer(ref: BinaryRef) -> str:
        kind = ref["kind"]
        by_kind = c.get("by_kind", {})
        source = ref["source"]
        t = source["type"]

        async def _call(handler: Any, *args: Any) -> str:
            result = handler(*args)
            return await result if asyncio.iscoroutine(result) else result  # type: ignore[return-value]

        if kind in by_kind:
            return await _call(by_kind[kind], ref)

        if t == "base64":
            h = c.get("base64")
            return await _call(h, source["data"]) if h else passthrough(ref)  # type: ignore[index]
        if t == "url":
            h = c.get("url")
            return await _call(h, source["url"]) if h else passthrough(ref)  # type: ignore[index]
        if t == "file_id":
            h = c.get("file_id")
            return (
                await _call(h, source["file_id"], source["provider"])  # type: ignore[index]
                if h
                else passthrough(ref)
            )
        # bytes
        h = c.get("bytes")
        return await _call(h, source["data"]) if h else passthrough(ref)  # type: ignore[index]

    return normalizer


default_normalizer: BinaryNormalizer = compose_normalizer({
    "base64": hash_base64,
    "bytes": hash_bytes,
})
