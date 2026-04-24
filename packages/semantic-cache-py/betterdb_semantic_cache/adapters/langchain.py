"""LangChain cache adapter for betterdb-semantic-cache.

Implements LangChain's BaseCache interface backed by SemanticCache.
Async-only — synchronous lookup()/update() raise RuntimeError.

Usage::

    from betterdb_semantic_cache.adapters.langchain import BetterDBSemanticCache
    lc_cache = BetterDBSemanticCache(cache=semantic_cache)
    llm = ChatOpenAI(model="gpt-4o", cache=lc_cache)
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Any, Optional, Sequence

from ..utils import sha256

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
    from ..semantic_cache import SemanticCache


class BetterDBSemanticCache(BaseCache):
    """LangChain BaseCache backed by SemanticCache.

    This cache is async-only. The synchronous ``lookup``/``update`` methods
    raise ``RuntimeError`` — use an async LangChain invocation (``ainvoke`` /
    ``astream``) to avoid hitting them.

    Args:
        cache: A pre-configured SemanticCache instance.
        filter_by_model: When True, cache lookups are scoped to the LLM config.
            Prevents cross-model cache pollution but reduces hit rates.
            Default: False.
    """

    def __init__(self, cache: "SemanticCache", *, filter_by_model: bool = False) -> None:
        if not _LANGCHAIN_AVAILABLE:
            raise ImportError(
                "langchain-core is required for BetterDBSemanticCache. "
                "Install it with: pip install betterdb-semantic-cache[langchain]"
            )
        super().__init__()
        self._cache = cache
        self._filter_by_model = filter_by_model

    async def _ensure_initialized(self) -> None:
        # SemanticCache.initialize() is idempotent (guarded by asyncio.Lock),
        # so calling it directly is safe and avoids the coroutine-reuse bug.
        await self._cache.initialize()

    def _model_hash(self, llm_string: str) -> str:
        return sha256(llm_string)[:16]

    # ── Async interface (primary) ──────────────────────────────────────────

    async def alookup(
        self, prompt: str, llm_string: str
    ) -> Optional[list[Any]]:
        await self._ensure_initialized()
        from ..types import CacheCheckOptions
        opts = CacheCheckOptions()
        if self._filter_by_model:
            opts.filter = f"@model:{{{self._model_hash(llm_string)}}}"
        result = await self._cache.check(prompt, opts)
        if not result.hit or not result.response:
            return None
        return [ChatGeneration(text=result.response, message=AIMessage(result.response))]

    async def aupdate(
        self, prompt: str, llm_string: str, return_val: Sequence[Any]
    ) -> None:
        await self._ensure_initialized()
        text = "".join(
            g.text if hasattr(g, "text") else (g.get("text", "") if isinstance(g, dict) else "")
            for g in return_val
        )
        if not text:
            return
        from ..types import CacheStoreOptions
        await self._cache.store(
            prompt, text,
            CacheStoreOptions(model=self._model_hash(llm_string)),
        )

    # ── Sync interface (not supported) ────────────────────────────────────

    def lookup(self, prompt: str, llm_string: str) -> Optional[list[Any]]:
        raise RuntimeError(
            "BetterDBSemanticCache is async-only. "
            "Use an async LangChain invocation (ainvoke / astream)."
        )

    def update(self, prompt: str, llm_string: str, return_val: Sequence[Any]) -> None:
        raise RuntimeError(
            "BetterDBSemanticCache is async-only. "
            "Use an async LangChain invocation (ainvoke / astream)."
        )

    def clear(self, **kwargs: Any) -> None:
        raise RuntimeError(
            "BetterDBSemanticCache is async-only. Use aclear() instead."
        )

    async def aclear(self, **kwargs: Any) -> None:
        await self._cache.flush()
