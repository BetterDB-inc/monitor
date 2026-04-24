"""Unit tests for utils.py."""
from __future__ import annotations

import struct

import pytest

from betterdb_semantic_cache.utils import (
    decode_float32,
    encode_float32,
    extract_binary_refs,
    extract_text,
    parse_ft_search_response,
    sha256,
)


def test_sha256_deterministic():
    assert sha256("hello") == sha256("hello")
    assert sha256("hello") != sha256("world")
    assert len(sha256("")) == 64  # hex digest is 64 chars


def test_encode_decode_float32_roundtrip():
    vec = [0.1, 0.5, 0.9, -0.3]
    encoded = encode_float32(vec)
    assert isinstance(encoded, bytes)
    assert len(encoded) == len(vec) * 4
    decoded = decode_float32(encoded)
    for a, b in zip(vec, decoded):
        assert abs(a - b) < 1e-6


def test_encode_float32_empty():
    assert encode_float32([]) == b""


def test_extract_text_from_text_blocks():
    blocks = [
        {"type": "text", "text": "Hello"},
        {"type": "binary", "kind": "image", "mediaType": "image/png", "ref": "ref1"},
        {"type": "text", "text": "World"},
    ]
    assert extract_text(blocks) == "Hello World"


def test_extract_text_empty():
    assert extract_text([]) == ""
    assert extract_text([{"type": "binary", "kind": "image", "mediaType": "image/png", "ref": "r"}]) == ""


def test_extract_binary_refs_sorted():
    blocks = [
        {"type": "binary", "kind": "image", "mediaType": "image/png", "ref": "b"},
        {"type": "text", "text": "hello"},
        {"type": "binary", "kind": "image", "mediaType": "image/png", "ref": "a"},
    ]
    assert extract_binary_refs(blocks) == ["a", "b"]


# --- parse_ft_search_response ---

def test_parse_ft_search_response_empty():
    assert parse_ft_search_response([]) == []
    assert parse_ft_search_response(None) == []
    assert parse_ft_search_response(["0"]) == []


def test_parse_ft_search_response_single_hit():
    raw = ["1", "mykey", ["response", "hello", "__score", "0.05"]]
    results = parse_ft_search_response(raw)
    assert len(results) == 1
    assert results[0]["key"] == "mykey"
    assert results[0]["fields"]["response"] == "hello"
    assert results[0]["fields"]["__score"] == "0.05"


def test_parse_ft_search_response_bytes():
    raw = [b"1", b"mykey", [b"response", b"hello", b"__score", b"0.05"]]
    results = parse_ft_search_response(raw)
    assert len(results) == 1
    assert results[0]["key"] == "mykey"
    assert results[0]["fields"]["response"] == "hello"


def test_parse_ft_search_response_multiple():
    raw = [
        "2",
        "key1", ["response", "r1", "__score", "0.01"],
        "key2", ["response", "r2", "__score", "0.09"],
    ]
    results = parse_ft_search_response(raw)
    assert len(results) == 2
    assert results[0]["key"] == "key1"
    assert results[1]["key"] == "key2"


def test_parse_ft_search_response_return_zero_mode():
    # RETURN 0 mode — no field list follows the key
    raw = ["2", "key1", "key2"]
    results = parse_ft_search_response(raw)
    assert len(results) >= 1


def test_parse_ft_search_response_malformed_returns_empty():
    assert parse_ft_search_response("not a list") == []
    assert parse_ft_search_response({"key": "val"}) == []
