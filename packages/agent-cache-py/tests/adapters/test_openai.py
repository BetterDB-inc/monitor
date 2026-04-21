"""Tests for the OpenAI Chat adapter."""
from __future__ import annotations

import pytest
from betterdb_agent_cache.adapters.openai import prepare_params


def _params(**extra):
    return {"model": "gpt-4o", "messages": [], **extra}


# ─── basic message roles ──────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_system_message_string():
    p = await prepare_params({
        "model": "gpt-4o",
        "messages": [{"role": "system", "content": "You are helpful"}],
    })
    assert p["messages"][0] == {"role": "system", "content": "You are helpful"}


@pytest.mark.asyncio
async def test_developer_role_mapped_to_system():
    p = await prepare_params({
        "model": "gpt-4o",
        "messages": [{"role": "developer", "content": "Be concise"}],
    })
    assert p["messages"][0]["role"] == "system"


@pytest.mark.asyncio
async def test_user_message_string():
    p = await prepare_params({
        "model": "gpt-4o",
        "messages": [{"role": "user", "content": "hello"}],
    })
    assert p["messages"][0] == {"role": "user", "content": [{"type": "text", "text": "hello"}]}


@pytest.mark.asyncio
async def test_assistant_message():
    p = await prepare_params({
        "model": "gpt-4o",
        "messages": [{"role": "assistant", "content": "I can help"}],
    })
    assert p["messages"][0]["role"] == "assistant"
    assert p["messages"][0]["content"] == [{"type": "text", "text": "I can help"}]


@pytest.mark.asyncio
async def test_tool_message():
    p = await prepare_params({
        "model": "gpt-4o",
        "messages": [{"role": "tool", "tool_call_id": "call_1", "content": "sunny"}],
    })
    assert p["messages"][0] == {
        "role": "tool",
        "tool_call_id": "call_1",
        "content": [{"type": "text", "text": "sunny"}],
    }


@pytest.mark.asyncio
async def test_function_role_mapped_to_tool():
    p = await prepare_params({
        "model": "gpt-4o",
        "messages": [{"role": "function", "name": "weather", "content": "sunny"}],
    })
    msg = p["messages"][0]
    assert msg["role"] == "tool"
    assert msg["tool_call_id"] == "legacy:weather"


# ─── tool calls ───────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_assistant_tool_calls():
    p = await prepare_params({
        "model": "gpt-4o",
        "messages": [{
            "role": "assistant",
            "content": None,
            "tool_calls": [{
                "id": "call_1",
                "type": "function",
                "function": {"name": "get_weather", "arguments": '{"city":"London"}'},
            }],
        }],
    })
    blocks = p["messages"][0]["content"]
    assert len(blocks) == 1
    assert blocks[0]["type"] == "tool_call"
    assert blocks[0]["id"] == "call_1"
    assert blocks[0]["name"] == "get_weather"
    assert blocks[0]["args"] == {"city": "London"}


# ─── multi-modal content ──────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_user_image_url():
    p = await prepare_params({
        "model": "gpt-4o",
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": "What's in this image?"},
                {"type": "image_url", "image_url": {"url": "https://example.com/img.jpg"}},
            ],
        }],
    })
    content = p["messages"][0]["content"]
    assert content[0] == {"type": "text", "text": "What's in this image?"}
    assert content[1]["type"] == "binary"
    assert content[1]["kind"] == "image"
    assert content[1]["ref"].startswith("url:")


@pytest.mark.asyncio
async def test_user_base64_image():
    b64 = "data:image/jpeg;base64,/9j/abc"
    p = await prepare_params({
        "model": "gpt-4o",
        "messages": [{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": b64}},
        ]}],
    })
    block = p["messages"][0]["content"][0]
    assert block["type"] == "binary"
    assert block["media_type"] == "image/jpeg"
    assert block["ref"].startswith("base64:")


@pytest.mark.asyncio
async def test_user_image_with_detail():
    p = await prepare_params({
        "model": "gpt-4o",
        "messages": [{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": "https://example.com/img.jpg", "detail": "high"}},
        ]}],
    })
    block = p["messages"][0]["content"][0]
    assert block.get("detail") == "high"


# ─── optional params ──────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_optional_params_included():
    p = await prepare_params({
        "model": "gpt-4o",
        "messages": [],
        "temperature": 0.7,
        "top_p": 0.9,
        "max_tokens": 256,
        "seed": 42,
        "stop": "STOP",
        "response_format": {"type": "json_object"},
    })
    assert p["temperature"] == 0.7
    assert p["top_p"] == 0.9
    assert p["max_tokens"] == 256
    assert p["seed"] == 42
    assert p["stop"] == ["STOP"]  # string normalised to list
    assert p["response_format"] == {"type": "json_object"}


@pytest.mark.asyncio
async def test_stop_list_preserved():
    p = await prepare_params({"model": "gpt-4o", "messages": [], "stop": ["END", "DONE"]})
    assert p["stop"] == ["END", "DONE"]


@pytest.mark.asyncio
async def test_absent_optional_params_not_included():
    p = await prepare_params({"model": "gpt-4o", "messages": []})
    assert "temperature" not in p
    assert "max_tokens" not in p


# ─── hash stability ───────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_same_params_produce_same_hash():
    from betterdb_agent_cache.utils import llm_cache_hash

    params = {
        "model": "gpt-4o",
        "messages": [{"role": "user", "content": "hello"}],
    }
    p1 = await prepare_params(params)
    p2 = await prepare_params(params)
    assert llm_cache_hash(p1) == llm_cache_hash(p2)
