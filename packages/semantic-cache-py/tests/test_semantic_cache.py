"""Unit tests for SemanticCache core operations."""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from betterdb_semantic_cache.errors import (
    EmbeddingError,
    SemanticCacheUsageError,
    ValkeyCommandError,
)
from betterdb_semantic_cache.semantic_cache import SemanticCache
from betterdb_semantic_cache.types import (
    CacheCheckOptions,
    CacheStoreOptions,
    EmbeddingCacheOptions,
    SemanticCacheOptions,
    TelemetryOptions,
)

from .conftest import _ft_info_response, _ft_search_hit, _ft_search_miss, make_client, make_telemetry


def _make_cache(
    *,
    search_result: dict | None = None,
    default_threshold: float = 0.1,
    default_ttl: int | None = None,
    uncertainty_band: float = 0.05,
    embedding_cache_enabled: bool = False,
    use_default_cost_table: bool = True,
    cost_table: dict | None = None,
) -> tuple[SemanticCache, MagicMock]:
    client = make_client(search_result=search_result)
    embed_fn = AsyncMock(return_value=[0.5, 0.5])

    opts = SemanticCacheOptions(
        client=client,
        embed_fn=embed_fn,
        name="test",
        default_threshold=default_threshold,
        default_ttl=default_ttl,
        uncertainty_band=uncertainty_band,
        embedding_cache=EmbeddingCacheOptions(enabled=embedding_cache_enabled),
        telemetry=TelemetryOptions(tracer_name="test", metrics_prefix="test_sc"),
        use_default_cost_table=use_default_cost_table,
        cost_table=cost_table or {},
    )
    cache = SemanticCache(opts)

    # Inject mock telemetry
    cache._telemetry = make_telemetry()
    return cache, client


# ── initialize ───────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_initialize_reads_existing_index():
    cache, client = _make_cache()
    await cache.initialize()
    assert cache._initialized is True
    assert cache._dimension == 2


@pytest.mark.asyncio
async def test_initialize_creates_index_when_not_found():
    cache, client = _make_cache()
    # Make FT.INFO raise "unknown index name"
    def _execute(cmd, *args):
        if cmd == "FT.INFO":
            raise Exception("unknown index name")
        if cmd == "FT.CREATE":
            return "OK"
        return None
    client.execute_command = AsyncMock(side_effect=lambda *a: _execute(*a))
    await cache.initialize()
    assert cache._initialized is True


@pytest.mark.asyncio
async def test_initialize_raises_on_valkey_error():
    cache, client = _make_cache()
    client.execute_command = AsyncMock(side_effect=Exception("connection refused"))
    with pytest.raises(ValkeyCommandError, match="FT.INFO"):
        await cache.initialize()


@pytest.mark.asyncio
async def test_check_before_initialize_raises():
    cache, _ = _make_cache()
    with pytest.raises(SemanticCacheUsageError, match="initialize"):
        await cache.check("hello")


# ── check ────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_check_returns_miss_when_no_results():
    cache, _ = _make_cache()
    await cache.initialize()
    result = await cache.check("hello")
    assert result.hit is False
    assert result.confidence == "miss"


@pytest.mark.asyncio
async def test_check_returns_hit_when_score_below_threshold():
    cache, _ = _make_cache(
        search_result={"key": "test:entry:abc", "fields": {"response": "world", "model": "", "category": ""}},
        default_threshold=0.1,
    )
    await cache.initialize()
    result = await cache.check("hello")
    assert result.hit is True
    assert result.response == "world"
    assert result.similarity == pytest.approx(0.01)


@pytest.mark.asyncio
async def test_check_returns_miss_when_score_above_threshold():
    cache, client = _make_cache(default_threshold=0.005)
    await cache.initialize()
    # Score is 0.01, threshold is 0.005 → miss
    result = await cache.check("hello")
    assert result.hit is False


@pytest.mark.asyncio
async def test_check_raises_on_ft_search_error():
    cache, client = _make_cache()
    await cache.initialize()

    def _execute(cmd, *args):
        if cmd == "FT.INFO":
            return _ft_info_response(2)
        if cmd == "FT.SEARCH":
            raise Exception("search error")
        return None

    client.execute_command = AsyncMock(side_effect=lambda *a: _execute(*a))
    with pytest.raises(ValkeyCommandError, match="FT.SEARCH"):
        await cache.check("hello")


@pytest.mark.asyncio
async def test_check_high_confidence_below_uncertainty_band():
    # Score = 0.01, threshold = 0.1, band = 0.05 → score < 0.1 - 0.05 = 0.05 → high
    cache, _ = _make_cache(
        search_result={"key": "test:entry:abc", "fields": {"response": "r", "model": "", "category": ""}},
        default_threshold=0.1,
        uncertainty_band=0.05,
    )
    await cache.initialize()
    result = await cache.check("hello")
    assert result.hit is True
    assert result.confidence == "high"


@pytest.mark.asyncio
async def test_check_uncertain_within_band():
    # Score = 0.09, threshold = 0.1, band = 0.05 → score in [0.05, 0.1] → uncertain
    cache, client = _make_cache(
        default_threshold=0.1,
        uncertainty_band=0.05,
    )
    await cache.initialize()

    def _execute(cmd, *args):
        if cmd == "FT.INFO":
            return _ft_info_response(2)
        if cmd == "FT.SEARCH":
            return _ft_search_hit(
                "test:entry:abc",
                {"response": "r", "model": "", "category": "", "__score": "0.09"},
            )
        return None

    client.execute_command = AsyncMock(side_effect=lambda *a: _execute(*a))
    result = await cache.check("hello")
    assert result.hit is True
    assert result.confidence == "uncertain"


@pytest.mark.asyncio
async def test_check_nearest_miss_populated_on_miss():
    # Score 0.01 > threshold 0.005 → miss, but nearest_miss should be populated
    cache, client = _make_cache(
        search_result={"key": "test:entry:abc",
                       "fields": {"response": "r", "model": "", "category": ""}},
        default_threshold=0.005,
    )
    await cache.initialize()
    result = await cache.check("hello")
    assert result.hit is False
    assert result.nearest_miss is not None
    assert result.nearest_miss.similarity == pytest.approx(0.01)


# ── store ────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_store_sets_hash_fields():
    cache, client = _make_cache()
    await cache.initialize()
    key = await cache.store("hello", "world")
    assert key.startswith("test:entry:")
    client.hset.assert_awaited_once()
    mapping = client.hset.call_args.kwargs.get("mapping") or client.hset.call_args.args[1]
    assert mapping["prompt"] == "hello"
    assert mapping["response"] == "world"


@pytest.mark.asyncio
async def test_store_applies_ttl():
    cache, client = _make_cache(default_ttl=3600)
    await cache.initialize()
    await cache.store("hello", "world")
    client.expire.assert_awaited()
    assert client.expire.call_args.args[1] == 3600


@pytest.mark.asyncio
async def test_store_per_call_ttl_overrides_default():
    cache, client = _make_cache(default_ttl=3600)
    await cache.initialize()
    await cache.store("hello", "world", CacheStoreOptions(ttl=60))
    assert client.expire.call_args.args[1] == 60


@pytest.mark.asyncio
async def test_store_stores_temperature_top_p_seed():
    cache, client = _make_cache()
    await cache.initialize()
    await cache.store("hello", "world", CacheStoreOptions(temperature=0.7, top_p=0.9, seed=42))
    mapping = client.hset.call_args.kwargs.get("mapping") or client.hset.call_args.args[1]
    assert mapping["temperature"] == "0.7"
    assert mapping["top_p"] == "0.9"
    assert mapping["seed"] == "42"


@pytest.mark.asyncio
async def test_store_raises_on_hset_error():
    cache, client = _make_cache()
    await cache.initialize()
    client.hset = AsyncMock(side_effect=Exception("write error"))
    with pytest.raises(ValkeyCommandError, match="HSET"):
        await cache.store("hello", "world")


# ── store_multipart ───────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_store_multipart_stores_content_blocks():
    cache, client = _make_cache()
    await cache.initialize()
    blocks = [{"type": "text", "text": "Hello"}, {"type": "text", "text": "World"}]
    await cache.store_multipart("hello", blocks)
    mapping = client.hset.call_args.kwargs.get("mapping") or client.hset.call_args.args[1]
    assert mapping["response"] == "Hello World"
    stored_blocks = json.loads(mapping["content_blocks"])
    assert stored_blocks == blocks


# ── stats ─────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_stats_returns_zero_when_empty():
    cache, _ = _make_cache()
    await cache.initialize()
    stats = await cache.stats()
    assert stats.hits == 0
    assert stats.misses == 0
    assert stats.total == 0
    assert stats.hit_rate == 0.0


@pytest.mark.asyncio
async def test_stats_parses_values():
    cache, client = _make_cache()
    await cache.initialize()
    client.hgetall = AsyncMock(return_value={
        b"hits": b"10", b"misses": b"5", b"total": b"15", b"cost_saved_micros": b"500"
    })
    stats = await cache.stats()
    assert stats.hits == 10
    assert stats.misses == 5
    assert stats.total == 15
    assert stats.hit_rate == pytest.approx(10 / 15)
    assert stats.cost_saved_micros == 500


# ── flush ─────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_flush_marks_uninitialized():
    cache, _ = _make_cache()
    await cache.initialize()
    assert cache._initialized is True
    await cache.flush()
    assert cache._initialized is False


@pytest.mark.asyncio
async def test_flush_drops_index_and_deletes_keys():
    cache, client = _make_cache()
    await cache.initialize()
    await cache.flush()
    drop_calls = [
        c for c in client.execute_command.call_args_list
        if c.args and c.args[0] == "FT.DROPINDEX"
    ]
    assert len(drop_calls) == 1
