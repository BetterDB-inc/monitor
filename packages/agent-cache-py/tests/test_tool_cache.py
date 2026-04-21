"""Unit tests for ToolCache."""
from __future__ import annotations

import json
from unittest.mock import AsyncMock

import pytest

from betterdb_agent_cache.errors import AgentCacheUsageError, ValkeyCommandError
from betterdb_agent_cache.tiers.tool_cache import ToolCache, ToolCacheConfig
from betterdb_agent_cache.types import ToolPolicy, ToolStoreOptions

from .conftest import make_client, make_telemetry


def _make_cache(**kwargs) -> tuple[ToolCache, object]:
    client = make_client()
    config = ToolCacheConfig(
        client=client,
        name="test",
        default_ttl=None,
        tier_ttl=None,
        telemetry=make_telemetry(),
        stats_key="test:__stats",
        **kwargs,
    )
    return ToolCache(config), client


def _stored(response: str = "result", tool: str = "weather") -> str:
    return json.dumps({"response": response, "toolName": tool, "args": {}, "storedAt": 0})


# ─── validation ───────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_check_raises_on_colon_in_tool_name():
    cache, _ = _make_cache()
    with pytest.raises(AgentCacheUsageError, match="colon"):
        await cache.check("bad:name", {})


@pytest.mark.asyncio
async def test_store_raises_on_colon_in_tool_name():
    cache, _ = _make_cache()
    with pytest.raises(AgentCacheUsageError, match="colon"):
        await cache.store("bad:name", {}, "result")


# ─── check ────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_check_miss():
    cache, client = _make_cache()
    client.get = AsyncMock(return_value=None)

    result = await cache.check("weather", {"city": "London"})

    assert result.hit is False
    assert result.tool_name == "weather"


@pytest.mark.asyncio
async def test_check_hit():
    cache, client = _make_cache()
    client.get = AsyncMock(return_value=_stored("sunny").encode())

    result = await cache.check("weather", {"city": "London"})

    assert result.hit is True
    assert result.response == "sunny"
    assert result.tool_name == "weather"


@pytest.mark.asyncio
async def test_check_corrupt_returns_miss_and_deletes():
    cache, client = _make_cache()
    client.get = AsyncMock(return_value=b"{{bad json")

    result = await cache.check("weather", {})

    assert result.hit is False
    client.delete.assert_called_once()


@pytest.mark.asyncio
async def test_check_raises_on_get_error():
    cache, client = _make_cache()
    client.get = AsyncMock(side_effect=Exception("timeout"))

    with pytest.raises(ValkeyCommandError, match="GET"):
        await cache.check("weather", {})


# ─── store ────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_store_returns_key():
    cache, client = _make_cache()

    key = await cache.store("weather", {"city": "London"}, "sunny")

    assert "test:tool:weather:" in key


@pytest.mark.asyncio
async def test_store_uses_policy_ttl():
    cache, client = _make_cache()
    cache._policies["weather"] = ToolPolicy(ttl=120)

    await cache.store("weather", {}, "r")

    call = client.set.call_args
    assert call.kwargs.get("ex") == 120


@pytest.mark.asyncio
async def test_store_per_call_ttl_overrides_policy():
    cache, client = _make_cache()
    cache._policies["weather"] = ToolPolicy(ttl=120)

    await cache.store("weather", {}, "r", ToolStoreOptions(ttl=30))

    call = client.set.call_args
    assert call.kwargs.get("ex") == 30


# ─── set_policy / get_policy ──────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_set_policy_persists_and_is_readable():
    cache, client = _make_cache()

    await cache.set_policy("weather", ToolPolicy(ttl=300))

    assert cache.get_policy("weather") == ToolPolicy(ttl=300)
    client.hset.assert_called_once_with(
        "test:__tool_policies", "weather", json.dumps({"ttl": 300})
    )


def test_get_policy_returns_none_for_unknown():
    cache, _ = _make_cache()
    assert cache.get_policy("unknown_tool") is None


# ─── invalidate ───────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_invalidate_specific_entry():
    cache, client = _make_cache()
    client.delete = AsyncMock(return_value=1)

    deleted = await cache.invalidate("weather", {"city": "London"})

    assert deleted is True


@pytest.mark.asyncio
async def test_invalidate_returns_false_when_key_absent():
    cache, client = _make_cache()
    client.delete = AsyncMock(return_value=0)

    deleted = await cache.invalidate("weather", {"city": "London"})

    assert deleted is False


# ─── load_policies ────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_load_policies_populates_from_valkey():
    cache, client = _make_cache()
    client.hgetall = AsyncMock(return_value={
        b"weather": json.dumps({"ttl": 600}).encode()
    })

    await cache.load_policies()

    assert cache.get_policy("weather") == ToolPolicy(ttl=600)


@pytest.mark.asyncio
async def test_load_policies_ignores_corrupt_entries():
    cache, client = _make_cache()
    client.hgetall = AsyncMock(return_value={
        b"bad_tool": b"{{not json",
        b"weather": json.dumps({"ttl": 60}).encode(),
    })

    await cache.load_policies()

    assert cache.get_policy("weather") == ToolPolicy(ttl=60)
    assert cache.get_policy("bad_tool") is None


# ─── reset_policies ───────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_reset_policies_clears_all():
    cache, _ = _make_cache()
    cache._policies["weather"] = ToolPolicy(ttl=60)

    cache.reset_policies()

    assert cache.get_policy("weather") is None
