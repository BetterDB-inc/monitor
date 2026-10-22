"""OpenAI Agents SDK adapter.

Wraps any Agents SDK ``Model`` with an exact-match LLM cache.  Cache is
consulted before each ``get_response()`` and ``stream_response()`` call; on
miss the underlying model is invoked and the response is stored.  Streaming
uses the same cache key as ``get_response()``, so a streamed request can hit
an entry stored by its non-streamed twin (and vice-versa).

Usage via ModelProvider (recommended)::

    from agents import Agent, RunConfig, Runner
    from betterdb_agent_cache.adapters.openai_agents import CachedModelProvider

    cached_provider = CachedModelProvider(provider, cache=agent_cache)
    result = await Runner.run(
        agent, "Hello", run_config=RunConfig(model_provider=cached_provider),
    )

Usage via direct Model wrapping::

    from agents import Agent
    from agents.models.openai_chatcompletions import OpenAIChatCompletionsModel
    from betterdb_agent_cache.adapters.openai_agents import CachedModel

    base_model = OpenAIChatCompletionsModel(model="gpt-4o", openai_client=client)
    agent = Agent(name="Assistant", model=CachedModel(base_model, cache=agent_cache))

Also exposes ``prepare_params`` for users who want to manage caching
manually rather than through the wrapper.

Limitations
~~~~~~~~~~~
* Tool-call streams are not stored — mirrors the TypeScript
  ``@betterdb/agent-cache`` v0.11.0 ``wrapStream`` convention of not caching
  half-executed agent steps.  Non-streaming ``get_response()`` continues to
  cache tool calls; a streamed request can still hit (and replay) a
  tool-call entry stored by get_response().
* A streamed hit replays the full Responses event shape (created, per-item and
  per-part added/delta/done, completed). The replayed ``Response`` has
  ``id=None`` (like a non-streamed hit, so ``previous_response_id`` chaining is
  never pointed at a cache entry) and its usage reports zero model requests.
* Responses with no text output (e.g. reasoning-only) are never stored.
* Binary / multimodal content in input items is JSON-serialised raw via
  ``_to_text()``.  A follow-up can add explicit normalizer dispatch
  matching ``openai.py``.
* ``tools``, ``handoffs``, and ``output_schema`` are excluded from the
  cache key — safe when one CachedModel wraps a single Agent whose tools
  don't change between calls.
* ``ResponseOutputRefusal`` content is stored as a plain text block; the
  cached hit returns the refusal message as text rather than a typed refusal
  object.
"""
from __future__ import annotations

import contextlib
import inspect
import json
import logging
from dataclasses import dataclass, field, is_dataclass
from types import SimpleNamespace
from typing import TYPE_CHECKING, Any

from ..errors import ValkeyCommandError
from ..normalizer import BinaryNormalizer, default_normalizer
from ..types import ContentBlock, LlmCacheParams, LlmStoreOptions
from ..utils import parse_tool_call_args

_LOGGER = logging.getLogger(__name__)

# Output-item id for rebuilt cache-hit messages (items need an id; the Response itself has none).
_CACHE_ITEM_ID = "msg_betterdb_cache"

if TYPE_CHECKING:
    from ..agent_cache import AgentCache

# Subclass the SDK's Model ABC when it is installed, so ``Agent(model=CachedModel(...))``
# passes the Agent's isinstance check. ``openai-agents`` stays an optional extra.
try:
    from agents.models.interface import Model as _ModelBase
except ImportError:  # pragma: no cover - environment dependent
    _ModelBase = object  # type: ignore[assignment,misc]


@dataclass
class OpenAIAgentsPrepareOptions:
    normalizer: BinaryNormalizer = field(default_factory=lambda: default_normalizer)


def _to_text(value: Any) -> str:
    """Serialize a value to a stable text representation for cache keys."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


async def _normalize_input_item(
    item: Any,
) -> dict[str, Any]:
    """Reduce a single Responses API input item to a canonical dict for hashing.

    .. note::
       Binary / image content is JSON-serialised raw via ``_to_text()``.
       A follow-up can add explicit normalizer dispatch matching ``openai.py``.
    """
    if isinstance(item, str):
        return {"type": "message", "role": "user", "content": item}
    if isinstance(item, dict):
        # Responses API items are already dicts — normalize nested content
        # by sorting keys for deterministic hashing.
        return json.loads(json.dumps(item, ensure_ascii=False, sort_keys=True))
    if hasattr(item, "model_dump"):
        return json.loads(
            json.dumps(item.model_dump(exclude_none=True), ensure_ascii=False, sort_keys=True),
        )
    if is_dataclass(item) and not isinstance(item, type):
        try:
            from dataclasses import asdict

            return json.loads(json.dumps(asdict(item), ensure_ascii=False, sort_keys=True))
        except TypeError:
            pass
    return {"type": "unknown", "content": _to_text(item)}


async def prepare_params(
    system_instructions: str | None,
    input: str | list[Any],
    model_name: str,
    model_settings: Any | None = None,
    opts: OpenAIAgentsPrepareOptions | None = None,
) -> LlmCacheParams:
    """Convert OpenAI Agents SDK get_response() args to canonical ``LlmCacheParams``."""
    # opts.normalizer is reserved for follow-up binary/multimodal normalizer
    # dispatch in _normalize_input_item — matching the peer adapter API surface.

    messages: list[Any] = []

    if system_instructions:
        messages.append({"role": "system", "content": system_instructions})

    if isinstance(input, str):
        messages.append({"role": "user", "content": [{"type": "text", "text": input}]})
    else:
        for item in input:
            messages.append(await _normalize_input_item(item))

    result: LlmCacheParams = {"model": model_name, "messages": messages}

    settings: dict[str, Any] = {}
    if model_settings is not None:
        if hasattr(model_settings, "model_dump"):
            settings = model_settings.model_dump(exclude_none=True) or {}
        elif isinstance(model_settings, dict):
            settings = model_settings
        else:
            try:
                settings = {k: v for k, v in vars(model_settings).items() if v is not None}
            except TypeError:
                settings = {}

    if settings.get("temperature") is not None:
        result["temperature"] = settings["temperature"]
    if settings.get("top_p") is not None:
        result["top_p"] = settings["top_p"]
    if settings.get("max_tokens") is not None:
        result["max_tokens"] = settings["max_tokens"]
    if settings.get("max_output_tokens") is not None:
        result["max_tokens"] = settings["max_output_tokens"]
    if settings.get("seed") is not None:
        result["seed"] = settings["seed"]
    if settings.get("stop") is not None:
        stop = settings["stop"]
        result["stop"] = [stop] if isinstance(stop, str) else stop
    if settings.get("tool_choice") is not None:
        result["tool_choice"] = settings["tool_choice"]
    if settings.get("frequency_penalty") is not None:
        result["frequency_penalty"] = settings["frequency_penalty"]
    if settings.get("presence_penalty") is not None:
        result["presence_penalty"] = settings["presence_penalty"]
    if settings.get("parallel_tool_calls") is not None:
        result["parallel_tool_calls"] = settings["parallel_tool_calls"]
    if settings.get("reasoning") is not None:
        result["reasoning"] = settings["reasoning"]

    return result


def _parse_args(args: Any) -> dict[str, Any]:
    """Parse function call arguments (string or dict)."""
    if isinstance(args, dict):
        return args
    return parse_tool_call_args(args) if isinstance(args, str) else {}


def _extract_blocks(response: Any) -> list[ContentBlock]:
    """Extract ContentBlock dicts from a ModelResponse.output list."""
    blocks: list[ContentBlock] = []
    raw_out = getattr(response, "output", []) or []
    for item in raw_out:
        item_type = item.get("type") if isinstance(item, dict) else getattr(item, "type", None)
        if item_type == "message":
            parts = item.get("content") if isinstance(item, dict) else getattr(item, "content", [])
            parts = parts or []
            for part in parts:
                part_type = part.get("type") if isinstance(part, dict) else getattr(part, "type", None)
                if part_type in ("output_text", "text"):
                    text_val = ""
                    if isinstance(part, dict):
                        text_val = part.get("text") or ""
                    else:
                        text_val = getattr(part, "text", "") or ""
                    blocks.append({"type": "text", "text": text_val})
                elif part_type == "refusal":
                    # ResponseOutputRefusal — store refusal text so cache hits
                    # preserve the refusal content rather than silently dropping it.
                    refusal_text = ""
                    if isinstance(part, dict):
                        refusal_text = part.get("refusal") or ""
                    else:
                        refusal_text = getattr(part, "refusal", "") or ""
                    blocks.append({"type": "text", "text": refusal_text})
        elif item_type == "function_call":
            if isinstance(item, dict):
                call_id = item.get("call_id", "")
                name = item.get("name", "")
                arguments = item.get("arguments", "")
            else:
                call_id = getattr(item, "call_id", "") or ""
                name = getattr(item, "name", "") or ""
                arguments = getattr(item, "arguments", "") or ""
            blocks.append({
                "type": "tool_call",
                "id": call_id,
                "name": name,
                "args": _parse_args(arguments),
            })
    return blocks


def _rebuild_output(
    content_blocks: list[ContentBlock] | None,
    response_text: str | None,
) -> list[Any]:
    """Rebuild Responses API output items from cached ContentBlocks.

    Uses OpenAI SDK output models when available so ``ModelResponse`` passes
    Pydantic validation (``openai-agents`` 0.1+).  Falls back to ``SimpleNamespace``
    for older stacks that use plain dataclasses.
    """
    try:
        from openai.types.responses import (
            ResponseFunctionToolCall,
            ResponseOutputMessage,
            ResponseOutputText,
        )
    except ImportError:
        ResponseOutputMessage = None  # type: ignore[assignment,misc]
        ResponseOutputText = None  # type: ignore[assignment,misc]
        ResponseFunctionToolCall = None  # type: ignore[assignment,misc]

    def text_part(text_val: str) -> Any:
        if ResponseOutputText is None:
            return SimpleNamespace(type="output_text", text=text_val)
        try:
            return ResponseOutputText.model_construct(
                type="output_text",
                text=text_val,
                annotations=[],
            )
        except TypeError:
            try:
                return ResponseOutputText.model_construct(type="output_text", text=text_val)
            except Exception:
                return SimpleNamespace(type="output_text", text=text_val)

    def tool_part(call_id: str, name: str, arguments: str) -> Any:
        if ResponseFunctionToolCall is None:
            return SimpleNamespace(
                type="function_call",
                call_id=call_id,
                name=name,
                arguments=arguments,
            )
        try:
            return ResponseFunctionToolCall.model_construct(
                type="function_call",
                call_id=call_id,
                name=name,
                arguments=arguments,
            )
        except Exception:
            return SimpleNamespace(
                type="function_call",
                call_id=call_id,
                name=name,
                arguments=arguments,
            )

    output: list[Any] = []
    text_parts: list[Any] = []

    if content_blocks:
        for block in content_blocks:
            if block["type"] == "text":
                text_parts.append(text_part(block["text"]))
            elif block["type"] == "tool_call":
                args_str = json.dumps(block.get("args", {}), ensure_ascii=False, sort_keys=True)
                output.append(tool_part(block.get("id", ""), block.get("name", ""), args_str))
    elif response_text is not None:
        text_parts.append(text_part(response_text))

    if text_parts:
        if ResponseOutputMessage is None:
            output.insert(0, SimpleNamespace(
                type="message", role="assistant", content=text_parts,
            ))
        else:
            try:
                output.insert(
                    0,
                    ResponseOutputMessage.model_construct(
                        id=_CACHE_ITEM_ID,
                        type="message",
                        role="assistant",
                        status="completed",
                        content=text_parts,
                    ),
                )
            except TypeError:
                try:
                    output.insert(
                        0,
                        ResponseOutputMessage.model_construct(
                            id=_CACHE_ITEM_ID,
                            type="message",
                            role="assistant",
                            content=text_parts,
                        ),
                    )
                except Exception:
                    output.insert(0, SimpleNamespace(
                        type="message", role="assistant", content=text_parts,
                    ))
            except Exception:
                output.insert(0, SimpleNamespace(
                    type="message", role="assistant", content=text_parts,
                ))

    return output


def _make_usage(input_tokens: int, output_tokens: int) -> Any:
    """Create a minimal ``Usage`` object for cache hits."""
    from agents.usage import Usage

    return Usage(
        requests=0,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=input_tokens + output_tokens,
    )


def _cache_hit_model_response(output: list[Any], usage: Any) -> Any:
    """Build ``ModelResponse`` for a cache hit, compatible across SDK releases."""
    from agents.items import ModelResponse

    fields = inspect.signature(ModelResponse.__init__).parameters
    kw: dict[str, Any] = {"output": output, "usage": usage, "response_id": None}
    if "request_id" in fields:
        kw["request_id"] = None
    if "referenceable_id" in fields:
        kw["referenceable_id"] = None
    return ModelResponse(**kw)


def _terminal_response_from_event(event: Any) -> Any | None:
    """Return the ``Response`` carried by a terminal stream event, else ``None``.

    ``response.completed``, ``response.incomplete`` and ``response.failed`` are
    all terminal; callers decide what to do with each (only a completed
    response is cacheable, see :func:`_is_cacheable_terminal`).
    """
    etype = getattr(event, "type", None)
    if etype in ("response.completed", "response.incomplete", "response.failed"):
        return getattr(event, "response", None)
    return None


def _is_cacheable_terminal(event_type: str | None, response: Any) -> bool:
    """Only a fully completed response may be stored.

    ``response.incomplete`` (e.g. truncated by ``max_output_tokens``) and
    ``response.failed`` are never cached: replaying a truncated answer on every
    future hit would be worse than a miss.
    """
    if event_type != "response.completed":
        return False
    status = getattr(response, "status", None)
    return status in (None, "completed")


# Output item types that represent a finished answer. Anything else
# (function_call, file_search_call, web_search_call, computer_call, mcp_call,
# code_interpreter_call, image_generation_call, local_shell_call, ...) is a
# half-executed agent step and is never stored from a stream.
_STORABLE_OUTPUT_TYPES = frozenset({"message", "reasoning"})


def _has_text_block(blocks: list[Any] | None) -> bool:
    """A stored answer must contain at least one non-empty text block."""
    return any(
        isinstance(b, dict) and b.get("type") == "text" and b.get("text")
        for b in (blocks or [])
    )


def _output_is_final_answer(output: list[Any]) -> bool:
    """True if every output item is a final-answer item (no tool/agent steps)."""
    if not output:
        return False
    for item in output:
        item_type = item.get("type") if isinstance(item, dict) else getattr(item, "type", None)
        if item_type not in _STORABLE_OUTPUT_TYPES:
            return False
    return True


def _with_output(response: Any, output: list[Any]) -> Any:
    """Return ``response`` with ``output`` set, without mutating the caller's object."""
    if getattr(response, "output", None):
        return response
    model_copy = getattr(response, "model_copy", None)
    if model_copy is not None:
        return model_copy(update={"output": output})
    return SimpleNamespace(**{**vars(response), "output": output})


def _copy(obj: Any, **update: Any) -> Any:
    model_copy = getattr(obj, "model_copy", None)
    return model_copy(update=update) if model_copy is not None else obj


def _build_response_usage(input_tokens: int, output_tokens: int) -> Any:
    """Validated Responses ``ResponseUsage`` (handles SDKs with/without cache_write_tokens)."""
    from openai.types.responses.response_usage import (  # type: ignore
        InputTokensDetails,
        OutputTokensDetails,
        ResponseUsage,
    )

    input_details: dict[str, int] = {"cached_tokens": 0}
    if "cache_write_tokens" in InputTokensDetails.model_fields:
        input_details["cache_write_tokens"] = 0
    return ResponseUsage(
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=input_tokens + output_tokens,
        input_tokens_details=InputTokensDetails(**input_details),
        output_tokens_details=OutputTokensDetails(reasoning_tokens=0),
    )


def _mark_cache_hit_usage(usage: Any) -> Any:
    """A cache hit made no model request: report requests=0 to the Agents SDK,
    matching the non-streamed hit (``_make_usage``)."""
    # Same mechanism the SDK itself uses to annotate a ResponseUsage (see
    # agents.usage._response_usage_to_usage); keeps the pydantic model's dump clean.
    object.__setattr__(usage, "_agents_sdk_request_count", 0)
    return usage


@contextlib.asynccontextmanager
async def _aclosing(stream: Any) -> Any:
    """Like ``contextlib.aclosing`` but tolerates async iterators without ``aclose``.

    Guarantees the upstream stream (and its HTTP connection) is closed as soon as
    our generator exits — normal drain, consumer ``aclose()``/break, cancellation,
    or upstream error — instead of whenever GC finalizes it.
    """
    try:
        yield stream
    finally:
        aclose = getattr(stream, "aclose", None)
        if aclose is not None:
            await aclose()


def _synthesize_stream_events(
    content_blocks: list[ContentBlock] | None,
    response_text: str | None,
    input_tokens: int,
    output_tokens: int,
    model_name: str,
) -> list[Any]:
    """Rebuild a Responses event stream for a cache hit.

    Emits the same event shape a live stream produces (created, in_progress,
    per-item added/done, per-part text delta/done, function-call argument
    delta/done, completed) so raw-event consumers see no difference from a miss.

    The synthesized ``Response`` has ``id=None`` (a cache hit has no server-side
    response to chain from, matching the non-streamed hit), and its usage reports
    zero model requests. Raises if the SDK models cannot be built; the caller
    then falls back to the live model.
    """
    from openai.types.responses import (  # type: ignore
        ResponseCompletedEvent,
        ResponseContentPartAddedEvent,
        ResponseContentPartDoneEvent,
        ResponseCreatedEvent,
        ResponseFunctionCallArgumentsDeltaEvent,
        ResponseFunctionCallArgumentsDoneEvent,
        ResponseInProgressEvent,
        ResponseOutputItemAddedEvent,
        ResponseOutputItemDoneEvent,
        ResponseTextDeltaEvent,
        ResponseTextDoneEvent,
    )
    from openai.types.responses.response import Response  # type: ignore

    output = _rebuild_output(content_blocks, response_text)
    final = Response(
        id="placeholder",  # required by validation; cleared below
        object="response",
        created_at=0,
        model=model_name,
        output=output,
        parallel_tool_calls=False,
        tool_choice="auto",
        tools=[],
        status="completed",
        usage=_build_response_usage(input_tokens, output_tokens),
    ).model_copy(update={"id": None})
    _mark_cache_hit_usage(final.usage)
    started = final.model_copy(update={"status": "in_progress", "output": [], "usage": None})

    events: list[Any] = []

    def emit(cls: Any, **fields: Any) -> None:
        # model_construct: these intermediate events gained/renamed optional fields
        # across openai releases; the Runner only type-checks them.
        events.append(cls.model_construct(sequence_number=len(events), **fields))

    emit(ResponseCreatedEvent, type="response.created", response=started)
    emit(ResponseInProgressEvent, type="response.in_progress", response=started)

    for out_idx, item in enumerate(final.output):
        item_type = getattr(item, "type", None)
        item_id = getattr(item, "id", None) or ""

        if item_type == "message":
            emit(ResponseOutputItemAddedEvent, type="response.output_item.added",
                 output_index=out_idx, item=_copy(item, status="in_progress", content=[]))
            for c_idx, part in enumerate(getattr(item, "content", None) or []):
                is_text = getattr(part, "type", None) == "output_text"
                text = (getattr(part, "text", None) or "") if is_text else ""
                common = {"item_id": item_id, "output_index": out_idx, "content_index": c_idx}
                emit(ResponseContentPartAddedEvent, type="response.content_part.added",
                     part=_copy(part, text="") if is_text else part, **common)
                if is_text:
                    emit(ResponseTextDeltaEvent, type="response.output_text.delta",
                         delta=text, logprobs=[], **common)
                    emit(ResponseTextDoneEvent, type="response.output_text.done",
                         text=text, logprobs=[], **common)
                emit(ResponseContentPartDoneEvent, type="response.content_part.done",
                     part=part, **common)
        elif item_type == "function_call":
            args = getattr(item, "arguments", None) or ""
            emit(ResponseOutputItemAddedEvent, type="response.output_item.added",
                 output_index=out_idx, item=_copy(item, status="in_progress", arguments=""))
            emit(ResponseFunctionCallArgumentsDeltaEvent,
                 type="response.function_call_arguments.delta",
                 item_id=item_id, output_index=out_idx, delta=args)
            emit(ResponseFunctionCallArgumentsDoneEvent,
                 type="response.function_call_arguments.done",
                 item_id=item_id, output_index=out_idx, arguments=args,
                 name=getattr(item, "name", None))
        else:
            emit(ResponseOutputItemAddedEvent, type="response.output_item.added",
                 output_index=out_idx, item=item)

        emit(ResponseOutputItemDoneEvent, type="response.output_item.done",
             output_index=out_idx, item=item)

    emit(ResponseCompletedEvent, type="response.completed", response=final)
    return events


class CachedModel(_ModelBase):
    """Agents SDK ``Model`` wrapper that checks the cache before each
    ``get_response()`` and ``stream_response()`` call.
    """

    def __init__(
        self,
        model: Any,
        cache: "AgentCache",
        opts: OpenAIAgentsPrepareOptions | None = None,
    ) -> None:
        self._model = model
        self._cache = cache
        self._opts = opts or OpenAIAgentsPrepareOptions()

    def __getattr__(self, name: str) -> Any:
        return getattr(self._model, name)

    # Model defines close(), _cleanup_on_run_end() and get_retry_advice() as concrete
    # defaults, which would shadow __getattr__ delegation; forward them so the wrapped
    # model still releases its resources and surfaces provider retry advice.
    async def close(self) -> None:
        close = getattr(self._model, "close", None)
        if close is not None:
            await close()

    async def _cleanup_on_run_end(self, owner: object) -> None:
        cleanup = getattr(self._model, "_cleanup_on_run_end", None)
        if cleanup is not None:
            await cleanup(owner)

    def get_retry_advice(self, request: Any) -> Any:
        """Forward to the wrapped model; ``Model`` defines a concrete default that
        would otherwise shadow ``__getattr__`` and drop provider retry-after advice."""
        advice = getattr(self._model, "get_retry_advice", None)
        return advice(request) if advice is not None else None

    async def stream_response(
        self,
        system_instructions: str | None,
        input: str | list[Any],
        model_settings: Any,
        tools: list[Any],
        output_schema: Any | None,
        handoffs: list[Any],
        tracing: Any,
        *,
        previous_response_id: str | None = None,
        **kwargs: Any,
    ) -> Any:
        """Cache-aware streaming.

        Hit: replay the stored response as a Responses event stream; the underlying
        model is not called. If the replay cannot be built, fall back to the model.

        Miss: pass every upstream event through unchanged. Once the stream has fully
        drained, store it if it completed normally and holds only a final answer
        with text. Early exit, cancellation and upstream errors never store, and the
        upstream stream is always closed on exit.

        Same cache key as :meth:`get_response`, so streamed and non-streamed calls
        share entries in both directions.
        """
        model_name = str(getattr(self._model, "model", "unknown"))
        params = await prepare_params(
            system_instructions, input, model_name, model_settings, self._opts,
        )

        cached = await self._cache.llm.check(params)
        if cached.hit:
            try:
                replay = _synthesize_stream_events(
                    cached.content_blocks,
                    cached.response,
                    cached.input_tokens,
                    cached.output_tokens,
                    model_name,
                )
            except Exception as exc:  # replay must never break the run
                _LOGGER.warning(
                    "agent-cache: could not replay cached stream, calling the model: %s", exc,
                )
            else:
                for event in replay:
                    yield event
                return

        terminal_type: str | None = None
        terminal_response: Any = None
        done_items: list[Any] = []

        async with _aclosing(
            self._model.stream_response(
                system_instructions,
                input,
                model_settings,
                tools,
                output_schema,
                handoffs,
                tracing,
                previous_response_id=previous_response_id,
                **kwargs,
            )
        ) as upstream:
            async for event in upstream:
                etype = getattr(event, "type", None)
                if etype == "response.output_item.done":
                    item = getattr(event, "item", None)
                    if item is not None:
                        done_items.append(item)
                resp = _terminal_response_from_event(event)
                if resp is not None:
                    terminal_type = etype
                    terminal_response = resp
                yield event

        # Reached only after a normal, complete drain. Early exit / cancellation
        # raise at the `yield` above (upstream is closed by _aclosing), and
        # upstream errors propagate, so nothing partial is ever stored.
        if terminal_response is None or not _is_cacheable_terminal(
            terminal_type, terminal_response,
        ):
            return
        # Providers may send response.completed with an empty output; fall back to
        # the items streamed via output_item.done rather than relying on the
        # consumer to have filled the terminal response in place.
        output = list(getattr(terminal_response, "output", None) or []) or done_items
        if not _output_is_final_answer(output):
            return
        await self._store_stream_result(params, _with_output(terminal_response, output))

    async def _store_stream_result(self, params: Any, response: Any) -> None:
        """Persist a completed streamed response. Fail-open: never raises."""
        try:
            blocks = _extract_blocks(response)
            if not _has_text_block(blocks):
                _LOGGER.debug("agent-cache: streamed response has no text output; not storing")
                return
            usage = getattr(response, "usage", None)
            inp = int(getattr(usage, "input_tokens", 0) or 0)
            out_tok = int(getattr(usage, "output_tokens", 0) or 0)
            await self._cache.llm.store_multipart(
                params,
                blocks,
                LlmStoreOptions(tokens={"input": inp, "output": out_tok}),
            )
        except ValkeyCommandError as exc:
            _LOGGER.warning("agent-cache stream store failed; stream already delivered: %s", exc)
        except Exception as exc:  # store must fail open
            _LOGGER.warning("agent-cache stream store errored unexpectedly: %s", exc)

    async def get_response(
        self,
        system_instructions: str | None,
        input: str | list[Any],
        model_settings: Any,
        tools: list[Any],
        output_schema: Any | None,
        handoffs: list[Any],
        tracing: Any,
        *,
        previous_response_id: str | None = None,
        **kwargs: Any,
    ) -> Any:
        model_name = str(getattr(self._model, "model", "unknown"))

        # tools, handoffs, and output_schema are excluded from the cache key.
        # This is safe when one CachedModel wraps a single Agent whose tools
        # don't change between calls — the typical usage pattern.
        # previous_response_id, conversation_id, and prompt are also excluded:
        # they are server-side context references, not content. Including them
        # would prevent caching the same logical prompt across conversation turns.
        # If server-side context affects your responses, create separate
        # CachedModel instances per conversation thread.
        params = await prepare_params(
            system_instructions, input, model_name, model_settings, self._opts,
        )

        cached = await self._cache.llm.check(params)
        if cached.hit:
            output = _rebuild_output(cached.content_blocks, cached.response)
            return _cache_hit_model_response(
                output,
                _make_usage(cached.input_tokens, cached.output_tokens),
            )

        response = await self._model.get_response(
            system_instructions,
            input,
            model_settings,
            tools,
            output_schema,
            handoffs,
            tracing,
            previous_response_id=previous_response_id,
            **kwargs,
        )

        # Persisting to the cache must never take down the primary agent run.
        # If Valkey is unreachable (or the store otherwise fails), log and return
        # the live response — same fail-open convention llm_cache._inc_stats uses.
        try:
            store_blocks = _extract_blocks(response)
            usage = getattr(response, "usage", None)
            inp = int(getattr(usage, "input_tokens", 0) or 0)
            out_tok = int(getattr(usage, "output_tokens", 0) or 0)
            await self._cache.llm.store_multipart(
                params,
                store_blocks,
                LlmStoreOptions(tokens={"input": inp, "output": out_tok}),
            )
        except ValkeyCommandError as exc:
            _LOGGER.warning("agent-cache store failed; returning live response: %s", exc)
        except Exception as exc:  # defensive: store must fail open, never crash the run
            _LOGGER.warning("agent-cache store errored unexpectedly: %s", exc)

        return response


class CachedModelProvider:
    """Wraps a ``ModelProvider`` so every ``Model`` it returns is cache-enabled.

    This is the recommended integration point::

        from agents import RunConfig, Runner
        from betterdb_agent_cache.adapters.openai_agents import CachedModelProvider

        provider = CachedModelProvider(original_provider, cache=agent_cache)
        result = await Runner.run(agent, "hi", run_config=RunConfig(model_provider=provider))
    """

    def __init__(
        self,
        provider: Any,
        cache: "AgentCache",
        opts: OpenAIAgentsPrepareOptions | None = None,
    ) -> None:
        self._provider = provider
        self._cache = cache
        self._opts = opts or OpenAIAgentsPrepareOptions()

    def get_model(self, model_name: str | None) -> CachedModel:
        base = self._provider.get_model(model_name)
        return CachedModel(base, self._cache, self._opts)

    async def aclose(self) -> None:
        if hasattr(self._provider, "aclose"):
            await self._provider.aclose()
