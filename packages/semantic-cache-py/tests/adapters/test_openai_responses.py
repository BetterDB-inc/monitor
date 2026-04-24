"""Tests for the OpenAI Responses API adapter."""
from __future__ import annotations

import pytest

from betterdb_semantic_cache.adapters.openai_responses import prepare_semantic_params


@pytest.mark.asyncio
async def test_string_input():
    params = {"model": "gpt-4o", "input": "Hello, world!"}
    result = await prepare_semantic_params(params)
    assert result.text == "Hello, world!"
    assert result.model == "gpt-4o"


@pytest.mark.asyncio
async def test_list_input_user_message():
    params = {
        "model": "gpt-4o",
        "input": [
            {"role": "user", "content": "What is Python?"},
        ],
    }
    result = await prepare_semantic_params(params)
    assert result.text == "What is Python?"


@pytest.mark.asyncio
async def test_list_input_with_content_parts():
    params = {
        "model": "gpt-4o",
        "input": [
            {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": "Describe this"},
                    {"type": "input_image", "image_url": "https://example.com/img.png"},
                ],
            },
        ],
    }
    result = await prepare_semantic_params(params)
    assert result.text == "Describe this"
    assert result.blocks is not None
    assert len(result.blocks) == 2


@pytest.mark.asyncio
async def test_instructions_fallback():
    params = {"model": "gpt-4o", "instructions": "You are a helpful assistant."}
    result = await prepare_semantic_params(params)
    assert result.text == "You are a helpful assistant."


@pytest.mark.asyncio
async def test_empty_returns_empty():
    params = {"model": "gpt-4o"}
    result = await prepare_semantic_params(params)
    assert result.text == ""
    assert result.model == "gpt-4o"
