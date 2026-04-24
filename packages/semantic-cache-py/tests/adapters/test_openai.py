"""Tests for the OpenAI Chat Completions adapter."""
from __future__ import annotations

import pytest

from betterdb_semantic_cache.adapters.openai import prepare_semantic_params


@pytest.mark.asyncio
async def test_simple_string_message():
    params = {
        "model": "gpt-4o",
        "messages": [{"role": "user", "content": "What is the weather?"}],
    }
    result = await prepare_semantic_params(params)
    assert result.text == "What is the weather?"
    assert result.model == "gpt-4o"
    assert result.blocks is None


@pytest.mark.asyncio
async def test_extracts_last_user_message():
    params = {
        "model": "gpt-4o",
        "messages": [
            {"role": "user", "content": "First question"},
            {"role": "assistant", "content": "First answer"},
            {"role": "user", "content": "Second question"},
        ],
    }
    result = await prepare_semantic_params(params)
    assert result.text == "Second question"


@pytest.mark.asyncio
async def test_no_user_messages_returns_empty():
    params = {
        "model": "gpt-4o",
        "messages": [{"role": "system", "content": "You are helpful"}],
    }
    result = await prepare_semantic_params(params)
    assert result.text == ""
    assert result.model == "gpt-4o"


@pytest.mark.asyncio
async def test_multipart_content_with_text():
    params = {
        "model": "gpt-4o",
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Describe this image"},
                    {"type": "image_url", "image_url": {"url": "https://example.com/img.png"}},
                ],
            }
        ],
    }
    result = await prepare_semantic_params(params)
    assert result.text == "Describe this image"
    assert result.blocks is not None
    assert len(result.blocks) == 2
    assert result.blocks[0]["type"] == "text"
    assert result.blocks[1]["type"] == "binary"
    assert result.blocks[1]["kind"] == "image"


@pytest.mark.asyncio
async def test_base64_image_hashed():
    import base64
    raw = b"fake image data"
    b64 = base64.b64encode(raw).decode()
    params = {
        "model": "gpt-4o",
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Describe this"},
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
                ],
            }
        ],
    }
    result = await prepare_semantic_params(params)
    assert result.blocks is not None
    binary_block = next(b for b in result.blocks if b.get("type") == "binary")
    assert binary_block["ref"].startswith("base64:")


@pytest.mark.asyncio
async def test_model_extracted():
    params = {
        "model": "gpt-4o-mini",
        "messages": [{"role": "user", "content": "hello"}],
    }
    result = await prepare_semantic_params(params)
    assert result.model == "gpt-4o-mini"
