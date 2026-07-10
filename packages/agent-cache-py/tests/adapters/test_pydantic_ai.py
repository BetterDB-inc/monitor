"""Tests for the Pydantic AI adapter."""
from __future__ import annotations

from unittest.mock import patch

import pytest

from betterdb_agent_cache.adapters.pydantic_ai import (
    CachedModel,
    PydanticAIPrepareOptions,
    prepare_params,
)
from betterdb_agent_cache.agent_cache import AgentCache
from betterdb_agent_cache.types import AgentCacheOptions, TierDefaults

from ..conftest import make_persisting_valkey_client

messages_mod = pytest.importorskip("pydantic_ai.messages")
usage_mod = pytest.importorskip("pydantic_ai.usage")
models_mod = pytest.importorskip("pydantic_ai.models")


def _make_cache() -> AgentCache:
    client = make_persisting_valkey_client()
    with patch("betterdb_agent_cache.agent_cache.create_analytics"):
        return AgentCache(AgentCacheOptions(
            client=client,
            tier_defaults={"llm": TierDefaults(ttl=300)},
        ))


@pytest.mark.asyncio
async def test_prepare_params_maps_request_and_response_parts():
    msgs = [
        messages_mod.ModelRequest(parts=[
            messages_mod.SystemPromptPart("You are concise"),
            messages_mod.InstructionPart("Always answer in one sentence"),
            messages_mod.UserPromptPart("hello"),
        ]),
        messages_mod.ModelResponse(parts=[
            messages_mod.TextPart("Hi there"),
            messages_mod.ThinkingPart("internal"),
            messages_mod.ToolCallPart(tool_name="get_weather", args='{"city":"London"}', tool_call_id="call_1"),
        ]),
        messages_mod.ModelRequest(parts=[
            messages_mod.ToolReturnPart(tool_name="get_weather", tool_call_id="call_1", content="sunny"),
            messages_mod.RetryPromptPart(content="bad arg", tool_name="get_weather", tool_call_id="call_2"),
        ]),
    ]
    params = await prepare_params(
        msgs,
        model_name="gpt-4o-mini",
        model_settings={"temperature": 0.7, "top_p": 0.9, "max_tokens": 111},
    )

    assert params["model"] == "gpt-4o-mini"
    assert params["temperature"] == 0.7
    assert params["top_p"] == 0.9
    assert params["max_tokens"] == 111

    out = params["messages"]
    assert out[0] == {"role": "system", "content": "You are concise"}
    assert out[1] == {"role": "system", "content": "Always answer in one sentence"}
    assert out[2] == {"role": "user", "content": [{"type": "text", "text": "hello"}]}
    assert out[3]["role"] == "assistant"
    assert out[3]["content"] == [
        {"type": "text", "text": "Hi there"},
        {"type": "tool_call", "id": "call_1", "name": "get_weather", "args": {"city": "London"}},
    ]
    assert out[4] == {
        "role": "tool",
        "toolCallId": "call_1",
        "content": [{"type": "text", "text": "sunny"}],
    }
    assert out[5]["role"] == "tool"
    assert out[5]["toolCallId"] == "call_2"
    assert out[5]["isError"] is True
    assert out[5]["content"] == [{"type": "text", "text": "bad arg"}]
    assert "internal" not in str(params["messages"])


@pytest.mark.asyncio
async def test_user_content_binary_dispatched_through_normalizer():
    """ImageUrl / BinaryContent must be routed through the normalizer,
    not JSON-serialised into the cache key.
    """
    from pydantic_ai.messages import BinaryContent, ImageUrl

    calls: list[dict] = []

    async def _spy_normalizer(ref):
        calls.append(ref)
        return "sha256:fake"

    msgs = [
        messages_mod.ModelRequest(parts=[
            messages_mod.UserPromptPart([
                "look at this",
                ImageUrl(url="https://example.com/cat.png"),
                BinaryContent(data=b"fake-bytes", media_type="image/png"),
            ]),
        ]),
    ]
    opts = PydanticAIPrepareOptions(normalizer=_spy_normalizer)
    params = await prepare_params(msgs, "gpt-4o", opts=opts)

    user_content = params["messages"][0]["content"]
    assert user_content[0] == {"type": "text", "text": "look at this"}
    assert user_content[1] == {
        "type": "binary", "kind": "image",
        "mediaType": "image/*", "ref": "sha256:fake",
    }
    assert user_content[2] == {
        "type": "binary", "kind": "image",
        "mediaType": "image/png", "ref": "sha256:fake",
    }

    # Spy asserts the normalizer was actually reached for both binary items.
    assert len(calls) == 2
    assert calls[0]["kind"] == "image"
    assert calls[0]["source"] == {"type": "url", "url": "https://example.com/cat.png"}
    assert calls[1]["kind"] == "image"
    assert calls[1]["source"] == {"type": "bytes", "data": b"fake-bytes"}


@pytest.mark.asyncio
async def test_prepare_params_multi_turn_round_trip():
    msgs = [
        messages_mod.ModelRequest(parts=[messages_mod.UserPromptPart("Q1")]),
        messages_mod.ModelResponse(parts=[messages_mod.TextPart("A1")]),
        messages_mod.ModelRequest(parts=[messages_mod.UserPromptPart("Q2")]),
        messages_mod.ModelResponse(parts=[messages_mod.TextPart("A2")]),
    ]
    params = await prepare_params(msgs, model_name="test-model")
    assert params["messages"] == [
        {"role": "user", "content": [{"type": "text", "text": "Q1"}]},
        {"role": "assistant", "content": [{"type": "text", "text": "A1"}]},
        {"role": "user", "content": [{"type": "text", "text": "Q2"}]},
        {"role": "assistant", "content": [{"type": "text", "text": "A2"}]},
    ]


class _FakeModel:
    model_name = "fake-model"

    def __init__(self, response: object, *, raise_error: Exception | None = None) -> None:
        self.response = response
        self.raise_error = raise_error
        self.calls = 0

    async def request(self, messages, model_settings, model_request_parameters):
        self.calls += 1
        if self.raise_error is not None:
            raise self.raise_error
        return self.response


@pytest.mark.asyncio
async def test_cached_model_getattr_delegation():
    base = _FakeModel(messages_mod.ModelResponse(parts=[messages_mod.TextPart("ok")]))
    wrapped = CachedModel(base, _make_cache())
    assert wrapped.model_name == "fake-model"


@pytest.mark.asyncio
async def test_cached_model_miss_calls_underlying_and_stores():
    cache = _make_cache()
    response = messages_mod.ModelResponse(
        parts=[messages_mod.TextPart("miss response")],
        usage=usage_mod.RequestUsage(input_tokens=5, output_tokens=7),
        model_name="fake-model",
    )
    base = _FakeModel(response)
    wrapped = CachedModel(base, cache)

    req_messages = [messages_mod.ModelRequest(parts=[messages_mod.UserPromptPart("hello")])]
    out = await wrapped.request(req_messages, None, None)
    assert out is response
    assert base.calls == 1

    params = await prepare_params(req_messages, "fake-model")
    cached = await cache.llm.check(params)
    assert cached.hit is True
    assert cached.content_blocks is not None
    assert cached.content_blocks[0]["type"] == "text"
    assert cached.content_blocks[0]["text"] == "miss response"


@pytest.mark.asyncio
async def test_cached_model_hit_skips_underlying_and_synthesizes_response():
    cache = _make_cache()
    req_messages = [messages_mod.ModelRequest(parts=[messages_mod.UserPromptPart("cached prompt")])]
    params = await prepare_params(req_messages, "fake-model")
    await cache.llm.store_multipart(
        params,
        [
            {"type": "text", "text": "from cache"},
            {"type": "tool_call", "id": "call_1", "name": "lookup", "args": {"q": "x"}},
        ],
    )

    base = _FakeModel(messages_mod.ModelResponse(parts=[messages_mod.TextPart("base")]))
    wrapped = CachedModel(base, cache)
    out = await wrapped.request(req_messages, None, None)

    assert base.calls == 0
    assert isinstance(out, messages_mod.ModelResponse)
    assert isinstance(out.parts[0], messages_mod.TextPart)
    assert out.parts[0].content == "from cache"
    assert isinstance(out.parts[1], messages_mod.ToolCallPart)
    assert out.parts[1].tool_name == "lookup"
    assert out.usage.input_tokens == 0
    assert out.usage.output_tokens == 0


@pytest.mark.asyncio
async def test_cached_model_hit_propagates_stored_tokens():
    """Cache hit returns RequestUsage with the token counts from the original miss."""
    cache = _make_cache()
    response = messages_mod.ModelResponse(
        parts=[messages_mod.TextPart("with tokens")],
        usage=usage_mod.RequestUsage(input_tokens=11, output_tokens=13),
        model_name="fake-model",
    )
    base = _FakeModel(response)
    wrapped = CachedModel(base, cache)
    req_messages = [messages_mod.ModelRequest(parts=[messages_mod.UserPromptPart("q")])]

    # Miss — stores with real token counts (11 / 13 from the fixture usage).
    await wrapped.request(req_messages, None, None)
    assert base.calls == 1

    # Hit — should surface those stored counts, not zeros.
    out = await wrapped.request(req_messages, None, None)
    assert base.calls == 1                          # underlying model not re-called
    assert out.usage.input_tokens == 11
    assert out.usage.output_tokens == 13


@pytest.mark.asyncio
async def test_cached_model_hit_then_miss_for_different_messages():
    cache = _make_cache()
    base = _FakeModel(messages_mod.ModelResponse(parts=[messages_mod.TextPart("live")]))
    wrapped = CachedModel(base, cache)

    first = [messages_mod.ModelRequest(parts=[messages_mod.UserPromptPart("same")])]
    second = [messages_mod.ModelRequest(parts=[messages_mod.UserPromptPart("different")])]

    await wrapped.request(first, None, models_mod.ModelRequestParameters())
    await wrapped.request(first, None, models_mod.ModelRequestParameters())
    await wrapped.request(second, None, models_mod.ModelRequestParameters())

    assert base.calls == 2


@pytest.mark.asyncio
async def test_cached_model_propagates_underlying_errors():
    cache = _make_cache()
    err = RuntimeError("boom")
    base = _FakeModel(messages_mod.ModelResponse(parts=[]), raise_error=err)
    wrapped = CachedModel(base, cache)
    req_messages = [messages_mod.ModelRequest(parts=[messages_mod.UserPromptPart("hello")])]

    with pytest.raises(RuntimeError, match="boom"):
        await wrapped.request(req_messages, None, None)
