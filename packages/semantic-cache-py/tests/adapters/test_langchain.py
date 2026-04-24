"""Tests for the LangChain adapter."""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from betterdb_semantic_cache.adapters.langchain import BetterDBSemanticCache
from betterdb_semantic_cache.types import CacheCheckResult


def _make_mock_cache(*, hit: bool = False, response: str = "cached response") -> MagicMock:
    mock = MagicMock()
    mock.initialize = AsyncMock(return_value=None)
    mock.check = AsyncMock(return_value=CacheCheckResult(
        hit=hit, response=response if hit else None, confidence="high" if hit else "miss"
    ))
    mock.store = AsyncMock(return_value="test:entry:123")
    mock.flush = AsyncMock(return_value=None)
    return mock


@pytest.mark.asyncio
async def test_alookup_returns_none_on_miss():
    try:
        from langchain_core.caches import BaseCache
    except ImportError:
        pytest.skip("langchain-core not installed")

    mock_cache = _make_mock_cache(hit=False)
    lc_cache = BetterDBSemanticCache(mock_cache)
    result = await lc_cache.alookup("hello", "gpt-4o")
    assert result is None


@pytest.mark.asyncio
async def test_alookup_returns_generation_on_hit():
    try:
        from langchain_core.caches import BaseCache
        from langchain_core.outputs import ChatGeneration
    except ImportError:
        pytest.skip("langchain-core not installed")

    mock_cache = _make_mock_cache(hit=True, response="cached answer")
    lc_cache = BetterDBSemanticCache(mock_cache)
    result = await lc_cache.alookup("hello", "gpt-4o")
    assert result is not None
    assert len(result) == 1
    assert result[0].text == "cached answer"


@pytest.mark.asyncio
async def test_aupdate_calls_store():
    try:
        from langchain_core.caches import BaseCache
        from langchain_core.outputs import ChatGeneration
        from langchain_core.messages import AIMessage
    except ImportError:
        pytest.skip("langchain-core not installed")

    mock_cache = _make_mock_cache()
    lc_cache = BetterDBSemanticCache(mock_cache)

    gen = ChatGeneration(text="the answer", message=AIMessage("the answer"))
    await lc_cache.aupdate("hello", "gpt-4o", [gen])
    mock_cache.store.assert_awaited_once()
    args = mock_cache.store.call_args.args
    assert args[0] == "hello"
    assert args[1] == "the answer"


def test_sync_lookup_raises():
    try:
        from langchain_core.caches import BaseCache
    except ImportError:
        pytest.skip("langchain-core not installed")

    mock_cache = _make_mock_cache()
    lc_cache = BetterDBSemanticCache(mock_cache)
    with pytest.raises(RuntimeError, match="async-only"):
        lc_cache.lookup("hello", "gpt-4o")


def test_sync_update_raises():
    try:
        from langchain_core.caches import BaseCache
    except ImportError:
        pytest.skip("langchain-core not installed")

    mock_cache = _make_mock_cache()
    lc_cache = BetterDBSemanticCache(mock_cache)
    with pytest.raises(RuntimeError, match="async-only"):
        lc_cache.update("hello", "gpt-4o", [])


@pytest.mark.asyncio
async def test_filter_by_model_sets_filter():
    try:
        from langchain_core.caches import BaseCache
    except ImportError:
        pytest.skip("langchain-core not installed")

    mock_cache = _make_mock_cache(hit=False)
    lc_cache = BetterDBSemanticCache(mock_cache, filter_by_model=True)
    await lc_cache.alookup("hello", "my-llm-config")
    opts = mock_cache.check.call_args.args[1]
    assert opts.filter is not None
    assert "@model:" in opts.filter
