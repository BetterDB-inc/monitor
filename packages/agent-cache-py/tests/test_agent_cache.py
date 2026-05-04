"""Unit tests for AgentCache — cost table and config refresh behavior."""
from __future__ import annotations

import asyncio
import json
from unittest.mock import AsyncMock, patch

import pytest

from betterdb_agent_cache import DEFAULT_COST_TABLE
from betterdb_agent_cache.agent_cache import AgentCache
from betterdb_agent_cache.types import AgentCacheOptions, ConfigRefreshOptions, LlmStoreOptions, ModelCost, ToolPolicy

from .conftest import make_client


def _make_cache(**kwargs) -> AgentCache:
    client = make_client()
    options = AgentCacheOptions(client=client, **kwargs)
    with patch("betterdb_agent_cache.agent_cache.create_analytics"):
        return AgentCache(options)


def _params(model: str = "gpt-4o"):
    return {"model": model, "messages": [{"role": "user", "content": "hello"}]}


@pytest.mark.asyncio
async def test_default_cost_table_applies_when_no_cost_table_provided():
    """Default table is active so gpt-4o gets a cost > 0."""
    cache = _make_cache()

    await cache.llm.store(
        _params("gpt-4o"),
        "response text",
        LlmStoreOptions(tokens={"input": 1000, "output": 1000}),
    )

    stored_json = cache.llm._client.set.call_args.args[1]
    entry = json.loads(stored_json)
    assert entry["cost"] > 0


@pytest.mark.asyncio
async def test_user_cost_table_overrides_default_per_model():
    """User-supplied entry wins; cost = (1000/1k)*99 + (1000/1k)*99 = 198."""
    cache = _make_cache(cost_table={"gpt-4o": ModelCost(input_per_1k=99, output_per_1k=99)})

    await cache.llm.store(
        _params("gpt-4o"),
        "response text",
        LlmStoreOptions(tokens={"input": 1000, "output": 1000}),
    )

    stored_json = cache.llm._client.set.call_args.args[1]
    entry = json.loads(stored_json)
    assert entry["cost"] == pytest.approx(198)


@pytest.mark.asyncio
async def test_user_cost_table_does_not_remove_other_default_entries():
    """Overriding gpt-4o keeps gpt-4o-mini in the merged table."""
    assert "gpt-4o-mini" in DEFAULT_COST_TABLE

    cache = _make_cache(cost_table={"gpt-4o": ModelCost(input_per_1k=99, output_per_1k=99)})

    await cache.llm.store(
        _params("gpt-4o-mini"),
        "response text",
        LlmStoreOptions(tokens={"input": 1000, "output": 1000}),
    )

    stored_json = cache.llm._client.set.call_args.args[1]
    entry = json.loads(stored_json)
    assert entry["cost"] > 0


@pytest.mark.asyncio
async def test_use_default_cost_table_false_disables_cost_tracking():
    """No cost field stored when default table is disabled and no user table given."""
    cache = _make_cache(use_default_cost_table=False)

    await cache.llm.store(
        _params("gpt-4o"),
        "response text",
        LlmStoreOptions(tokens={"input": 1000, "output": 1000}),
    )

    stored_json = cache.llm._client.set.call_args.args[1]
    entry = json.loads(stored_json)
    assert "cost" not in entry


# ─── Config refresh ────────────────────────────────────────────────────────────

def _make_refresh_cache(**kwargs) -> AgentCache:
    """Build an AgentCache inside a running event loop with analytics patched out."""
    client = make_client()
    options = AgentCacheOptions(client=client, **kwargs)
    with patch("betterdb_agent_cache.agent_cache.create_analytics"):
        return AgentCache(options)


@pytest.mark.asyncio
async def test_config_refresh_fires_immediately_on_construction():
    """First refresh runs before the first sleep — policies loaded at startup.

    Drives _config_refresh_loop() directly so the sleep mock only applies to
    that coroutine, not to asyncio.sleep(0) calls in the test itself.
    """
    client = make_client()
    client.hgetall = AsyncMock(return_value={
        b"search": json.dumps({"ttl": 300}).encode()
    })

    with patch("betterdb_agent_cache.agent_cache.create_analytics"):
        cache = AgentCache(AgentCacheOptions(
            client=client,
            config_refresh=ConfigRefreshOptions(interval_ms=5_000),
        ))
        # Cancel the auto-started task and drive the loop directly
        if cache._config_refresh_task:
            cache._config_refresh_task.cancel()

    async def _sleep_once(_):
        raise asyncio.CancelledError

    with patch("asyncio.sleep", new=_sleep_once):
        try:
            await cache._config_refresh_loop()
        except asyncio.CancelledError:
            pass

    assert cache.tool.get_policy("search") == ToolPolicy(ttl=300)


@pytest.mark.asyncio
async def test_config_refresh_disabled_skips_hgetall():
    """No HGETALL on __tool_policies when config_refresh.enabled is False."""
    client = make_client()
    client.hgetall = AsyncMock(return_value={})

    with patch("betterdb_agent_cache.agent_cache.create_analytics"):
        cache = AgentCache(AgentCacheOptions(
            client=client,
            config_refresh=ConfigRefreshOptions(enabled=False),
        ))
        await asyncio.sleep(0)

    policy_calls = [
        c for c in client.hgetall.call_args_list
        if "__tool_policies" in str(c)
    ]
    assert len(policy_calls) == 0


@pytest.mark.asyncio
async def test_config_refresh_interval_clamped_to_1s_minimum():
    cache = _make_refresh_cache(
        config_refresh=ConfigRefreshOptions(interval_ms=50)
    )
    assert cache._config_refresh_interval_s == 1.0


@pytest.mark.asyncio
async def test_config_refresh_externally_written_policy_visible_after_refresh():
    """Simulates dispatcher writing a policy then cache picking it up."""
    client = make_client()
    # First call (initial refresh): no policies
    # Second call (after simulated dispatch): policy present
    call_count = 0

    async def hgetall_side_effect(key):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return {}
        return {b"search": json.dumps({"ttl": 600}).encode()}

    client.hgetall = AsyncMock(side_effect=hgetall_side_effect)

    sleep_count = 0
    original_sleep = asyncio.sleep

    async def controlled_sleep(delay):
        nonlocal sleep_count
        sleep_count += 1
        if sleep_count >= 2:
            raise asyncio.CancelledError
        await original_sleep(0)

    with patch("betterdb_agent_cache.agent_cache.create_analytics"):
        with patch("asyncio.sleep", new=controlled_sleep):
            cache = AgentCache(AgentCacheOptions(
                client=client,
                config_refresh=ConfigRefreshOptions(interval_ms=1_000),
            ))
            # Drive the task to completion (cancelled after 2nd sleep)
            try:
                await asyncio.gather(*cache._background_tasks, return_exceptions=True)
            except Exception:
                pass

    assert cache.tool.get_policy("search") == ToolPolicy(ttl=600)


@pytest.mark.asyncio
async def test_config_refresh_failed_counter_increments_on_hgetall_error():
    """config_refresh_failed counter is bumped when HGETALL raises.

    Uses a custom CollectorRegistry so the counter value can be read back
    without touching the global default registry.
    """
    from prometheus_client import CollectorRegistry, generate_latest
    from betterdb_agent_cache.types import TelemetryOptions

    registry = CollectorRegistry()
    client = make_client()
    client.hgetall = AsyncMock(side_effect=Exception("NOAUTH"))

    with patch("betterdb_agent_cache.agent_cache.create_analytics"):
        cache = AgentCache(AgentCacheOptions(
            client=client,
            config_refresh=ConfigRefreshOptions(interval_ms=1_000),
            telemetry=TelemetryOptions(registry=registry),
        ))
        if cache._config_refresh_task:
            cache._config_refresh_task.cancel()

    async def _sleep_once(_):
        raise asyncio.CancelledError

    with patch("asyncio.sleep", new=_sleep_once):
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
async def test_config_refresh_task_cancelled_on_shutdown():
    """shutdown() cancels the background refresh task."""
    client = make_client()
    client.hgetall = AsyncMock(return_value={})

    sleeping = asyncio.Event()

    async def mock_sleep(_):
        # Signal that the loop reached its sleep, then block until cancelled.
        sleeping.set()
        await asyncio.Event().wait()  # blocks without calling asyncio.sleep

    with patch("betterdb_agent_cache.agent_cache.create_analytics"):
        with patch("asyncio.sleep", new=mock_sleep):
            cache = AgentCache(AgentCacheOptions(
                client=client,
                config_refresh=ConfigRefreshOptions(interval_ms=1_000),
            ))
            # Wait until the loop has fired its first refresh and is sleeping
            await asyncio.wait_for(sleeping.wait(), timeout=2.0)
            task = cache._config_refresh_task
            assert task is not None
            await cache.shutdown()
            # Await the task so the CancelledError propagates and it becomes done
            try:
                await task
            except asyncio.CancelledError:
                pass

    assert task.cancelled() or task.done()
