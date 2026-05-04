"""OpenAI Agents SDK adapter.

Wraps any Agents SDK ``Model`` with an exact-match LLM cache.  Cache is
consulted before each ``get_response()`` call; on miss the underlying model
is invoked and the response is stored.  ``stream_response()`` is not cached
(streaming responses are not cached by any adapter — documented convention).

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
* ``stream_response()`` is delegated directly — streaming is not cached.
* Binary / multimodal content in input items is JSON-serialised raw via
  ``_to_text()``.  A follow-up can add explicit normalizer dispatch
  matching ``openai.py``.
* ``tools``, ``handoffs``, and ``output_schema`` are excluded from the
  cache key — safe when one CachedModel wraps a single Agent whose tools
  don't change between calls.
"""
from __future__ import annotations

import inspect
import json
from dataclasses import dataclass, field, is_dataclass
from types import SimpleNamespace
from typing import TYPE_CHECKING, Any

from ..normalizer import BinaryNormalizer, default_normalizer
from ..types import ContentBlock, LlmCacheParams, LlmStoreOptions
from ..utils import parse_tool_call_args

if TYPE_CHECKING:
    from ..agent_cache import AgentCache


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
    normalizer: BinaryNormalizer,
) -> dict[str, Any]:  # noqa: ARG001
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
    normalizer = opts.normalizer if opts else default_normalizer

    messages: list[Any] = []

    if system_instructions:
        messages.append({"role": "system", "content": system_instructions})

    if isinstance(input, str):
        messages.append({"role": "user", "content": [{"type": "text", "text": input}]})
    else:
        for item in input:
            messages.append(await _normalize_input_item(item, normalizer))

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
                        id="betterdb-cache",
                        type="message",
                        role="assistant",
                        status="completed",
                        content=text_parts,
                    ),
                )
            except TypeError:
                output.insert(
                    0,
                    ResponseOutputMessage.model_construct(
                        id="betterdb-cache",
                        type="message",
                        role="assistant",
                        content=text_parts,
                    ),
                )
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


class CachedModel:
    """Agents SDK ``Model`` wrapper that checks the cache before each
    ``get_response()`` call.  ``stream_response()`` is delegated directly.
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

    def stream_response(self, *args: Any, **kwargs: Any) -> Any:
        """Streaming is not cached — delegate directly."""
        return self._model.stream_response(*args, **kwargs)

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
        params = await prepare_params(
            system_instructions, input, model_name, model_settings, self._opts,
        )

        cached = await self._cache.llm.check(params)
        if cached.hit:
            output = _rebuild_output(cached.content_blocks, cached.response)
            return _cache_hit_model_response(output, _make_usage(0, 0))

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

        store_blocks = _extract_blocks(response)

        usage = getattr(response, "usage", None)
        inp = int(getattr(usage, "input_tokens", 0) or 0)
        out_tok = int(getattr(usage, "output_tokens", 0) or 0)
        await self._cache.llm.store_multipart(
            params,
            store_blocks,
            LlmStoreOptions(tokens={"input": inp, "output": out_tok}),
        )
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
