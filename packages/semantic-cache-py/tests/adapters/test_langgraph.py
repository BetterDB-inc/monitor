"""Unit tests for the LangGraph BetterDBSemanticStore adapter."""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from betterdb_semantic_cache.adapters.langgraph import BetterDBSemanticStore
from betterdb_semantic_cache.errors import ValkeyCommandError


def _make_store() -> tuple[BetterDBSemanticStore, MagicMock]:
    """Return a BetterDBSemanticStore backed by a minimal mock cache."""
    cache = MagicMock()
    cache.initialize = AsyncMock()
    cache._default_threshold = 0.1
    cache._index_name = "test:idx"
    cache._embed = AsyncMock(return_value=([0.5] * 4, 0.0))
    cache._client = MagicMock()
    cache._client.delete = AsyncMock(return_value=1)
    store = BetterDBSemanticStore(cache)
    return store, cache


def _ft_response(entries: list[tuple[str, str]]) -> list:
    """Build a raw FT.SEARCH-style response from (valkey_key, item_key) pairs."""
    total = len(entries)
    if not total:
        return ["0"]
    result: list = [str(total)]
    for vk, ik in entries:
        item = json.dumps({"key": ik, "namespace": ["ns"], "value": {}, "created_at": "", "updated_at": ""})
        result.extend([vk, ["response", item]])
    return result


# ── adelete multi-page pagination ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_adelete_removes_entries_across_multiple_pages():
    """adelete() must page through all batches and delete all copies of the
    target key, including those that appear beyond the first page.

    Page 0 (100 entries): target key at positions 10 and 50 → 2 deletions.
    Offset advances to 100 - 2 = 98.
    Page 1 (offset 98, 10 entries < BATCH): target key at position 3 → 1 deletion.
    """
    store, cache = _make_store()
    BATCH = store._DELETE_SCAN_BATCH  # 100

    target = "my_key"
    other = "other_key"

    # Page 0: 100 entries, target at index 10 and 50
    page0_pairs = [(f"test:entry:other{i}", other) for i in range(100)]
    page0_pairs[10] = ("test:entry:target0", target)
    page0_pairs[50] = ("test:entry:target1", target)
    page0_response = _ft_response(page0_pairs)

    # Page 1: 10 entries (last page), target at index 3
    page1_pairs = [(f"test:entry:other{i+100}", other) for i in range(10)]
    page1_pairs[3] = ("test:entry:target2", target)
    page1_response = _ft_response(page1_pairs)

    # End of iteration
    end_response = _ft_response([])

    responses = [page0_response, page1_response, end_response]
    call_idx = [0]

    async def mock_search(filter_expr, limit, offset):
        r = responses[min(call_idx[0], len(responses) - 1)]
        call_idx[0] += 1
        return r

    cache._search_entries = AsyncMock(side_effect=mock_search)
    await store.adelete(["ns"], target)

    deleted_keys = [c.args[0] for c in cache._client.delete.call_args_list]
    assert "test:entry:target0" in deleted_keys
    assert "test:entry:target1" in deleted_keys
    assert "test:entry:target2" in deleted_keys
    assert len(deleted_keys) == 3


@pytest.mark.asyncio
async def test_adelete_raises_on_valkey_error():
    """adelete() must propagate ValkeyCommandError rather than silently returning."""
    store, cache = _make_store()
    cache._search_entries = AsyncMock(
        side_effect=ValkeyCommandError("FT.SEARCH", Exception("oops"))
    )
    with pytest.raises(ValkeyCommandError):
        await store.adelete(["ns"], "any_key")


@pytest.mark.asyncio
async def test_adelete_empty_namespace_does_nothing():
    """adelete() on an empty namespace completes without error."""
    store, cache = _make_store()
    cache._search_entries = AsyncMock(return_value=_ft_response([]))
    await store.adelete(["empty_ns"], "missing_key")
    cache._client.delete.assert_not_called()
