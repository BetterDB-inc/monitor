"""LangChain cache adapter.

Implements LangChain's ``BaseCache`` interface backed by the AgentCache LLM tier.

Usage::

    from langchain_openai import ChatOpenAI
    from betterdb_agent_cache.adapters.langchain import BetterDBLlmCache

    lc_cache = BetterDBLlmCache(cache=agent_cache)
    llm = ChatOpenAI(model="gpt-4o", cache=lc_cache)
"""
from __future__ import annotations

import json
import re
from typing import TYPE_CHECKING, Any, Optional, Sequence

try:
    from langchain_core.caches import BaseCache
    from langchain_core.messages import AIMessage
    from langchain_core.outputs import ChatGeneration, Generation
    _LANGCHAIN_AVAILABLE = True
except ImportError:
    _LANGCHAIN_AVAILABLE = False
    BaseCache = object  # type: ignore[assignment,misc]
    Generation = Any  # type: ignore[misc,assignment]
    ChatGeneration = Any  # type: ignore[misc,assignment]

if TYPE_CHECKING:
    from ..agent_cache import AgentCache


_MODEL_NAME_RE = re.compile(r'\bmodel_name:"([^"]+)"')


def _extract_model_name(llm_string: str) -> str:
    """Extract a model name from LangChain's serialised llm_string.

    Handles two formats:
    - Comma-separated key:value pairs: ``model_name:"gpt-4o-mini",...``
    - LangChain JSON serialisation: ``{"kwargs": {"model_name": "gpt-4o-mini"}, ...}---[...]``
    """
    # Format 1: comma-separated key:"value" pairs (older LangChain / simple cache key)
    match = _MODEL_NAME_RE.search(llm_string)
    if match:
        return match.group(1)

    # Format 2: LangChain JSON serialisation with optional ---[...] suffix
    try:
        json_part = llm_string.split("---")[0].strip()
        parsed = json.loads(json_part)
        # Nested under "kwargs" in LangChain's serialisation format
        kwargs = parsed.get("kwargs", {})
        model = (
            kwargs.get("model_name")
            or kwargs.get("model")
            or parsed.get("model_name")
            or parsed.get("model")
        )
        if model:
            return str(model)
    except (json.JSONDecodeError, TypeError, AttributeError):
        pass

    return llm_string


class BetterDBLlmCache(BaseCache):
    """LangChain ``BaseCache`` implementation backed by AgentCache.

    This cache is async-only. LangChain calls ``alookup`` / ``aupdate`` in
    async pipelines. The synchronous ``lookup`` / ``update`` methods raise
    ``RuntimeError`` — use an async LangChain invocation (``ainvoke`` /
    ``astream``) to avoid hitting them.
    """

    def __init__(self, cache: "AgentCache") -> None:
        if not _LANGCHAIN_AVAILABLE:
            raise ImportError(
                "langchain-core is required for BetterDBLlmCache. "
                "Install it with: pip install betterdb-agent-cache[langchain]"
            )
        super().__init__()
        self._cache = cache

    # ── Async interface (primary) ──────────────────────────────────────────

    async def alookup(
        self, prompt: str, llm_string: str
    ) -> Optional[list[Generation]]:
        result = await self._cache.llm.check({
            "model": _extract_model_name(llm_string),
            "messages": [{"role": "user", "content": prompt}],
        })
        if not result.hit or not result.response:
            return None
        try:
            parsed: list[dict[str, Any]] = json.loads(result.response)
            return [
                ChatGeneration(text=g.get("text", ""), message=AIMessage(g.get("text", "")))
                for g in parsed
            ]
        except (json.JSONDecodeError, TypeError):
            text = result.response
            return [ChatGeneration(text=text, message=AIMessage(text))]

    async def aupdate(
        self, prompt: str, llm_string: str, return_val: Sequence[Any]
    ) -> None:
        if not return_val:
            return
        stripped = [{"text": g.text if hasattr(g, "text") else g.get("text", "")} for g in return_val]
        text = json.dumps(stripped)

        # Extract token counts — try usage_metadata first, fall back to response_metadata
        first = return_val[0] if return_val else None
        tokens = None
        if first is not None:
            msg = getattr(first, "message", None) or (
                first.get("message") if isinstance(first, dict) else None
            )
            if msg is not None:
                # Newer LangChain: AIMessage.usage_metadata = {"input_tokens": N, "output_tokens": M}
                usage = getattr(msg, "usage_metadata", None)
                if isinstance(usage, dict) and usage:
                    inp = usage.get("input_tokens")
                    out = usage.get("output_tokens")
                    if inp is not None and out is not None:
                        tokens = {"input": inp, "output": out}

                # Fallback: AIMessage.response_metadata["token_usage"] = {"prompt_tokens": N, "completion_tokens": M}
                if tokens is None:
                    rm = getattr(msg, "response_metadata", None) or {}
                    tu = rm.get("token_usage") if isinstance(rm, dict) else None
                    if isinstance(tu, dict) and tu:
                        inp = tu.get("prompt_tokens")
                        out = tu.get("completion_tokens")
                        if inp is not None and out is not None:
                            tokens = {"input": inp, "output": out}

        from ..types import LlmStoreOptions
        await self._cache.llm.store(
            {"model": _extract_model_name(llm_string), "messages": [{"role": "user", "content": prompt}]},
            text,
            LlmStoreOptions(tokens=tokens) if tokens else None,
        )

    # ── Sync interface (not supported) ────────────────────────────────────

    def lookup(self, prompt: str, llm_string: str) -> Optional[list[Generation]]:
        raise RuntimeError(
            "BetterDBLlmCache is async-only. "
            "Use an async LangChain invocation (ainvoke / astream)."
        )

    def update(self, prompt: str, llm_string: str, return_val: Sequence[Any]) -> None:
        raise RuntimeError(
            "BetterDBLlmCache is async-only. "
            "Use an async LangChain invocation (ainvoke / astream)."
        )

    def clear(self, **kwargs: Any) -> None:
        raise RuntimeError(
            "BetterDBLlmCache is async-only. Use aclear() instead."
        )

    async def aclear(self, **kwargs: Any) -> None:
        await self._cache.flush()
