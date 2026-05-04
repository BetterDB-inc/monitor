"""Tests for SemanticCache periodic config refresh (refresh_config / _config_refresh_loop)."""
from __future__ import annotations

import asyncio
import math
from unittest.mock import AsyncMock, MagicMock

import pytest

from betterdb_semantic_cache.semantic_cache import SemanticCache
from betterdb_semantic_cache.types import (
    ConfigRefreshOptions,
    EmbeddingCacheOptions,
    SemanticCacheOptions,
)

from .conftest import make_client


# ── Helpers ───────────────────────────────────────────────────────────────────

async def _embed(_: str) -> list[float]:
    return [0.1, 0.2]


def _make_cache(
    *,
    config: dict | None = None,
    default_threshold: float = 0.10,
    category_thresholds: dict | None = None,
    enabled: bool = True,
    interval_ms: int = 5_000,
) -> tuple[SemanticCache, MagicMock]:
    """Return a SemanticCache (not yet initialized) + its mock client."""
    client = make_client()
    # hgetall returns the __config store; all other calls return {}
    config_store: dict = config or {}

    async def hgetall_side_effect(key: str):
        if key.endswith(":__config"):
            return {k.encode(): v.encode() for k, v in config_store.items()}
        return {}

    client.hgetall = AsyncMock(side_effect=hgetall_side_effect)

    options = SemanticCacheOptions(
        client=client,
        embed_fn=_embed,
        name="test_sc",
        default_threshold=default_threshold,
        category_thresholds=category_thresholds or {},
        embedding_cache=EmbeddingCacheOptions(enabled=False),
        config_refresh=ConfigRefreshOptions(enabled=enabled, interval_ms=interval_ms),
    )
    return SemanticCache(options), client


# ── refresh_config() unit tests ───────────────────────────────────────────────

@pytest.mark.asyncio
async def test_refresh_config_updates_default_threshold():
    cache, client = _make_cache(config={"threshold": "0.05"})
    await cache.initialize()

    ok = await cache.refresh_config()

    assert ok is True
    assert cache._default_threshold == pytest.approx(0.05)


@pytest.mark.asyncio
async def test_refresh_config_updates_category_threshold():
    cache, client = _make_cache(config={"threshold:faq": "0.07"})
    await cache.initialize()

    await cache.refresh_config()

    assert cache._category_thresholds.get("faq") == pytest.approx(0.07)


@pytest.mark.asyncio
async def test_refresh_config_falls_back_to_constructor_when_field_absent():
    cache, client = _make_cache(config={}, default_threshold=0.15,
                                category_thresholds={"faq": 0.08})
    await cache.initialize()

    await cache.refresh_config()

    assert cache._default_threshold == pytest.approx(0.15)
    assert cache._category_thresholds.get("faq") == pytest.approx(0.08)


@pytest.mark.asyncio
async def test_refresh_config_removes_category_absent_from_hash():
    """Category in memory but absent from hash falls back to constructor value."""
    cache, client = _make_cache(
        config={"threshold:faq": "0.07"},
        category_thresholds={},  # no constructor override for faq
    )
    await cache.initialize()
    await cache.refresh_config()
    assert cache._category_thresholds.get("faq") == pytest.approx(0.07)

    # Simulate HDEL — next refresh returns no category field
    async def hgetall_empty(_):
        return {}

    client.hgetall = AsyncMock(side_effect=hgetall_empty)
    await cache.refresh_config()
    assert "faq" not in cache._category_thresholds


@pytest.mark.asyncio
async def test_refresh_config_ignores_non_numeric_values():
    cache, client = _make_cache(config={"threshold": "not_a_number"}, default_threshold=0.20)
    await cache.initialize()

    await cache.refresh_config()

    assert cache._default_threshold == pytest.approx(0.20)


@pytest.mark.asyncio
async def test_refresh_config_ignores_out_of_range_values():
    cache, client = _make_cache(
        config={"threshold": "-0.1", "threshold:faq": "2.5"},
        default_threshold=0.20,
        category_thresholds={"faq": 0.10},
    )
    await cache.initialize()

    await cache.refresh_config()

    assert cache._default_threshold == pytest.approx(0.20)
    assert cache._category_thresholds.get("faq") == pytest.approx(0.10)


@pytest.mark.asyncio
async def test_refresh_config_ignores_empty_category_suffix():
    """'threshold:' with an empty category name is ignored."""
    cache, client = _make_cache(config={"threshold:": "0.05"}, default_threshold=0.20)
    await cache.initialize()

    await cache.refresh_config()

    assert cache._default_threshold == pytest.approx(0.20)


@pytest.mark.asyncio
async def test_refresh_config_returns_false_on_hgetall_error():
    cache, client = _make_cache()
    await cache.initialize()
    client.hgetall = AsyncMock(side_effect=Exception("NOAUTH"))

    ok = await cache.refresh_config()

    assert ok is False
    # Threshold unchanged from constructor
    assert cache._default_threshold == pytest.approx(0.10)


# ── Config refresh loop behavior ──────────────────────────────────────────────

@pytest.mark.asyncio
async def test_config_refresh_fires_immediately_on_initialize():
    """First refresh runs before the first sleep (synchronous first tick).

    Uses a long interval so the task blocks in asyncio.sleep after the first
    refresh. We yield to the event loop, let the first refresh complete, then
    cancel the task and assert the threshold was updated.
    """
    cache, _ = _make_cache(config={"threshold": "0.05"}, default_threshold=0.10,
                           interval_ms=30_000)
    await cache.initialize()
    # Give the task enough event-loop turns to complete refresh_config()
    for _ in range(5):
        await asyncio.sleep(0)

    if cache._config_refresh_task:
        cache._config_refresh_task.cancel()
        await asyncio.gather(cache._config_refresh_task, return_exceptions=True)

    assert cache._default_threshold == pytest.approx(0.05)


@pytest.mark.asyncio
async def test_config_refresh_disabled_skips_hgetall_on_config_key():
    cache, client = _make_cache(
        config={"threshold": "0.05"},
        default_threshold=0.10,
        enabled=False,
    )
    await cache.initialize()
    await asyncio.sleep(0)

    config_calls = [
        c for c in client.hgetall.call_args_list
        if ":__config" in str(c)
    ]
    assert len(config_calls) == 0
    assert cache._default_threshold == pytest.approx(0.10)


@pytest.mark.asyncio
async def test_config_refresh_interval_clamped_to_1s_minimum():
    cache, _ = _make_cache(interval_ms=50)
    assert cache._config_refresh_interval_s == 1.0


@pytest.mark.asyncio
async def test_config_refresh_task_cancelled_on_shutdown():
    """shutdown() cancels the background refresh task."""
    cache, _ = _make_cache(interval_ms=30_000)
    await cache.initialize()
    for _ in range(5):
        await asyncio.sleep(0)  # let first refresh run; task now sleeping 30s

    task = cache._config_refresh_task
    assert task is not None
    await cache.shutdown()
    await asyncio.gather(task, return_exceptions=True)

    assert task.cancelled() or task.done()


@pytest.mark.asyncio
async def test_config_refresh_failed_counter_incremented_on_hgetall_error():
    """config_refresh_failed counter bumped when HGETALL raises.

    Uses a custom CollectorRegistry to read the counter value without touching
    the default global registry.
    """
    from prometheus_client import CollectorRegistry, generate_latest
    from betterdb_semantic_cache.types import TelemetryOptions

    registry = CollectorRegistry()

    async def _embed_fn(_: str) -> list[float]:
        return [0.1, 0.2]

    client = make_client()
    client.hgetall = AsyncMock(side_effect=Exception("NOAUTH"))

    cache = SemanticCache(SemanticCacheOptions(
        client=client,
        embed_fn=_embed_fn,
        name="crf_counter",
        embedding_cache=EmbeddingCacheOptions(enabled=False),
        config_refresh=ConfigRefreshOptions(enabled=True, interval_ms=1_000),
        telemetry=TelemetryOptions(registry=registry),
    ))
    await cache.initialize()
    if cache._config_refresh_task:
        cache._config_refresh_task.cancel()
        await asyncio.gather(cache._config_refresh_task, return_exceptions=True)

    # Drive one loop iteration directly
    async def _sleep_once(_):
        raise asyncio.CancelledError

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr("asyncio.sleep", _sleep_once)
        try:
            await cache._config_refresh_loop()
        except asyncio.CancelledError:
            pass

    text = generate_latest(registry).decode()
    counter_lines = [
        line for line in text.splitlines()
        if "config_refresh_failed_total{" in line and not line.startswith("#")
    ]
    assert counter_lines, "config_refresh_failed_total metric not found"
    assert float(counter_lines[0].split()[-1]) >= 1


@pytest.mark.asyncio
async def test_config_refresh_propagates_threshold_change_on_second_tick():
    """Simulates dispatcher write between ticks: second refresh picks up new value."""
    config_store = {"threshold": "0.10"}

    async def _embed_fn(_: str) -> list[float]:
        return [0.1, 0.2]

    client = make_client()

    async def hgetall_side_effect(key: str):
        if key.endswith(":__config"):
            return {k.encode(): v.encode() for k, v in config_store.items()}
        return {}

    client.hgetall = AsyncMock(side_effect=hgetall_side_effect)

    cache = SemanticCache(SemanticCacheOptions(
        client=client,
        embed_fn=_embed_fn,
        name="prop_test",
        default_threshold=0.25,
        embedding_cache=EmbeddingCacheOptions(enabled=False),
        config_refresh=ConfigRefreshOptions(enabled=True, interval_ms=30_000),
    ))
    await cache.initialize()
    # Yield enough event-loop turns for the first refresh to complete
    for _ in range(5):
        await asyncio.sleep(0)

    assert cache._default_threshold == pytest.approx(0.10)

    # Simulate dispatcher write (Monitor approved a proposal)
    config_store["threshold"] = "0.05"

    # Drive second refresh directly
    await cache.refresh_config()

    assert cache._default_threshold == pytest.approx(0.05)

    if cache._config_refresh_task:
        cache._config_refresh_task.cancel()
        await asyncio.gather(cache._config_refresh_task, return_exceptions=True)
