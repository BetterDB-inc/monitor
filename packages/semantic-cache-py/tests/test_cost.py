"""Unit tests for cost tracking."""
from __future__ import annotations

import json
from unittest.mock import AsyncMock

import pytest

from betterdb_semantic_cache.semantic_cache import SemanticCache
from betterdb_semantic_cache.types import (
    CacheStoreOptions,
    EmbeddingCacheOptions,
    ModelCost,
    SemanticCacheOptions,
    TelemetryOptions,
)

from .conftest import _ft_search_hit, _ft_info_response, make_client, make_telemetry


def _make_cache_with_cost(cost_table: dict) -> tuple[SemanticCache, object]:
    client = make_client()
    embed_fn = AsyncMock(return_value=[0.5, 0.5])
    opts = SemanticCacheOptions(
        client=client,
        embed_fn=embed_fn,
        name="costtest",
        use_default_cost_table=False,
        cost_table=cost_table,
        embedding_cache=EmbeddingCacheOptions(enabled=False),
        telemetry=TelemetryOptions(tracer_name="t", metrics_prefix="sc_test"),
    )
    cache = SemanticCache(opts)
    cache._telemetry = make_telemetry()
    return cache, client


@pytest.mark.asyncio
async def test_store_computes_cost_micros():
    cost_table = {"gpt-4o": ModelCost(input_per_1k=0.005, output_per_1k=0.015)}
    cache, client = _make_cache_with_cost(cost_table)
    await cache.initialize()

    await cache.store(
        "hello", "world",
        CacheStoreOptions(model="gpt-4o", input_tokens=100, output_tokens=200),
    )

    mapping = client.hset.call_args.kwargs.get("mapping") or client.hset.call_args.args[1]
    cost_micros = int(mapping["cost_micros"])
    expected = round(
        (100 * 0.005 / 1000 + 200 * 0.015 / 1000) * 1_000_000
    )
    assert cost_micros == expected


@pytest.mark.asyncio
async def test_check_reports_cost_saved_on_hit():
    cost_table = {"gpt-4o": ModelCost(input_per_1k=0.005, output_per_1k=0.015)}
    cache, client = _make_cache_with_cost(cost_table)
    await cache.initialize()

    def _execute(cmd, *args):
        if cmd == "FT.INFO":
            return _ft_info_response(2)
        if cmd == "FT.SEARCH":
            return _ft_search_hit(
                "costtest:entry:abc",
                {"response": "world", "model": "gpt-4o", "category": "",
                 "cost_micros": "4000", "__score": "0.01"},
            )
        return None

    client.execute_command = AsyncMock(side_effect=lambda *a: _execute(*a))
    result = await cache.check("hello")
    assert result.hit is True
    assert result.cost_saved == pytest.approx(4000 / 1_000_000)


@pytest.mark.asyncio
async def test_use_default_cost_table_false_no_cost():
    cache, client = _make_cache_with_cost({})
    await cache.initialize()

    await cache.store(
        "hello", "world",
        CacheStoreOptions(model="gpt-4o", input_tokens=100, output_tokens=200),
    )

    mapping = client.hset.call_args.kwargs.get("mapping") or client.hset.call_args.args[1]
    assert "cost_micros" not in mapping


@pytest.mark.asyncio
async def test_use_default_cost_table_true_computes_cost():
    client = make_client()
    embed_fn = AsyncMock(return_value=[0.5, 0.5])
    opts = SemanticCacheOptions(
        client=client,
        embed_fn=embed_fn,
        name="costtest2",
        use_default_cost_table=True,
        embedding_cache=EmbeddingCacheOptions(enabled=False),
        telemetry=TelemetryOptions(tracer_name="t", metrics_prefix="sc_t2"),
    )
    cache = SemanticCache(opts)
    cache._telemetry = make_telemetry()
    await cache.initialize()

    await cache.store(
        "hello", "world",
        CacheStoreOptions(model="gpt-4o", input_tokens=100, output_tokens=100),
    )

    mapping = client.hset.call_args.kwargs.get("mapping") or client.hset.call_args.args[1]
    # gpt-4o is in the default cost table
    assert "cost_micros" in mapping
    assert int(mapping["cost_micros"]) > 0
