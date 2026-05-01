"""Pydantic AI adapter.

Wraps any Pydantic AI ``Model`` with an exact-match LLM cache. Cache is
consulted before each ``request()`` call; on miss the underlying model is
invoked and the response is stored.

Usage::

    from pydantic_ai import Agent
    from pydantic_ai.models.openai import OpenAIModel
    from betterdb_agent_cache.adapters.pydantic_ai import CachedModel

    base_model = OpenAIModel("gpt-4o")
    cached_model = CachedModel(base_model, cache=agent_cache)
    agent = Agent(model=cached_model)

Also exposes ``prepare_params`` for users who want to manage caching
manually rather than through the wrapper.

Limitations
~~~~~~~~~~~
* **Binary / multimodal content** in ``UserPromptPart`` (``ImageUrl``,
  ``BinaryContent``) is JSON-serialised raw via ``_to_text()``.  A follow-up
  can add explicit normalizer dispatch matching ``openai.py``.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from ..normalizer import BinaryNormalizer, default_normalizer
from ..types import ContentBlock, LlmCacheParams, LlmStoreOptions
from ..utils import parse_tool_call_args

if TYPE_CHECKING:
    from ..agent_cache import AgentCache


@dataclass
class PydanticAIPrepareOptions:
    normalizer: BinaryNormalizer = field(default_factory=lambda: default_normalizer)


def _to_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def _normalize_model_settings(model_settings: Any | None) -> dict[str, Any]:
    if model_settings is None:
        return {}
    if isinstance(model_settings, dict):
        return model_settings
    if hasattr(model_settings, "model_dump"):
        dumped = model_settings.model_dump(exclude_none=True)
        if isinstance(dumped, dict):
            return dumped
    return {}


async def _normalize_user_content(
    content: Any,
    normalizer: BinaryNormalizer,
) -> list[ContentBlock]:
    """Reduce a ``UserPromptPart.content`` value to canonical content blocks.

    Plain strings become a single text block.  Lists are walked item-by-item;
    binary / image items are passed through *normalizer* so the cache key
    stays compact and stable (matching the pattern in ``openai.py`` and
    ``anthropic.py``).

    .. note::
       Pydantic AI's ``ImageUrl`` and ``BinaryContent`` types are not yet
       handled — they fall through to ``_to_text()`` which JSON-serialises
       them raw.  A follow-up PR can add explicit dispatch once multimodal
       Pydantic AI usage is common.
    """
    if isinstance(content, str):
        return [{"type": "text", "text": content}]

    blocks: list[ContentBlock] = []
    for item in content:
        if isinstance(item, str):
            blocks.append({"type": "text", "text": item})
        elif hasattr(item, "content"):
            blocks.append({"type": "text", "text": _to_text(getattr(item, "content"))})
        else:
            blocks.append({"type": "text", "text": _to_text(item)})
    return blocks


async def prepare_params(
    messages: list[Any],
    model_name: str,
    model_settings: Any | None = None,
    opts: PydanticAIPrepareOptions | None = None,
) -> LlmCacheParams:
    """Convert a Pydantic AI message history into canonical ``LlmCacheParams``.

    ``model_settings`` may be ``None``, a plain ``dict``, or any object with
    ``model_dump`` (e.g. Pydantic AI settings); it is normalized the same way
    as :class:`CachedModel` before building cache keys.
    """
    from pydantic_ai.messages import (
        InstructionPart,
        RetryPromptPart,
        SystemPromptPart,
        TextPart,
        ThinkingPart,
        ToolCallPart,
        ToolReturnPart,
        UserPromptPart,
    )

    normalizer = opts.normalizer if opts else default_normalizer
    out: list[Any] = []

    for msg in messages:
        kind = getattr(msg, "kind", None)

        if kind == "request":
            for part in getattr(msg, "parts", []):
                if isinstance(part, (SystemPromptPart, InstructionPart)):
                    out.append({"role": "system", "content": part.content})
                    continue

                if isinstance(part, UserPromptPart):
                    user_blocks = await _normalize_user_content(part.content, normalizer)
                    out.append({"role": "user", "content": user_blocks})
                    continue

                if isinstance(part, ToolReturnPart):
                    out.append({
                        "role": "tool",
                        "toolCallId": part.tool_call_id,
                        "content": [{
                            "type": "tool_result",
                            "toolCallId": part.tool_call_id,
                            "content": [{"type": "text", "text": part.model_response_str()}],
                        }],
                    })
                    continue

                if isinstance(part, RetryPromptPart):
                    out.append({
                        "role": "tool",
                        "toolCallId": part.tool_call_id,
                        "content": [{
                            "type": "tool_result",
                            "toolCallId": part.tool_call_id,
                            "isError": True,
                            "content": [{"type": "text", "text": part.model_response()}],
                        }],
                    })
                    continue

        if kind == "response":
            response_blocks: list[ContentBlock] = []
            for part in getattr(msg, "parts", []):
                if isinstance(part, ThinkingPart):
                    # ThinkingPart dropped — non-deterministic, would break cache determinism.
                    continue
                if isinstance(part, TextPart):
                    response_blocks.append({"type": "text", "text": part.content})
                elif isinstance(part, ToolCallPart):
                    args = part.args
                    parsed_args = parse_tool_call_args(args) if isinstance(args, str) else (args or {})
                    response_blocks.append({
                        "type": "tool_call",
                        "id": part.tool_call_id,
                        "name": part.tool_name,
                        "args": parsed_args,
                    })
            out.append({"role": "assistant", "content": response_blocks})

    result: LlmCacheParams = {"model": model_name, "messages": out}
    settings = _normalize_model_settings(model_settings)
    if settings.get("temperature") is not None:
        result["temperature"] = settings["temperature"]
    if settings.get("top_p") is not None:
        result["top_p"] = settings["top_p"]
    if settings.get("max_tokens") is not None:
        result["max_tokens"] = settings["max_tokens"]
    if settings.get("tools") is not None:
        result["tools"] = settings["tools"]
    if settings.get("tool_choice") is not None:
        result["tool_choice"] = settings["tool_choice"]
    if settings.get("seed") is not None:
        result["seed"] = settings["seed"]
    if settings.get("stop") is not None:
        stop = settings["stop"]
        result["stop"] = [stop] if isinstance(stop, str) else stop
    if settings.get("response_format") is not None:
        result["response_format"] = settings["response_format"]
    if settings.get("reasoning_effort") is not None:
        result["reasoning_effort"] = settings["reasoning_effort"]
    if settings.get("prompt_cache_key") is not None:
        result["prompt_cache_key"] = settings["prompt_cache_key"]

    return result


class CachedModel:
    """Pydantic AI ``Model`` wrapper that checks the cache before each request."""

    def __init__(
        self,
        model: Any,
        cache: "AgentCache",
        opts: PydanticAIPrepareOptions | None = None,
    ) -> None:
        self._model = model
        self._cache = cache
        self._opts = opts or PydanticAIPrepareOptions()

    def __getattr__(self, name: str) -> Any:
        return getattr(self._model, name)

    async def request(
        self,
        messages: list[Any],
        model_settings: Any | None = None,
        model_request_parameters: Any | None = None,
    ) -> Any:
        from pydantic_ai.messages import ModelResponse, TextPart, ThinkingPart, ToolCallPart
        from pydantic_ai.usage import RequestUsage

        model_name = str(getattr(self._model, "model_name", self._model.__class__.__name__))

        # model_request_parameters (tool schemas, result validators) is excluded
        # from the cache key.  This is safe when one CachedModel instance wraps
        # a single Agent whose tools do not change between calls — the typical
        # usage pattern.  If the same CachedModel were shared across Agents with
        # different tool sets, the key would need to incorporate tool schemas.
        params = await prepare_params(messages, model_name, model_settings, self._opts)
        cached = await self._cache.llm.check(params)
        if cached.hit:
            parts = []
            if cached.content_blocks:
                for block in cached.content_blocks:
                    if block["type"] == "text":
                        parts.append(TextPart(content=block["text"]))
                    elif block["type"] == "tool_call":
                        parts.append(ToolCallPart(
                            tool_name=block["name"],
                            args=block.get("args"),
                            tool_call_id=block["id"],
                        ))
            elif cached.response is not None:
                parts.append(TextPart(content=cached.response))
            return ModelResponse(
                parts=parts,
                usage=RequestUsage(input_tokens=0, output_tokens=0),
                model_name=model_name,
            )

        response = await self._model.request(messages, model_settings, model_request_parameters)
        store_blocks: list[ContentBlock] = []
        for part in response.parts:
            if isinstance(part, ThinkingPart):
                # ThinkingPart dropped — non-deterministic, would break cache determinism.
                continue
            if isinstance(part, TextPart):
                store_blocks.append({"type": "text", "text": part.content})
            elif isinstance(part, ToolCallPart):
                args = part.args
                parsed_args = parse_tool_call_args(args) if isinstance(args, str) else (args or {})
                store_blocks.append({
                    "type": "tool_call",
                    "id": part.tool_call_id,
                    "name": part.tool_name,
                    "args": parsed_args,
                })

        usage = getattr(response, "usage", None)
        inp = int(getattr(usage, "input_tokens", 0) or 0)
        out_tok = int(getattr(usage, "output_tokens", 0) or 0)
        await self._cache.llm.store_multipart(
            params,
            store_blocks,
            LlmStoreOptions(tokens={"input": inp, "output": out_tok}),
        )
        return response
