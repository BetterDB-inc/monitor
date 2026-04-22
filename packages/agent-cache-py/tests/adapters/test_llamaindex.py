"""Tests for the LlamaIndex adapter."""
from __future__ import annotations

import pytest
from betterdb_agent_cache.adapters.llamaindex import prepare_params


# ─── basic role mapping ───────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_user_message():
    p = await prepare_params(
        [{"role": "user", "content": "hello"}],
        model="gpt-4o",
    )
    assert p["messages"][0]["role"] == "user"
    assert p["messages"][0]["content"] == [{"type": "text", "text": "hello"}]


@pytest.mark.asyncio
async def test_assistant_message():
    p = await prepare_params(
        [{"role": "assistant", "content": "I will help"}],
        model="gpt-4o",
    )
    assert p["messages"][0]["role"] == "assistant"


@pytest.mark.asyncio
async def test_memory_role_mapped_to_system():
    p = await prepare_params(
        [{"role": "memory", "content": "Context here"}],
        model="gpt-4o",
    )
    assert p["messages"][0]["role"] == "system"


@pytest.mark.asyncio
async def test_developer_role_mapped_to_system():
    p = await prepare_params(
        [{"role": "developer", "content": "Be concise"}],
        model="gpt-4o",
    )
    assert p["messages"][0]["role"] == "system"


@pytest.mark.asyncio
async def test_empty_string_content_skipped():
    p = await prepare_params(
        [{"role": "user", "content": ""}],
        model="gpt-4o",
    )
    assert p["messages"][0]["content"] == []


# ─── tool calls and results ───────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_tool_result_from_options():
    p = await prepare_params(
        [{"role": "tool", "content": "", "options": {
            "tool_result": {"id": "call_1", "result": "sunny"}
        }}],
        model="gpt-4o",
    )
    msg = p["messages"][0]
    assert msg["role"] == "tool"
    assert msg["toolCallId"] == "call_1"
    assert msg["content"][0]["text"] == "sunny"


@pytest.mark.asyncio
async def test_tool_call_from_options():
    p = await prepare_params(
        [{"role": "assistant", "content": "", "options": {
            "tool_call": [{"id": "call_1", "name": "weather", "input": {"city": "London"}}]
        }}],
        model="gpt-4o",
    )
    blocks = p["messages"][0]["content"]
    tc = next(b for b in blocks if b.get("type") == "tool_call")
    assert tc["name"] == "weather"
    assert tc["args"] == {"city": "London"}


@pytest.mark.asyncio
async def test_tool_call_input_string_parsed_as_json():
    p = await prepare_params(
        [{"role": "assistant", "content": "", "options": {
            "tool_call": [{"id": "c1", "name": "fn", "input": '{"key":"val"}'}]
        }}],
        model="gpt-4o",
    )
    tc = p["messages"][0]["content"][0]
    assert tc["args"] == {"key": "val"}


# ─── multi-modal content ──────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_image_url_content():
    p = await prepare_params(
        [{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": "https://example.com/img.jpg"}}
        ]}],
        model="gpt-4o",
    )
    block = p["messages"][0]["content"][0]
    assert block["type"] == "binary"
    assert block["kind"] == "image"


@pytest.mark.asyncio
async def test_file_content():
    p = await prepare_params(
        [{"role": "user", "content": [
            {"type": "file", "data": "base64data==", "mime_type": "application/pdf"}
        ]}],
        model="gpt-4o",
    )
    block = p["messages"][0]["content"][0]
    assert block["type"] == "binary"
    assert block["kind"] == "document"
    assert block["mediaType"] == "application/pdf"


# ─── optional params ──────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_optional_params():
    p = await prepare_params(
        [], model="gpt-4o", temperature=0.5, top_p=0.9, max_tokens=100
    )
    assert p["temperature"] == 0.5
    assert p["top_p"] == 0.9
    assert p["max_tokens"] == 100


@pytest.mark.asyncio
async def test_model_set_correctly():
    p = await prepare_params([], model="llama-3.1-8b")
    assert p["model"] == "llama-3.1-8b"
