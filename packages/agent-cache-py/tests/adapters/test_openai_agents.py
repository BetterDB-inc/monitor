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
    _build_response_usage,  # private, test-only
    prepare_params,
)
from betterdb_agent_cache.agent_cache import AgentCache
from betterdb_agent_cache.errors import ValkeyCommandError
from betterdb_agent_cache.types import AgentCacheOptions, LlmStoreOptions, TierDefaults

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

    # 1. Capture the params the Runner produces for this prompt, then store an answer under them.
    params = await _probe_runner_params(cache, "cached prompt")
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

    # 1. Capture the params the Runner produces for this prompt, then store an answer under them.
    params = await _probe_runner_params(cache, "cached prompt")
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


# ---------------------------------------------------------------------------
# Review follow-ups: shared helpers
# ---------------------------------------------------------------------------


class _CloseTrackingModel(_StreamingFakeModel):
    """Records whether the upstream generator was closed. Keeps strong references to
    every generator it hands out so GC can never close them on our behalf."""

    def __init__(self, events, *, delay: float = 0.0) -> None:
        super().__init__(events)
        self.delay = delay
        self.closed = False
        self._gens: list[object] = []

    def stream_response(self, *args, **kwargs):
        self.stream_calls += 1
        gen = self._gen()
        self._gens.append(gen)
        return gen

    async def _gen(self):
        try:
            for event in self.events:
                yield event
                if self.delay:
                    await asyncio.sleep(self.delay)
        finally:
            self.closed = True


def _real_text_events(
    text: str,
    *,
    completed_output_empty: bool = False,
    input_tokens: int = 5,
    output_tokens: int = 7,
) -> list[object]:
    """A real-typed Responses stream for one text message (miss-path tests)."""
    from openai.types.responses import (
        ResponseCompletedEvent,
        ResponseContentPartAddedEvent,
        ResponseContentPartDoneEvent,
        ResponseCreatedEvent,
        ResponseOutputItemAddedEvent,
        ResponseOutputItemDoneEvent,
        ResponseOutputMessage,
        ResponseOutputText,
        ResponseTextDeltaEvent,
        ResponseTextDoneEvent,
    )
    from openai.types.responses.response import Response

    part = ResponseOutputText(type="output_text", text=text, annotations=[])
    msg = ResponseOutputMessage(
        id="msg_real_1", type="message", role="assistant", status="completed", content=[part],
    )
    final = Response(
        id="resp_real_1", object="response", created_at=0, model="fake-model",
        output=[] if completed_output_empty else [msg],
        parallel_tool_calls=False, tool_choice="auto", tools=[], status="completed",
        usage=_build_response_usage(input_tokens, output_tokens),
    )
    started = final.model_copy(update={"status": "in_progress", "output": [], "usage": None})
    common = {"item_id": "msg_real_1", "output_index": 0, "content_index": 0}
    seq = iter(range(100))
    return [
        ResponseCreatedEvent.model_construct(
            type="response.created", response=started, sequence_number=next(seq)),
        ResponseOutputItemAddedEvent.model_construct(
            type="response.output_item.added", output_index=0,
            item=msg.model_copy(update={"status": "in_progress", "content": []}),
            sequence_number=next(seq)),
        ResponseContentPartAddedEvent.model_construct(
            type="response.content_part.added", part=part.model_copy(update={"text": ""}),
            sequence_number=next(seq), **common),
        ResponseTextDeltaEvent.model_construct(
            type="response.output_text.delta", delta=text, logprobs=[],
            sequence_number=next(seq), **common),
        ResponseTextDoneEvent.model_construct(
            type="response.output_text.done", text=text, logprobs=[],
            sequence_number=next(seq), **common),
        ResponseContentPartDoneEvent.model_construct(
            type="response.content_part.done", part=part, sequence_number=next(seq), **common),
        ResponseOutputItemDoneEvent.model_construct(
            type="response.output_item.done", output_index=0, item=msg,
            sequence_number=next(seq)),
        ResponseCompletedEvent(
            type="response.completed", response=final, sequence_number=next(seq)),
    ]


class _PrevIdRecordingModel(_StreamingFakeModel):
    """Live (miss) model for Runner tests: records previous_response_id, streams real events."""

    def __init__(self, final_text: str) -> None:
        super().__init__(events=[])
        self.final_text = final_text
        self.previous_response_ids: list[str | None] = []

    async def stream_response(self, *args, previous_response_id=None, **kwargs):
        self.stream_calls += 1
        self.previous_response_ids.append(previous_response_id)
        for event in _real_text_events(self.final_text):
            yield event


async def _probe_runner_args(cache, prompt: str, *, tools=None) -> tuple:
    """Run the real Runner once against a recording model and return the
    (system_instructions, input, model_settings) it passes for ``prompt``."""
    from agents import Agent, RunConfig, Runner

    probe = _RecordingStreamModel()
    run = Runner.run_streamed(
        Agent(name="A", model=CachedModel(probe, cache), tools=tools or []),
        prompt, run_config=RunConfig(tracing_disabled=True),
    )
    with pytest.raises(RuntimeError, match="must not be called"):
        async for _ in run.stream_events():
            pass
    assert probe.recorded is not None
    return probe.recorded


async def _probe_runner_params(cache, prompt: str, *, tools=None):
    system_instructions, runner_input, model_settings = await _probe_runner_args(
        cache, prompt, tools=tools,
    )
    return await prepare_params(system_instructions, runner_input, "fake-model", model_settings)


def _reasoning_item() -> SimpleNamespace:
    return SimpleNamespace(type="reasoning", id="rs_1", summary=[], content=None)


# ---------------------------------------------------------------------------
# Fix 1: response id on a streamed hit
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_stream_hit_response_id_is_none():
    cache = _make_cache()
    params = await prepare_params(None, "p", "fake-model")
    await cache.llm.store_multipart(params, [{"type": "text", "text": "hi"}])
    received = await _drain(
        CachedModel(_StreamingFakeModel(events=[]), cache).stream_response(
            None, "p", None, **_DEFAULT_KWARGS),
    )
    snapshots = [e.response for e in received if getattr(e, "response", None) is not None]
    assert snapshots, "hit must carry at least the terminal response"
    assert all(r.id is None for r in snapshots)
    assert all(getattr(e, "item_id", None) != "betterdb-cache" for e in received)


@pytest.mark.asyncio
async def test_stream_hit_runner_last_response_id_is_none_and_matches_nonstream():
    """Streamed and non-streamed hits both expose last_response_id None to the Runner."""
    from agents import Agent, RunConfig, Runner

    cache = _make_cache()
    params = await _probe_runner_params(cache, "cached prompt")
    await cache.llm.store_multipart(params, [{"type": "text", "text": "from cache"}])

    run_config = RunConfig(tracing_disabled=True)

    streamed_base = _RecordingStreamModel()
    streamed = Runner.run_streamed(
        Agent(name="A", model=CachedModel(streamed_base, cache)), "cached prompt",
        run_config=run_config,
    )
    async for _ in streamed.stream_events():
        pass
    assert streamed_base.stream_calls == 0
    assert streamed.last_response_id is None

    nonstream_base = _FakeModel(_make_text_response("unused"))
    plain = await Runner.run(
        Agent(name="A", model=CachedModel(nonstream_base, cache)), "cached prompt",
        run_config=run_config,
    )
    assert nonstream_base.calls == 0
    assert plain.last_response_id is None


@pytest.mark.asyncio
async def test_stream_hit_tool_replay_next_turn_does_not_send_fake_previous_response_id():
    """Hit replays a tool call; the next turn must not send a bogus previous_response_id."""
    import inspect

    from agents import Agent, RunConfig, Runner, function_tool

    if "auto_previous_response_id" not in inspect.signature(Runner.run_streamed).parameters:
        pytest.skip("installed agents has no auto_previous_response_id")

    tool_calls: list[str] = []

    @function_tool
    def get_weather(city: str) -> str:
        tool_calls.append(city)
        return "sunny"

    cache = _make_cache()
    params_args = await _probe_runner_args(cache, "weather?", tools=[get_weather])
    # Store turn 1 as a tool call through the non-streaming path (#149), same key.
    await CachedModel(
        _FakeModel(_make_tool_response("call_1", "get_weather", '{"city":"Berlin"}')), cache,
    ).get_response(*params_args, **_DEFAULT_KWARGS)

    model = _PrevIdRecordingModel(final_text="done")  # turn 2 is a real miss
    result = Runner.run_streamed(
        Agent(name="A", model=CachedModel(model, cache), tools=[get_weather]),
        "weather?",
        run_config=RunConfig(tracing_disabled=True),
        auto_previous_response_id=True,
    )
    async for _ in result.stream_events():
        pass

    assert tool_calls == ["Berlin"]  # replayed tool call executed exactly once
    assert result.final_output == "done"
    assert model.previous_response_ids == [None]  # never "betterdb-cache"


# ---------------------------------------------------------------------------
# Fix 2: get_retry_advice forwarding
# ---------------------------------------------------------------------------


def test_get_retry_advice_is_forwarded():
    sentinel = object()
    seen: list[object] = []

    class _AdvisingModel(_StreamingFakeModel):
        def get_retry_advice(self, request):
            seen.append(request)
            return sentinel

    req = object()
    assert CachedModel(_AdvisingModel(events=[]), _make_cache()).get_retry_advice(req) is sentinel
    assert seen == [req]


def test_get_retry_advice_without_wrapped_impl_returns_none():
    class _Bare:
        model = "fake-model"

    assert CachedModel(_Bare(), _make_cache()).get_retry_advice(object()) is None


def test_every_concrete_model_method_is_forwarded():
    """Any concrete method on the SDK Model would shadow __getattr__; CachedModel must define each."""
    from agents.models.interface import Model

    concrete = {
        name
        for name, attr in vars(Model).items()
        if callable(attr)
        and not name.startswith("__")
        and not getattr(attr, "__isabstractmethod__", False)
    }
    missing = sorted(n for n in concrete if n not in vars(CachedModel))
    assert not missing, f"CachedModel must forward: {missing}"


# ---------------------------------------------------------------------------
# Fix 3: a streamed hit counts zero requests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_stream_hit_counts_zero_requests_like_nonstream_hit():
    import warnings

    from agents import Agent, RunConfig, Runner

    cache = _make_cache()
    params = await _probe_runner_params(cache, "cached prompt")
    await cache.llm.store_multipart(
        params, [{"type": "text", "text": "from cache"}],
        LlmStoreOptions(tokens={"input": 11, "output": 13}),
    )
    run_config = RunConfig(tracing_disabled=True)

    streamed = Runner.run_streamed(
        Agent(name="A", model=CachedModel(_RecordingStreamModel(), cache)), "cached prompt",
        run_config=run_config,
    )
    raw = [
        e.data async for e in streamed.stream_events()
        if getattr(e, "type", None) == "raw_response_event"
    ]
    plain = await Runner.run(
        Agent(name="A", model=CachedModel(_FakeModel(_make_text_response("unused")), cache)),
        "cached prompt", run_config=run_config,
    )

    s_usage, p_usage = streamed.context_wrapper.usage, plain.context_wrapper.usage
    assert s_usage.requests == 0 == p_usage.requests
    assert (s_usage.input_tokens, s_usage.output_tokens) == (11, 13)
    assert (p_usage.input_tokens, p_usage.output_tokens) == (11, 13)

    # The private marker must not break serialization of the replayed Response.
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        raw[-1].response.model_dump()


# ---------------------------------------------------------------------------
# Fix 4: upstream is closed deterministically
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_stream_consumer_break_closes_upstream():
    cache = _make_cache()
    base = _CloseTrackingModel([_text_delta_event("a"), _completed_event(_make_text_response("a"))])
    agen = CachedModel(base, cache).stream_response(None, "prompt", None, **_DEFAULT_KWARGS)
    async for _ in agen:
        break
    await agen.aclose()
    assert base.closed is True
    assert (await cache.llm.check(await prepare_params(None, "prompt", "fake-model"))).hit is False


@pytest.mark.asyncio
async def test_stream_cancelled_closes_upstream():
    cache = _make_cache()
    base = _CloseTrackingModel(
        [_text_delta_event("a"), _completed_event(_make_text_response("a"))], delay=10,
    )
    first = asyncio.Event()

    async def consume():
        async for _ in CachedModel(base, cache).stream_response(
            None, "prompt", None, **_DEFAULT_KWARGS,
        ):
            first.set()

    task = asyncio.create_task(consume())
    await first.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert base.closed is True
    assert (await cache.llm.check(await prepare_params(None, "prompt", "fake-model"))).hit is False


@pytest.mark.asyncio
async def test_stream_full_drain_closes_upstream_and_stores():
    cache = _make_cache()
    base = _CloseTrackingModel(
        [_text_delta_event("ok"), _completed_event(_make_text_response("ok"))],
    )
    await _drain(CachedModel(base, cache).stream_response(None, "prompt", None, **_DEFAULT_KWARGS))
    assert base.closed is True
    assert (await cache.llm.check(await prepare_params(None, "prompt", "fake-model"))).hit is True


@pytest.mark.asyncio
async def test_stream_upstream_without_aclose_is_supported():
    cache = _make_cache()
    events = [_text_delta_event("ok"), _completed_event(_make_text_response("ok"))]

    class _Iter:
        def __init__(self):
            self._it = iter(events)

        def __aiter__(self):
            return self

        async def __anext__(self):
            try:
                return next(self._it)
            except StopIteration:
                raise StopAsyncIteration

    class _PlainIterModel(_StreamingFakeModel):
        def stream_response(self, *a, **k):
            self.stream_calls += 1
            return _Iter()

    received = await _drain(
        CachedModel(_PlainIterModel(events=[]), cache).stream_response(
            None, "prompt", None, **_DEFAULT_KWARGS),
    )
    assert received == events


# ---------------------------------------------------------------------------
# Fix 5: never store an answer with no text
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_stream_reasoning_only_is_not_stored():
    cache = _make_cache()
    resp = SimpleNamespace(
        output=[_reasoning_item()], usage=SimpleNamespace(input_tokens=3, output_tokens=4),
    )
    await _drain(CachedModel(_StreamingFakeModel([_completed_event(resp)]), cache)
                 .stream_response(None, "prompt", None, **_DEFAULT_KWARGS))
    assert (await cache.llm.check(await prepare_params(None, "prompt", "fake-model"))).hit is False


@pytest.mark.asyncio
async def test_stream_empty_text_is_not_stored():
    cache = _make_cache()
    await _drain(CachedModel(_StreamingFakeModel([_completed_event(_make_text_response(""))]), cache)
                 .stream_response(None, "prompt", None, **_DEFAULT_KWARGS))
    assert (await cache.llm.check(await prepare_params(None, "prompt", "fake-model"))).hit is False


@pytest.mark.asyncio
async def test_stream_reasoning_plus_text_is_stored_as_text():
    cache = _make_cache()
    text_resp = _make_text_response("answer")
    resp = SimpleNamespace(
        output=[_reasoning_item(), *text_resp.output],
        usage=getattr(text_resp, "usage", SimpleNamespace(input_tokens=1, output_tokens=1)),
    )
    await _drain(CachedModel(_StreamingFakeModel([_completed_event(resp)]), cache)
                 .stream_response(None, "prompt", None, **_DEFAULT_KWARGS))
    cached = await cache.llm.check(await prepare_params(None, "prompt", "fake-model"))
    assert cached.hit is True
    assert [b["text"] for b in cached.content_blocks if b["type"] == "text"] == ["answer"]


# ---------------------------------------------------------------------------
# Fix 6: replay shape, fallback to the model, store independent of the Runner
# ---------------------------------------------------------------------------

_TEXT_HIT_SHAPE = [
    "response.created", "response.in_progress",
    "response.output_item.added", "response.content_part.added",
    "response.output_text.delta", "response.output_text.done",
    "response.content_part.done", "response.output_item.done",
    "response.completed",
]


@pytest.mark.asyncio
async def test_stream_hit_event_shape_matches_live_stream():
    cache = _make_cache()
    params = await prepare_params(None, "p", "fake-model")
    await cache.llm.store_multipart(params, [{"type": "text", "text": "hello"}])
    received = await _drain(CachedModel(_StreamingFakeModel(events=[]), cache)
                            .stream_response(None, "p", None, **_DEFAULT_KWARGS))

    assert [e.type for e in received] == _TEXT_HIT_SHAPE
    assert [e.sequence_number for e in received] == list(range(len(received)))
    deltas = "".join(e.delta for e in received if e.type == "response.output_text.delta")
    done = [e.text for e in received if e.type == "response.output_text.done"]
    assert deltas == "hello" and done == ["hello"]
    item_id = received[-1].response.output[0].id
    assert all(
        e.item_id == item_id for e in received if getattr(e, "item_id", None) is not None
    )


@pytest.mark.asyncio
async def test_stream_hit_tool_call_event_shape():
    cache = _make_cache()
    await CachedModel(
        _FakeModel(_make_tool_response("call_9", "get_weather", '{"city":"Berlin"}')), cache,
    ).get_response(None, "weather?", None, **_DEFAULT_KWARGS)
    received = await _drain(CachedModel(_StreamingFakeModel(events=[]), cache)
                            .stream_response(None, "weather?", None, **_DEFAULT_KWARGS))
    types = [e.type for e in received]
    assert types[:2] == ["response.created", "response.in_progress"]
    assert types[-1] == "response.completed"
    i = types.index("response.function_call_arguments.delta")
    assert types[i - 1] == "response.output_item.added"
    assert types[i + 1] == "response.function_call_arguments.done"
    assert types[i + 2] == "response.output_item.done"
    assert json.loads(received[i + 1].arguments) == {"city": "Berlin"}


@pytest.mark.asyncio
async def test_stream_hit_synthesis_failure_falls_back_to_model():
    cache = _make_cache()
    params = await prepare_params(None, "p", "fake-model")
    await cache.llm.store_multipart(params, [{"type": "text", "text": "cached"}])
    live = [_text_delta_event("live"), _completed_event(_make_text_response("live"))]
    base = _StreamingFakeModel(live)
    with patch("betterdb_agent_cache.adapters.openai_agents._synthesize_stream_events",
               side_effect=RuntimeError("boom")):
        received = await _drain(
            CachedModel(base, cache).stream_response(None, "p", None, **_DEFAULT_KWARGS),
        )
    assert base.stream_calls == 1
    assert received == live


@pytest.mark.asyncio
async def test_stream_miss_stores_when_completed_output_is_empty():
    """Store must not depend on the consumer filling terminal output in place."""
    cache = _make_cache()
    events = _real_text_events("from items", completed_output_empty=True)
    received = await _drain(CachedModel(_StreamingFakeModel(events), cache)
                            .stream_response(None, "prompt", None, **_DEFAULT_KWARGS))
    assert received == events
    assert events[-1].response.output == []  # caller's object not mutated
    cached = await cache.llm.check(await prepare_params(None, "prompt", "fake-model"))
    assert cached.hit is True
    assert [b["text"] for b in cached.content_blocks if b["type"] == "text"] == ["from items"]


@pytest.mark.asyncio
@pytest.mark.parametrize("completed_output_empty", [False, True])
async def test_stream_miss_drives_real_runner_then_hits(completed_output_empty):
    """Miss through the real Runner with real Response objects, then a second run is a hit."""
    from agents import Agent, RunConfig, Runner

    cache = _make_cache()
    events = _real_text_events("live answer", completed_output_empty=completed_output_empty)
    base = _StreamingFakeModel(events)
    run_config = RunConfig(tracing_disabled=True)

    first = Runner.run_streamed(
        Agent(name="A", model=CachedModel(base, cache)), "q", run_config=run_config,
    )
    async for _ in first.stream_events():
        pass
    assert first.final_output == "live answer"
    assert base.stream_calls == 1

    second = Runner.run_streamed(
        Agent(name="A", model=CachedModel(base, cache)), "q", run_config=run_config,
    )
    async for _ in second.stream_events():
        pass
    assert second.final_output == "live answer"
    assert base.stream_calls == 1  # served from cache
    assert second.last_response_id is None


@pytest.mark.asyncio
async def test_stream_hit_runner_output_not_duplicated():
    """Replayed output_item.done events must not double the Runner's output items."""
    from agents import Agent, RunConfig, Runner

    cache = _make_cache()
    params = await _probe_runner_params(cache, "cached prompt")
    await cache.llm.store_multipart(params, [{"type": "text", "text": "from cache"}])
    result = Runner.run_streamed(
        Agent(name="A", model=CachedModel(_RecordingStreamModel(), cache)), "cached prompt",
        run_config=RunConfig(tracing_disabled=True),
    )
    async for _ in result.stream_events():
        pass
    assert len(result.raw_responses) == 1
    assert len(result.raw_responses[0].output) == 1
    assert result.final_output == "from cache"
