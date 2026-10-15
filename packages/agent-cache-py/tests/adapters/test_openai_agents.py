"""Tests for the OpenAI Agents SDK adapter."""
from __future__ import annotations

import asyncio
import json
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
    if not hasattr(response, "status"):
        response.status = "completed"
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


class _RecordingStreamModel(_StreamingFakeModel):
    """Records the args the real Runner passes, then fails (it must not be reached on a hit)."""

    def __init__(self) -> None:
        super().__init__(events=[])
        self.recorded: tuple | None = None

    def get_retry_advice(self, request):
        # Same default as agents.models.interface.Model; the Runner calls it.
        return None

    async def stream_response(self, system_instructions, input, model_settings, *args, **kwargs):
        self.stream_calls += 1
        self.recorded = (system_instructions, input, model_settings)
        raise RuntimeError("underlying model must not be called on a hit")
        yield  # pragma: no cover - makes this an async generator


@pytest.mark.asyncio
async def test_stream_hit_drives_real_runner():
    """The synthesized replay must satisfy the real ``Runner.run_streamed``, not just fakes."""
    from agents import Agent, RunConfig, Runner
    from openai.types.responses import ResponseCompletedEvent
    from openai.types.responses.response_usage import ResponseUsage

    cache = _make_cache()

    def run_config(model):
        # The recommended integration: CachedModelProvider via RunConfig.
        provider = CachedModelProvider(_FakeProvider(model), cache)
        return RunConfig(model_provider=provider, tracing_disabled=True)

    # 1. Capture the exact args the Runner passes to the model for this prompt.
    probe = _RecordingStreamModel()
    probe_run = Runner.run_streamed(
        Agent(name="A", model="fake-model"), "cached prompt", run_config=run_config(probe),
    )
    with pytest.raises(RuntimeError, match="must not be called"):
        async for _ in probe_run.stream_events():
            pass
    assert probe.recorded is not None
    system_instructions, runner_input, model_settings = probe.recorded

    # 2. Store an answer under the params those args produce.
    params = await prepare_params(system_instructions, runner_input, "fake-model", model_settings)
    await cache.llm.store_multipart(params, [{"type": "text", "text": "from cache"}])

    # 3. A fresh run is a hit: the Runner accepts the replay and the model is never called.
    base = _RecordingStreamModel()
    result = Runner.run_streamed(
        Agent(name="A", model="fake-model"), "cached prompt", run_config=run_config(base),
    )
    raw = [e.data async for e in result.stream_events() if getattr(e, "type", None) == "raw_response_event"]

    assert result.final_output == "from cache"
    assert base.stream_calls == 0
    completed = [e for e in raw if isinstance(e, ResponseCompletedEvent)]
    assert len(completed) == 1
    # Validated path, not the construct() fallback: only the validated path builds
    # a Responses ``ResponseUsage`` (the fallback carries an ``agents.Usage``).
    assert isinstance(completed[0].response.usage, ResponseUsage)
    assert completed[0].response.model == "fake-model"


@pytest.mark.asyncio
async def test_stream_incomplete_is_not_stored():
    cache = _make_cache()
    truncated = _make_text_response("truncated answ")
    truncated.status = "incomplete"
    events = [
        _text_delta_event("truncated answ"),
        SimpleNamespace(type="response.incomplete", response=truncated),
    ]
    base = _StreamingFakeModel(events)
    wrapped = CachedModel(base, cache)

    received = await _drain(wrapped.stream_response(None, "prompt", None, **_DEFAULT_KWARGS))

    assert received == events
    params = await prepare_params(None, "prompt", "fake-model")
    assert (await cache.llm.check(params)).hit is False


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "item_type", ["file_search_call", "web_search_call", "computer_call", "mcp_call"],
)
async def test_stream_non_function_tool_items_are_not_stored(item_type):
    cache = _make_cache()
    response = SimpleNamespace(
        output=[SimpleNamespace(type=item_type, id="item_1")],
        usage=SimpleNamespace(input_tokens=3, output_tokens=4),
    )
    base = _StreamingFakeModel([_completed_event(response)])
    wrapped = CachedModel(base, cache)

    await _drain(wrapped.stream_response(None, "prompt", None, **_DEFAULT_KWARGS))

    params = await prepare_params(None, "prompt", "fake-model")
    assert (await cache.llm.check(params)).hit is False


@pytest.mark.asyncio
async def test_stream_consumer_break_does_not_store():
    cache = _make_cache()
    events = [_text_delta_event("full answer"), _completed_event(_make_text_response("full answer"))]
    base = _StreamingFakeModel(events)
    wrapped = CachedModel(base, cache)

    agen = wrapped.stream_response(None, "prompt", None, **_DEFAULT_KWARGS)
    async for event in agen:
        if event.type == "response.completed":
            break
    await agen.aclose()

    params = await prepare_params(None, "prompt", "fake-model")
    assert (await cache.llm.check(params)).hit is False


class _SlowStreamingFakeModel(_StreamingFakeModel):
    """Sleeps between events so the consuming task can be cancelled mid-stream."""

    async def stream_response(self, *args, **kwargs):
        self.stream_calls += 1
        for event in self.events:
            yield event
            await asyncio.sleep(10)


@pytest.mark.asyncio
async def test_stream_cancelled_does_not_store():
    cache = _make_cache()
    events = [_text_delta_event("partial"), _completed_event(_make_text_response("partial"))]
    base = _SlowStreamingFakeModel(events)
    wrapped = CachedModel(base, cache)
    first_event = asyncio.Event()

    async def consume():
        async for _ in wrapped.stream_response(None, "prompt", None, **_DEFAULT_KWARGS):
            first_event.set()

    task = asyncio.create_task(consume())
    await first_event.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    params = await prepare_params(None, "prompt", "fake-model")
    assert (await cache.llm.check(params)).hit is False


@pytest.mark.asyncio
async def test_stream_hit_replays_nonstream_tool_call():
    """get_response() may store tool calls (#149); a stream hit must replay them intact."""
    cache = _make_cache()
    nonstream = _FakeModel(_make_tool_response("call_9", "get_weather", '{"city":"Berlin"}'))
    await CachedModel(nonstream, cache).get_response(None, "weather?", None, **_DEFAULT_KWARGS)
    assert nonstream.calls == 1

    base = _StreamingFakeModel(events=[])
    received = await _drain(
        CachedModel(base, cache).stream_response(None, "weather?", None, **_DEFAULT_KWARGS),
    )

    assert base.stream_calls == 0
    assert received[-1].type == "response.completed"
    calls = [i for i in received[-1].response.output if getattr(i, "type", None) == "function_call"]
    assert len(calls) == 1
    assert calls[0].call_id == "call_9"
    assert calls[0].name == "get_weather"
    assert json.loads(calls[0].arguments) == {"city": "Berlin"}


def test_direct_wrapping_is_accepted_by_agent():
    """The README's ``Agent(model=CachedModel(...))`` example must not raise."""
    from agents import Agent
    from agents.models.interface import Model

    cache = _make_cache()
    base = _StreamingFakeModel(events=[])

    Agent(name="A", model=CachedModel(base, cache))
    assert isinstance(CachedModel(base, cache), Model)


@pytest.mark.asyncio
async def test_stream_hit_drives_real_runner_direct_wrapping():
    """Same as the real-Runner hit test, but with ``Agent(model=CachedModel(...))``."""
    from agents import Agent, RunConfig, Runner
    from openai.types.responses import ResponseCompletedEvent
    from openai.types.responses.response_usage import ResponseUsage

    cache = _make_cache()
    run_config = RunConfig(tracing_disabled=True)

    # 1. Capture the exact args the Runner passes to the model for this prompt.
    probe = _RecordingStreamModel()
    probe_run = Runner.run_streamed(
        Agent(name="A", model=CachedModel(probe, cache)), "cached prompt", run_config=run_config,
    )
    with pytest.raises(RuntimeError, match="must not be called"):
        async for _ in probe_run.stream_events():
            pass
    assert probe.recorded is not None
    system_instructions, runner_input, model_settings = probe.recorded

    # 2. Store an answer under the params those args produce.
    params = await prepare_params(system_instructions, runner_input, "fake-model", model_settings)
    await cache.llm.store_multipart(params, [{"type": "text", "text": "from cache"}])

    # 3. A fresh run is a hit: the Runner accepts the replay and the model is never called.
    base = _RecordingStreamModel()
    result = Runner.run_streamed(
        Agent(name="A", model=CachedModel(base, cache)), "cached prompt", run_config=run_config,
    )
    raw = [e.data async for e in result.stream_events() if getattr(e, "type", None) == "raw_response_event"]

    assert result.final_output == "from cache"
    assert base.stream_calls == 0
    completed = [e for e in raw if isinstance(e, ResponseCompletedEvent)]
    assert len(completed) == 1
    assert isinstance(completed[0].response.usage, ResponseUsage)
