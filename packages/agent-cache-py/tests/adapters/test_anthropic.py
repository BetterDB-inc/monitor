"""Tests for the Anthropic Messages adapter."""
from __future__ import annotations

import pytest
from betterdb_agent_cache.adapters.anthropic import prepare_params


def _params(messages, **extra):
    return {"model": "claude-opus-4-6", "max_tokens": 1024, "messages": messages, **extra}


# ─── system ───────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_system_string():
    p = await prepare_params(_params([], system="Be helpful"))
    assert p["messages"][0] == {"role": "system", "content": "Be helpful"}


@pytest.mark.asyncio
async def test_system_block_list():
    p = await prepare_params(_params([], system=[{"type": "text", "text": "Be helpful"}]))
    sys_msg = p["messages"][0]
    assert sys_msg["role"] == "system"
    assert sys_msg["content"][0]["type"] == "text"


@pytest.mark.asyncio
async def test_system_block_with_cache_control():
    p = await prepare_params(_params([], system=[{
        "type": "text", "text": "prompt",
        "cache_control": {"type": "ephemeral"},
    }]))
    hints = p["messages"][0]["content"][0].get("hints")
    assert hints is not None
    assert hints["anthropic_cache_control"]["type"] == "ephemeral"


# ─── user messages ────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_user_string_content():
    p = await prepare_params(_params([{"role": "user", "content": "hello"}]))
    assert p["messages"][-1]["content"] == [{"type": "text", "text": "hello"}]


@pytest.mark.asyncio
async def test_user_text_block():
    p = await prepare_params(_params([{"role": "user", "content": [
        {"type": "text", "text": "describe this"}
    ]}]))
    assert p["messages"][-1]["content"][0] == {"type": "text", "text": "describe this"}


@pytest.mark.asyncio
async def test_user_image_base64():
    p = await prepare_params(_params([{"role": "user", "content": [
        {"type": "image", "source": {"type": "base64", "data": "abc123", "media_type": "image/png"}},
    ]}]))
    block = p["messages"][-1]["content"][0]
    assert block["type"] == "binary"
    assert block["kind"] == "image"
    assert block["media_type"] == "image/png"


@pytest.mark.asyncio
async def test_user_image_url():
    p = await prepare_params(_params([{"role": "user", "content": [
        {"type": "image", "source": {"type": "url", "url": "https://example.com/img.jpg"}},
    ]}]))
    block = p["messages"][-1]["content"][0]
    assert block["ref"].startswith("url:")


@pytest.mark.asyncio
async def test_tool_result_becomes_tool_role():
    p = await prepare_params(_params([{"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "toolu_1", "content": "sunny"},
    ]}]))
    msg = p["messages"][-1]
    assert msg["role"] == "tool"
    assert msg["tool_call_id"] == "toolu_1"
    assert msg["content"][0]["text"] == "sunny"


@pytest.mark.asyncio
async def test_tool_result_and_text_split():
    p = await prepare_params(_params([{"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "toolu_1", "content": "sunny"},
        {"type": "text", "text": "Thanks!"},
    ]}]))
    roles = [m["role"] for m in p["messages"]]
    assert "tool" in roles
    assert "user" in roles


# ─── assistant messages ───────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_assistant_string():
    p = await prepare_params(_params([{"role": "assistant", "content": "I will help"}]))
    assert p["messages"][-1]["content"] == [{"type": "text", "text": "I will help"}]


@pytest.mark.asyncio
async def test_assistant_tool_use():
    p = await prepare_params(_params([{"role": "assistant", "content": [
        {"type": "tool_use", "id": "toolu_1", "name": "get_weather", "input": {"city": "London"}},
    ]}]))
    block = p["messages"][-1]["content"][0]
    assert block["type"] == "tool_call"
    assert block["id"] == "toolu_1"
    assert block["args"] == {"city": "London"}


@pytest.mark.asyncio
async def test_thinking_block():
    p = await prepare_params(_params([{"role": "assistant", "content": [
        {"type": "thinking", "thinking": "Let me reason...", "signature": "sig123"},
    ]}]))
    block = p["messages"][-1]["content"][0]
    assert block["type"] == "reasoning"
    assert block["text"] == "Let me reason..."
    assert block["opaque_signature"] == "sig123"


@pytest.mark.asyncio
async def test_redacted_thinking():
    p = await prepare_params(_params([{"role": "assistant", "content": [
        {"type": "redacted_thinking", "data": "opaque_data"},
    ]}]))
    block = p["messages"][-1]["content"][0]
    assert block["type"] == "reasoning"
    assert block.get("redacted") is True


# ─── document sources ─────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_document_text_source():
    p = await prepare_params(_params([{"role": "user", "content": [
        {"type": "document", "source": {"type": "text", "text": "Hello world"}},
    ]}]))
    block = p["messages"][-1]["content"][0]
    assert block["type"] == "binary"
    assert block["kind"] == "document"
    assert block["media_type"] == "text/plain"


@pytest.mark.asyncio
async def test_document_nested_content():
    p = await prepare_params(_params([{"role": "user", "content": [
        {"type": "document", "source": {"type": "content", "content": [{"type": "text", "text": "hi"}]}},
    ]}]))
    block = p["messages"][-1]["content"][0]
    assert block["ref"].startswith("nested:sha256:")


# ─── optional params ──────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_optional_params():
    p = await prepare_params({
        "model": "claude-opus-4-6",
        "max_tokens": 512,
        "messages": [],
        "temperature": 1.0,
        "top_p": 0.95,
        "stop_sequences": ["END"],
    })
    assert p["temperature"] == 1.0
    assert p["top_p"] == 0.95
    assert p["stop"] == ["END"]
