"""Tests for the Anthropic Messages API adapter."""
from __future__ import annotations

import pytest

from betterdb_semantic_cache.adapters.anthropic import prepare_semantic_params


@pytest.mark.asyncio
async def test_simple_string_message():
    params = {
        "model": "claude-3-5-sonnet-20241022",
        "messages": [{"role": "user", "content": "What is the capital of France?"}],
    }
    result = await prepare_semantic_params(params)
    assert result.text == "What is the capital of France?"
    assert result.model == "claude-3-5-sonnet-20241022"


@pytest.mark.asyncio
async def test_extracts_last_user_message():
    params = {
        "model": "claude-3-5-sonnet-20241022",
        "messages": [
            {"role": "user", "content": "First"},
            {"role": "assistant", "content": "Answer"},
            {"role": "user", "content": "Second"},
        ],
    }
    result = await prepare_semantic_params(params)
    assert result.text == "Second"


@pytest.mark.asyncio
async def test_no_user_messages_empty():
    params = {
        "model": "claude-3-5-sonnet-20241022",
        "messages": [],
    }
    result = await prepare_semantic_params(params)
    assert result.text == ""


@pytest.mark.asyncio
async def test_multipart_text_and_image():
    params = {
        "model": "claude-3-5-sonnet-20241022",
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "What's in this image?"},
                    {
                        "type": "image",
                        "source": {"type": "base64", "data": "abc123", "media_type": "image/jpeg"},
                    },
                ],
            }
        ],
    }
    result = await prepare_semantic_params(params)
    assert result.text == "What's in this image?"
    assert result.blocks is not None
    assert len(result.blocks) == 2
    assert result.blocks[1]["type"] == "binary"
    assert result.blocks[1]["kind"] == "image"


@pytest.mark.asyncio
async def test_document_base64():
    import base64
    text_content = "Document text here"
    b64 = base64.b64encode(text_content.encode()).decode()
    params = {
        "model": "claude-3-5-sonnet-20241022",
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Summarize this document"},
                    {
                        "type": "document",
                        "source": {"type": "base64", "data": b64, "media_type": "application/pdf"},
                    },
                ],
            }
        ],
    }
    result = await prepare_semantic_params(params)
    assert result.blocks is not None
    doc_block = next(b for b in result.blocks if b.get("type") == "binary")
    assert doc_block["kind"] == "document"
    assert doc_block["mediaType"] == "application/pdf"
