"""Tests for the LlamaIndex adapter."""
from __future__ import annotations

import pytest

from betterdb_semantic_cache.adapters.llamaindex import prepare_semantic_params


@pytest.mark.asyncio
async def test_simple_string_content():
    messages = [{"role": "user", "content": "What is LlamaIndex?"}]
    result = await prepare_semantic_params(messages, model="gpt-4o")
    assert result.text == "What is LlamaIndex?"
    assert result.model == "gpt-4o"


@pytest.mark.asyncio
async def test_extracts_last_user_message():
    messages = [
        {"role": "user", "content": "First"},
        {"role": "assistant", "content": "Answer"},
        {"role": "user", "content": "Second"},
    ]
    result = await prepare_semantic_params(messages)
    assert result.text == "Second"


@pytest.mark.asyncio
async def test_no_user_messages():
    messages = [{"role": "system", "content": "You are helpful"}]
    result = await prepare_semantic_params(messages)
    assert result.text == ""


@pytest.mark.asyncio
async def test_multipart_text():
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "Analyze this"},
                {"type": "image_url", "image_url": {"url": "https://example.com/img.png"}},
            ],
        }
    ]
    result = await prepare_semantic_params(messages)
    assert result.text == "Analyze this"
    assert result.blocks is not None
    binary = next((b for b in result.blocks if b.get("type") == "binary"), None)
    assert binary is not None
    assert binary["kind"] == "image"
