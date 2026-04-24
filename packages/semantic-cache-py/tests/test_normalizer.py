"""Unit tests for normalizer.py."""
from __future__ import annotations

import hashlib

import pytest

from betterdb_semantic_cache.normalizer import (
    compose_normalizer,
    default_normalizer,
    hash_base64,
    hash_bytes,
    hash_url,
    passthrough,
)


def test_hash_base64_strips_prefix():
    data = b"hello world"
    import base64
    b64 = base64.b64encode(data).decode()
    data_url = f"data:image/png;base64,{b64}"
    result = hash_base64(data_url)
    assert result.startswith("sha256:")
    expected = "sha256:" + hashlib.sha256(data).hexdigest()
    assert result == expected


def test_hash_base64_without_prefix():
    data = b"raw bytes"
    import base64
    b64 = base64.b64encode(data).decode()
    result = hash_base64(b64)
    assert result == "sha256:" + hashlib.sha256(data).hexdigest()


def test_hash_bytes():
    data = b"test data"
    result = hash_bytes(data)
    assert result == "sha256:" + hashlib.sha256(data).hexdigest()


def test_hash_url_normalizes():
    url1 = "https://example.com/path?b=2&a=1"
    url2 = "https://example.com/path?a=1&b=2"
    assert hash_url(url1) == hash_url(url2)
    assert hash_url(url1).startswith("url:")


@pytest.mark.asyncio
async def test_passthrough_base64():
    ref = {"kind": "image", "source": {"type": "base64", "data": "abc123"}}
    assert await passthrough(ref) == "base64:abc123"  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_passthrough_url():
    ref = {"kind": "image", "source": {"type": "url", "url": "https://example.com"}}
    assert await passthrough(ref) == "url:https://example.com"  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_passthrough_file_id():
    ref = {"kind": "image", "source": {"type": "file_id", "file_id": "f123", "provider": "openai"}}
    assert await passthrough(ref) == "fileid:openai:f123"  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_passthrough_bytes():
    data = b"raw"
    ref = {"kind": "image", "source": {"type": "bytes", "data": data}}
    result = await passthrough(ref)  # type: ignore[arg-type]
    assert result == "sha256:" + hashlib.sha256(data).hexdigest()


@pytest.mark.asyncio
async def test_default_normalizer_passthrough():
    ref = {"kind": "image", "source": {"type": "url", "url": "https://example.com"}}
    result = await default_normalizer(ref)  # type: ignore[arg-type]
    assert result == "url:https://example.com"


@pytest.mark.asyncio
async def test_compose_normalizer_base64_handler():
    calls = []

    async def my_b64(data: str) -> str:
        calls.append(data)
        return f"custom:{data[:4]}"

    norm = compose_normalizer({"base64": my_b64})
    ref = {"kind": "image", "source": {"type": "base64", "data": "hello"}}
    result = await norm(ref)  # type: ignore[arg-type]
    assert result == "custom:hell"
    assert calls == ["hello"]


@pytest.mark.asyncio
async def test_compose_normalizer_by_kind():
    calls = []

    async def image_norm(ref: dict) -> str:
        calls.append(ref)
        return "image-normalized"

    norm = compose_normalizer({"by_kind": {"image": image_norm}})  # type: ignore[typeddict-item]
    ref = {"kind": "image", "source": {"type": "base64", "data": "x"}}
    result = await norm(ref)  # type: ignore[arg-type]
    assert result == "image-normalized"
    assert len(calls) == 1
