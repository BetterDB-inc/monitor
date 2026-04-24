"""Tests for advanced features: rerank, stale model, batch, threshold effectiveness."""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from betterdb_semantic_cache.semantic_cache import SemanticCache
from betterdb_semantic_cache.types import (
    CacheCheckOptions,
    CacheStoreOptions,
    EmbeddingCacheOptions,
    RerankOptions,
    SemanticCacheOptions,
    TelemetryOptions,
)

from .conftest import _ft_info_response, _ft_search_hit, _ft_search_miss, make_client, make_telemetry


def _make_cache(**kwargs) -> tuple[SemanticCache, MagicMock]:
    client = make_client(**kwargs)
    embed_fn = AsyncMock(return_value=[0.5, 0.5])
    opts = SemanticCacheOptions(
        client=client,
        embed_fn=embed_fn,
        name="feat",
        default_threshold=0.1,
        uncertainty_band=0.05,
        embedding_cache=EmbeddingCacheOptions(enabled=False),
        telemetry=TelemetryOptions(tracer_name="t", metrics_prefix="sc_feat"),
        use_default_cost_table=False,
    )
    cache = SemanticCache(opts)
    cache._telemetry = make_telemetry()
    return cache, client


# ── invalidate_by_model / invalidate_by_category ─────────────────────────────

@pytest.mark.asyncio
async def test_invalidate_by_model_calls_ft_search_with_model_filter():
    cache, client = _make_cache()
    await cache.initialize()
    count = await cache.invalidate_by_model("gpt-4o")
    assert count == 0  # mock returns empty
    search_calls = [
        c for c in client.execute_command.call_args_list
        if c.args and c.args[0] == "FT.SEARCH"
    ]
    # args: ("FT.SEARCH", index_name, filter, ...)  — filter is at index 2
    assert any("@model:" in str(c.args[2]) for c in search_calls)


@pytest.mark.asyncio
async def test_invalidate_by_category_calls_ft_search_with_category_filter():
    cache, client = _make_cache()
    await cache.initialize()
    await cache.invalidate_by_category("geography")
    search_calls = [
        c for c in client.execute_command.call_args_list
        if c.args and c.args[0] == "FT.SEARCH"
    ]
    assert any("@category:" in str(c.args[2]) for c in search_calls)
    assert any("geography" in str(c.args[2]) for c in search_calls)


# ── stale_after_model_change ──────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_stale_model_evicts_entry_when_model_differs():
    cache, client = _make_cache()
    await cache.initialize()

    def _execute(cmd, *args):
        if cmd == "FT.INFO":
            return _ft_info_response(2)
        if cmd == "FT.SEARCH":
            return _ft_search_hit(
                "feat:entry:stale",
                {"response": "Old answer", "model": "gpt-4o", "category": "", "__score": "0.01"},
            )
        return None

    client.execute_command = AsyncMock(side_effect=lambda *a: _execute(*a))
    result = await cache.check(
        "hello",
        CacheCheckOptions(stale_after_model_change=True, current_model="gpt-4o-mini"),
    )
    assert result.hit is False
    client.delete.assert_awaited()


@pytest.mark.asyncio
async def test_stale_model_returns_hit_when_model_matches():
    cache, client = _make_cache()
    await cache.initialize()

    def _execute(cmd, *args):
        if cmd == "FT.INFO":
            return _ft_info_response(2)
        if cmd == "FT.SEARCH":
            return _ft_search_hit(
                "feat:entry:ok",
                {"response": "Answer", "model": "gpt-4o", "category": "", "__score": "0.01"},
            )
        return None

    client.execute_command = AsyncMock(side_effect=lambda *a: _execute(*a))
    result = await cache.check(
        "hello",
        CacheCheckOptions(stale_after_model_change=True, current_model="gpt-4o"),
    )
    assert result.hit is True
    assert result.response == "Answer"


# ── rerank ────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_rerank_picks_non_first_candidate():
    cache, client = _make_cache()
    await cache.initialize()

    def _execute(cmd, *args):
        if cmd == "FT.INFO":
            return _ft_info_response(2)
        if cmd == "FT.SEARCH":
            return [
                "3",
                "key1", ["response", "Short", "model", "", "category", "", "__score", "0.01"],
                "key2", ["response", "Medium answer", "model", "", "category", "", "__score", "0.02"],
                "key3", ["response", "The longest and most detailed answer", "model", "", "category", "", "__score", "0.03"],
            ]
        return None

    client.execute_command = AsyncMock(side_effect=lambda *a: _execute(*a))

    async def _rerank_longest(_query: str, candidates: list) -> int:
        return max(range(len(candidates)), key=lambda i: len(candidates[i]["response"]))

    result = await cache.check(
        "hello",
        CacheCheckOptions(rerank=RerankOptions(k=3, rerank_fn=_rerank_longest)),
    )
    assert result.hit is True
    assert result.response == "The longest and most detailed answer"


@pytest.mark.asyncio
async def test_rerank_returning_minus_one_yields_miss():
    cache, client = _make_cache(
        search_result={"key": "feat:entry:abc", "fields": {"response": "Answer", "model": "", "category": ""}},
    )
    await cache.initialize()

    async def _rerank_reject(_query: str, _candidates: list) -> int:
        return -1

    result = await cache.check(
        "hello",
        CacheCheckOptions(rerank=RerankOptions(k=1, rerank_fn=_rerank_reject)),
    )
    assert result.hit is False
    assert result.confidence == "miss"


# ── params-aware filtering ────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_store_with_params_fields():
    cache, client = _make_cache()
    await cache.initialize()
    await cache.store("hello", "world", CacheStoreOptions(temperature=0.7, top_p=0.9, seed=42))
    mapping = client.hset.call_args.kwargs.get("mapping") or client.hset.call_args.args[1]
    assert mapping["temperature"] == "0.7"
    assert mapping["top_p"] == "0.9"
    assert mapping["seed"] == "42"


@pytest.mark.asyncio
async def test_store_without_params_fields_not_set():
    cache, client = _make_cache()
    await cache.initialize()
    await cache.store("hello", "world")
    mapping = client.hset.call_args.kwargs.get("mapping") or client.hset.call_args.args[1]
    assert "temperature" not in mapping
    assert "top_p" not in mapping
    assert "seed" not in mapping


# ── check_batch ───────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_check_batch_empty_input():
    cache, _ = _make_cache()
    await cache.initialize()
    results = await cache.check_batch([])
    assert results == []


@pytest.mark.asyncio
async def test_check_batch_returns_results_in_order():
    cache, client = _make_cache()
    await cache.initialize()

    pipe = client.pipeline()
    pipe.execute = AsyncMock(return_value=[
        ["1", "key1", ["response", "Answer 1", "__score", "0.01"]],
        ["0"],
        ["1", "key3", ["response", "Answer 3", "__score", "0.02"]],
    ])

    results = await cache.check_batch(["prompt1", "prompt2", "prompt3"])
    assert len(results) == 3
    assert results[0].hit is True
    assert results[0].response == "Answer 1"
    assert results[1].hit is False
    assert results[2].hit is True
    assert results[2].response == "Answer 3"


# ── threshold_effectiveness ───────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_threshold_effectiveness_insufficient_data():
    cache, _ = _make_cache()
    await cache.initialize()
    result = await cache.threshold_effectiveness(min_samples=100)
    assert result.recommendation == "insufficient_data"
    assert result.sample_count == 0


@pytest.mark.asyncio
async def test_threshold_effectiveness_tighten_threshold():
    cache, client = _make_cache()
    await cache.initialize()

    threshold = 0.1
    band = 0.05
    entries = [
        json.dumps({"score": threshold - band * 0.5, "result": "hit", "category": ""})
        for _ in range(120)
    ] + [
        json.dumps({"score": 0.02, "result": "hit", "category": ""})
        for _ in range(10)
    ]
    client.zrange = AsyncMock(return_value=[e.encode() for e in entries])

    result = await cache.threshold_effectiveness(min_samples=100)
    assert result.recommendation == "tighten_threshold"
    assert result.recommended_threshold is not None
    assert result.recommended_threshold < threshold


@pytest.mark.asyncio
async def test_threshold_effectiveness_loosen_threshold():
    cache, client = _make_cache()
    await cache.initialize()

    threshold = 0.1
    entries = [
        json.dumps({"score": threshold + 0.01, "result": "miss", "category": ""})
        for _ in range(80)
    ] + [
        json.dumps({"score": 0.02, "result": "hit", "category": ""})
        for _ in range(40)
    ]
    client.zrange = AsyncMock(return_value=[e.encode() for e in entries])

    result = await cache.threshold_effectiveness(min_samples=100)
    assert result.recommendation == "loosen_threshold"
    assert result.recommended_threshold is not None
    assert result.recommended_threshold > threshold


@pytest.mark.asyncio
async def test_threshold_effectiveness_optimal():
    cache, client = _make_cache()
    await cache.initialize()

    threshold = 0.1
    entries = [
        json.dumps({"score": 0.03, "result": "hit", "category": ""})
        for _ in range(80)
    ] + [
        json.dumps({"score": 0.5, "result": "miss", "category": ""})
        for _ in range(40)
    ]
    client.zrange = AsyncMock(return_value=[e.encode() for e in entries])

    result = await cache.threshold_effectiveness(min_samples=100)
    assert result.recommendation == "optimal"
    assert result.hit_rate > 0.5
