"""Tests for the OpenAI Agents SDK adapter."""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

import pytest

from betterdb_agent_cache.adapters.openai_agents import (
    CachedModel,
    CachedModelProvider,
    prepare_params,
)
from betterdb_agent_cache.agent_cache import AgentCache
from betterdb_agent_cache.types import AgentCacheOptions, TierDefaults

from ..conftest import make_persisting_valkey_client

pytest.importorskip("agents")


def _make_cache() -> AgentCache:
    client = make_persisting_valkey_client()
    with patch("betterdb_agent_cache.agent_cache.create_analytics"):
        return AgentCache(
            AgentCacheOptions(
                client=client,
                tier_defaults={"llm": TierDefaults(ttl=300)},
            ),
        )


class _FakeModel:
    """Minimal mock of agents.models.interface.Model."""
    model = "fake-model"

    def __init__(self, response: object, *, raise_error: Exception | None = None) -> None:
        self.response = response
        self.raise_error = raise_error
        self.calls = 0

    async def get_response(
        self,
        system_instructions,
        input,
        model_settings,
        tools,
        output_schema,
        handoffs,
        tracing,
        *,
        previous_response_id=None,
        **kwargs,
    ):
        self.calls += 1
        if self.raise_error is not None:
            raise self.raise_error
        return self.response

    def stream_response(self, *args, **kwargs):
        raise NotImplementedError("stream not mocked")

    async def close(self):
        pass


class _FakeProvider:
    def __init__(self, model: _FakeModel):
        self._model = model

    def get_model(self, model_name: str | None) -> _FakeModel:
        return self._model

    async def aclose(self):
        pass


def _make_text_response(text: str) -> SimpleNamespace:
    return SimpleNamespace(
        output=[
            SimpleNamespace(
                type="message",
                role="assistant",
                content=[
                    SimpleNamespace(type="output_text", text=text),
                ],
            ),
        ],
        usage=SimpleNamespace(input_tokens=10, output_tokens=5),
        referenceable_id=None,
        request_id=None,
    )


def _make_tool_response(call_id: str, name: str, args: str) -> SimpleNamespace:
    return SimpleNamespace(
        output=[
            SimpleNamespace(
                type="function_call",
                call_id=call_id,
                name=name,
                arguments=args,
            ),
        ],
        usage=SimpleNamespace(input_tokens=8, output_tokens=12),
        referenceable_id=None,
        request_id=None,
    )


_DEFAULT_KWARGS = dict(
    tools=[],
    output_schema=None,
    handoffs=[],
    tracing=None,
    previous_response_id=None,
    conversation_id=None,
    prompt=None,
)


@pytest.mark.asyncio
async def test_prepare_params_string_input():
    params = await prepare_params("Be concise.", "hello", "gpt-4o")
    assert params["model"] == "gpt-4o"
    assert params["messages"][0] == {"role": "system", "content": "Be concise."}
    assert params["messages"][1]["role"] == "user"


@pytest.mark.asyncio
async def test_prepare_params_list_input():
    items = [
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}]},
    ]
    params = await prepare_params(None, items, "gpt-4o-mini")
    assert params["model"] == "gpt-4o-mini"
    assert len(params["messages"]) == 1


@pytest.mark.asyncio
async def test_prepare_params_settings():
    settings = SimpleNamespace(
        temperature=0.5,
        top_p=0.9,
        max_tokens=100,
        seed=42,
        stop=None,
        tool_choice=None,
        max_output_tokens=None,
    )
    settings.model_dump = lambda exclude_none=False: {
        "temperature": 0.5,
        "top_p": 0.9,
        "max_tokens": 100,
        "seed": 42,
    }
    params = await prepare_params(None, "test", "gpt-4o", settings)
    assert params["temperature"] == 0.5
    assert params["top_p"] == 0.9
    assert params["max_tokens"] == 100
    assert params["seed"] == 42


@pytest.mark.asyncio
async def test_cached_model_getattr_delegation():
    base = _FakeModel(_make_text_response("ok"))
    wrapped = CachedModel(base, _make_cache())
    assert wrapped.model == "fake-model"


@pytest.mark.asyncio
async def test_cached_model_miss_stores_tool_calls():
    cache = _make_cache()
    response = _make_tool_response("call_fn", "get_weather", '{"city":"Berlin"}')
    base = _FakeModel(response)
    wrapped = CachedModel(base, cache)

    await wrapped.get_response(None, "weather?", None, **_DEFAULT_KWARGS)

    params = await prepare_params(None, "weather?", "fake-model")
    cached = await cache.llm.check(params)
    assert cached.hit is True
    assert cached.content_blocks[0]["type"] == "tool_call"
    assert cached.content_blocks[0]["name"] == "get_weather"
    assert cached.content_blocks[0]["args"] == {"city": "Berlin"}


@pytest.mark.asyncio
async def test_cached_model_miss_stores():
    cache = _make_cache()
    response = _make_text_response("miss response")
    base = _FakeModel(response)
    wrapped = CachedModel(base, cache)

    out = await wrapped.get_response(
        "Be concise.",
        "hello",
        None,
        **_DEFAULT_KWARGS,
    )
    assert out is response
    assert base.calls == 1

    params = await prepare_params("Be concise.", "hello", "fake-model")
    cached = await cache.llm.check(params)
    assert cached.hit is True
    assert cached.content_blocks[0]["text"] == "miss response"


@pytest.mark.asyncio
async def test_cached_model_hit_skips_underlying():
    cache = _make_cache()
    params = await prepare_params(None, "cached prompt", "fake-model")
    await cache.llm.store_multipart(
        params,
        [
            {"type": "text", "text": "from cache"},
            {"type": "tool_call", "id": "call_1", "name": "lookup", "args": {"q": "x"}},
        ],
    )

    base = _FakeModel(_make_text_response("should not be called"))
    wrapped = CachedModel(base, cache)
    out = await wrapped.get_response(
        None,
        "cached prompt",
        None,
        **_DEFAULT_KWARGS,
    )
    assert base.calls == 0
    assert hasattr(out, "output")


@pytest.mark.asyncio
async def test_cached_model_different_prompts():
    cache = _make_cache()
    base = _FakeModel(_make_text_response("live"))
    wrapped = CachedModel(base, cache)

    await wrapped.get_response("sys", "first", None, **_DEFAULT_KWARGS)
    await wrapped.get_response("sys", "first", None, **_DEFAULT_KWARGS)  # hit
    await wrapped.get_response("sys", "second", None, **_DEFAULT_KWARGS)  # miss
    assert base.calls == 2


@pytest.mark.asyncio
async def test_cached_model_propagates_errors():
    cache = _make_cache()
    base = _FakeModel(_make_text_response(""), raise_error=RuntimeError("boom"))
    wrapped = CachedModel(base, cache)
    with pytest.raises(RuntimeError, match="boom"):
        await wrapped.get_response(None, "hello", None, **_DEFAULT_KWARGS)


@pytest.mark.asyncio
async def test_stream_response_delegates_directly():
    """stream_response is not cached — it must delegate without interception."""
    base = _FakeModel(_make_text_response("ok"))
    wrapped = CachedModel(base, _make_cache())
    with pytest.raises(NotImplementedError, match="stream not mocked"):
        wrapped.stream_response(
            None,
            "hello",
            None,
            [],
            None,
            [],
            None,
            previous_response_id=None,
            conversation_id=None,
            prompt=None,
        )


@pytest.mark.asyncio
async def test_cached_provider_wraps_models():
    cache = _make_cache()
    base_model = _FakeModel(_make_text_response("provided"))
    provider = CachedModelProvider(_FakeProvider(base_model), cache)
    wrapped = provider.get_model("gpt-4o")
    assert isinstance(wrapped, CachedModel)
    out = await wrapped.get_response(None, "test", None, **_DEFAULT_KWARGS)
    assert base_model.calls == 1
    assert out is base_model.response
