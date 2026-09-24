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
from betterdb_agent_cache.errors import ValkeyCommandError
from betterdb_agent_cache.types import AgentCacheOptions, TierDefaults

from ..conftest import make_persisting_valkey_client

try:
    import agents  # noqa: F401
except Exception as exc:  # pragma: no cover - environment dependent
    pytest.skip(
        f"openai-agents unavailable or incompatible in this environment: {exc}",
        allow_module_level=True,
    )


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
    texts = [
        getattr(p, "text", None)
        for item in out.output
        for p in (getattr(item, "content", []) or [])
    ]
    assert "from cache" in texts
    tool_calls = [i for i in out.output if getattr(i, "type", None) == "function_call"]
    assert any(getattr(tc, "name", None) == "lookup" for tc in tool_calls)
    # Verify usage carries stored token counts from the miss (10 input, 5 output per _make_text_response)
    # Note: when stored via store_multipart with no LlmStoreOptions, tokens default to 0
    assert out.usage.input_tokens == 0
    assert out.usage.output_tokens == 0


@pytest.mark.asyncio
async def test_store_failure_is_fail_open():
    """A Valkey store failure must not crash the run — return the live response."""
    cache = _make_cache()

    async def _boom(*_a, **_k):
        raise ValkeyCommandError("SET", RuntimeError("valkey down"))

    cache.llm.store_multipart = _boom  # type: ignore[assignment]

    base = _FakeModel(_make_text_response("live result"))
    wrapped = CachedModel(base, cache)

    out = await wrapped.get_response(None, "hello", None, **_DEFAULT_KWARGS)
    assert out is base.response
    assert base.calls == 1


@pytest.mark.asyncio
async def test_cached_model_hit_propagates_stored_tokens():
    """Cache hit returns Usage with the token counts from the original miss."""
    cache = _make_cache()
    response = _make_text_response("response with tokens")
    # _make_text_response sets usage.input_tokens=10, output_tokens=5
    base = _FakeModel(response)
    wrapped = CachedModel(base, cache)

    # Miss: stores with real token counts (10 input, 5 output from _make_text_response)
    await wrapped.get_response(None, "prompt", None, **_DEFAULT_KWARGS)
    assert base.calls == 1

    # Hit: should return stored token counts
    out = await wrapped.get_response(None, "prompt", None, **_DEFAULT_KWARGS)
    assert base.calls == 1  # not called again
    assert out.usage.input_tokens == 10
    assert out.usage.output_tokens == 5


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
async def test_cached_provider_wraps_models():
    cache = _make_cache()
    base_model = _FakeModel(_make_text_response("provided"))
    provider = CachedModelProvider(_FakeProvider(base_model), cache)
    wrapped = provider.get_model("gpt-4o")
    assert isinstance(wrapped, CachedModel)
    out = await wrapped.get_response(None, "test", None, **_DEFAULT_KWARGS)
    assert base_model.calls == 1
    assert out is base_model.response


# ---------------------------------------------------------------------------
# Streaming
# ---------------------------------------------------------------------------


def _text_delta_event(text: str) -> SimpleNamespace:
    """Fake ``response.output_text.delta`` event."""
    return SimpleNamespace(
        type="response.output_text.delta",
        delta=text,
        output_index=0,
        content_index=0,
    )


def _completed_event(response: SimpleNamespace) -> SimpleNamespace:
    """Fake terminal ``response.completed`` event carrying a full Response."""
    return SimpleNamespace(type="response.completed", response=response)


class _StreamingFakeModel:
    """Minimal streaming mock — scripted event list + optional mid-iteration raise."""

    model = "fake-model"

    def __init__(
        self,
        events: list[object],
        *,
        raise_after: int | None = None,
    ) -> None:
        self.events = events
        self.raise_after = raise_after
        self.stream_calls = 0
        self.get_response_calls = 0

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
        self.get_response_calls += 1
        return _make_text_response("nonstream-result")

    async def stream_response(
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
        self.stream_calls += 1
        for i, event in enumerate(self.events):
            if self.raise_after is not None and i == self.raise_after:
                raise RuntimeError("upstream stream failed")
            yield event

    async def close(self):
        pass


async def _drain(agen):
    return [event async for event in agen]


@pytest.mark.asyncio
async def test_stream_miss_passes_through_and_stores():
    cache = _make_cache()
    text_response = _make_text_response("streamed result")
    events = [
        _text_delta_event("streamed "),
        _text_delta_event("result"),
        _completed_event(text_response),
    ]
    base = _StreamingFakeModel(events)
    wrapped = CachedModel(base, cache)

    received = await _drain(
        wrapped.stream_response(None, "prompt", None, **_DEFAULT_KWARGS),
    )

    assert received == events
    assert base.stream_calls == 1

    params = await prepare_params(None, "prompt", "fake-model")
    cached = await cache.llm.check(params)
    assert cached.hit is True
    assert cached.content_blocks[0]["type"] == "text"
    assert cached.content_blocks[0]["text"] == "streamed result"


@pytest.mark.asyncio
async def test_stream_hit_replays_without_calling_model():
    cache = _make_cache()
    params = await prepare_params(None, "cached prompt", "fake-model")
    await cache.llm.store_multipart(
        params,
        [{"type": "text", "text": "from cache"}],
    )

    base = _StreamingFakeModel(events=[])
    wrapped = CachedModel(base, cache)

    received = await _drain(
        wrapped.stream_response(None, "cached prompt", None, **_DEFAULT_KWARGS),
    )

    assert base.stream_calls == 0
    assert received[-1].type == "response.completed"
    output = received[-1].response.output
    texts = [
        getattr(p, "text", None)
        for item in output
        for p in (getattr(item, "content", []) or [])
    ]
    assert "from cache" in texts


@pytest.mark.asyncio
async def test_stream_hit_after_nonstream_store():
    """Cache-key parity between stream and non-stream paths."""
    cache = _make_cache()

    text_base = _FakeModel(_make_text_response("shared answer"))
    non_stream_wrapped = CachedModel(text_base, cache)
    await non_stream_wrapped.get_response(
        "sys", "shared prompt", None, **_DEFAULT_KWARGS,
    )
    assert text_base.calls == 1

    stream_base = _StreamingFakeModel(events=[])
    stream_wrapped = CachedModel(stream_base, cache)
    received = await _drain(
        stream_wrapped.stream_response(
            "sys", "shared prompt", None, **_DEFAULT_KWARGS,
        ),
    )
    assert stream_base.stream_calls == 0
    assert received[-1].type == "response.completed"


@pytest.mark.asyncio
async def test_stream_tool_calls_are_not_stored():
    """Mirrors @betterdb/agent-cache v0.11.0 wrapStream — no half-executed agent steps in cache."""
    cache = _make_cache()
    tool_response = _make_tool_response("call_1", "get_weather", '{"city":"Sofia"}')
    events = [_completed_event(tool_response)]
    base = _StreamingFakeModel(events)
    wrapped = CachedModel(base, cache)

    await _drain(
        wrapped.stream_response(None, "weather?", None, **_DEFAULT_KWARGS),
    )
    assert base.stream_calls == 1

    params = await prepare_params(None, "weather?", "fake-model")
    cached = await cache.llm.check(params)
    assert cached.hit is False


@pytest.mark.asyncio
async def test_stream_error_does_not_store():
    cache = _make_cache()
    text_response = _make_text_response("never finishes")
    events = [
        _text_delta_event("partial"),
        _completed_event(text_response),
    ]
    base = _StreamingFakeModel(events, raise_after=1)
    wrapped = CachedModel(base, cache)

    received: list[object] = []
    with pytest.raises(RuntimeError, match="upstream stream failed"):
        async for event in wrapped.stream_response(
            None, "prompt", None, **_DEFAULT_KWARGS,
        ):
            received.append(event)

    assert received == [events[0]]
    params = await prepare_params(None, "prompt", "fake-model")
    cached = await cache.llm.check(params)
    assert cached.hit is False


@pytest.mark.asyncio
async def test_stream_store_failure_is_fail_open():
    """A Valkey store failure must not surface to the caller mid- or post-stream."""
    cache = _make_cache()

    async def _boom(*_a, **_k):
        raise ValkeyCommandError("SET", RuntimeError("valkey down"))

    cache.llm.store_multipart = _boom  # type: ignore[assignment]

    text_response = _make_text_response("delivered fully")
    events = [
        _text_delta_event("delivered "),
        _text_delta_event("fully"),
        _completed_event(text_response),
    ]
    base = _StreamingFakeModel(events)
    wrapped = CachedModel(base, cache)

    received = await _drain(
        wrapped.stream_response(None, "prompt", None, **_DEFAULT_KWARGS),
    )
    assert received == events
