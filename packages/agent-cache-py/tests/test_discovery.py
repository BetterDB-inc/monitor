"""Tests for the discovery marker protocol (Python port of discovery.test.ts)."""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from betterdb_agent_cache.discovery import (
    CACHE_TYPE,
    HEARTBEAT_KEY_PREFIX,
    HEARTBEAT_TTL_SECONDS,
    PROTOCOL_KEY,
    PROTOCOL_VERSION,
    REGISTRY_KEY,
    TOOL_POLICIES_LIMIT,
    BuildAgentMetadataInput,
    DiscoveryManager,
    build_agent_metadata,
)
from betterdb_agent_cache.errors import AgentCacheUsageError


# ─── Fake in-memory Valkey client ────────────────────────────────────────────


class _SetCall:
    def __init__(self, key: str, value: str, args: tuple) -> None:
        self.key = key
        self.value = value
        self.args = args


class FakeClient:
    """Minimal in-memory client that mimics the Valkey interface."""

    def __init__(self) -> None:
        self.hashes: dict[str, dict[str, str]] = {}
        self.strings: dict[str, dict[str, Any]] = {}  # key -> {value, expires_at}
        self.hget_calls: int = 0
        self.hset_calls: int = 0
        self.set_calls: list[_SetCall] = []
        self.del_calls: list[str] = []

        self._fail_next_hset = False
        self._fail_next_hget = False
        self._fail_sets_matching = None  # Callable[[str], bool] | None

    def fail_hset_once(self) -> None:
        self._fail_next_hset = True

    def fail_hget_once(self) -> None:
        self._fail_next_hget = True

    def fail_sets_matching(self, pred) -> None:
        self._fail_sets_matching = pred

    async def hget(self, key: str, field: str) -> str | None:
        self.hget_calls += 1
        if self._fail_next_hget:
            self._fail_next_hget = False
            raise Exception("NOAUTH ACL denied")
        return self.hashes.get(key, {}).get(field)

    async def hset(self, key: str, field: str, value: str) -> int:
        self.hset_calls += 1
        if self._fail_next_hset:
            self._fail_next_hset = False
            raise Exception("NOAUTH ACL denied")
        if key not in self.hashes:
            self.hashes[key] = {}
        existed = field in self.hashes[key]
        self.hashes[key][field] = value
        return 0 if existed else 1

    async def set(self, key: str, value: str, *args: Any) -> str | None:
        self.set_calls.append(_SetCall(key, value, args))
        if self._fail_sets_matching and self._fail_sets_matching(key):
            raise Exception("NOAUTH ACL denied")
        has_nx = "NX" in args
        if has_nx and key in self.strings:
            return None
        # Compute expires_at for EX
        expires_at = None
        arg_list = list(args)
        if "EX" in arg_list:
            ex_index = arg_list.index("EX")
            if ex_index + 1 < len(arg_list):
                expires_at = arg_list[ex_index + 1]  # seconds from now (not absolute in fake)
        self.strings[key] = {"value": value, "expires_at": expires_at}
        return "OK"

    async def delete(self, *keys: str) -> int:
        n = 0
        for key in keys:
            self.del_calls.append(key)
            if key in self.strings:
                del self.strings[key]
                n += 1
        return n


# ─── Helpers ─────────────────────────────────────────────────────────────────


def _agent_meta_input(name: str, **overrides) -> BuildAgentMetadataInput:
    defaults = dict(
        name=name,
        version="0.5.0",
        tiers={},
        default_ttl=None,
        tool_policy_names=[],
        has_cost_table=False,
        uses_default_cost_table=True,
        started_at=datetime.now(timezone.utc).isoformat(),
        include_tool_policies=True,
    )
    defaults.update(overrides)
    return BuildAgentMetadataInput(**defaults)


def _agent_meta(name: str, **overrides) -> dict:
    return build_agent_metadata(_agent_meta_input(name, **overrides))


def _make_manager(
    client: FakeClient,
    name: str = "foo",
    tool_policy_names: list[str] | None = None,
    heartbeat_interval_s: float = 999_999.0,
    on_write_failed=None,
    logger=None,
) -> DiscoveryManager:
    _names = tool_policy_names or []

    def build_metadata():
        return _agent_meta(name, tool_policy_names=_names)

    return DiscoveryManager(
        client=client,
        name=name,
        build_metadata=build_metadata,
        heartbeat_interval_s=heartbeat_interval_s,
        on_write_failed=on_write_failed,
        logger=logger,
    )


# ─── build_agent_metadata tests ──────────────────────────────────────────────


class TestBuildAgentMetadata:
    def test_publishes_expected_capabilities(self):
        meta = _agent_meta("foo")
        assert "tool_ttl_adjust" in meta["capabilities"]
        assert "invalidate_by_tool" in meta["capabilities"]
        assert "tool_effectiveness" in meta["capabilities"]

    def test_derives_stats_key_from_name(self):
        meta = _agent_meta("prod-agent")
        assert meta["stats_key"] == "prod-agent:__stats"

    def test_includes_tool_policies_when_enabled(self):
        meta = _agent_meta("foo", tool_policy_names=["weather", "classify"])
        assert meta["tool_policies"] == ["weather", "classify"]
        assert "tool_policies_truncated" not in meta

    def test_omits_tool_policies_when_disabled(self):
        meta = _agent_meta("foo", include_tool_policies=False, tool_policy_names=["weather"])
        assert "tool_policies" not in meta

    def test_caps_tool_policies_at_limit(self):
        many = [f"tool_{i}" for i in range(TOOL_POLICIES_LIMIT + 50)]
        meta = _agent_meta("foo", tool_policy_names=many)
        assert isinstance(meta["tool_policies"], list)
        assert len(meta["tool_policies"]) == TOOL_POLICIES_LIMIT
        assert meta.get("tool_policies_truncated") is True

    def test_tier_ttl_default_falls_back_to_default_ttl(self):
        meta = _agent_meta("foo", tiers={"tool": {"ttl": 60}}, default_ttl=3600)
        tiers = meta["tiers"]
        assert tiers["tool"]["ttl_default"] == 60
        assert tiers["llm"]["ttl_default"] == 3600
        assert tiers["session"]["ttl_default"] == 3600

    def test_tier_without_ttl_and_no_default_omits_ttl_default(self):
        meta = _agent_meta("foo", tiers={}, default_ttl=None)
        tiers = meta["tiers"]
        assert "ttl_default" not in tiers["llm"]
        assert "ttl_default" not in tiers["tool"]

    def test_type_is_agent_cache(self):
        meta = _agent_meta("foo")
        assert meta["type"] == CACHE_TYPE

    def test_protocol_version(self):
        meta = _agent_meta("foo")
        assert meta["protocol_version"] == PROTOCOL_VERSION


# ─── DiscoveryManager.register tests ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_register_writes_registry_hash_and_protocol_key():
    client = FakeClient()
    mgr = _make_manager(client)

    await mgr.register()

    entry = client.hashes.get(REGISTRY_KEY, {}).get("foo")
    assert entry is not None
    parsed = json.loads(entry)
    assert parsed["type"] == "agent_cache"
    assert parsed["prefix"] == "foo"
    assert parsed["protocol_version"] == PROTOCOL_VERSION

    protocol_set = next((c for c in client.set_calls if c.key == PROTOCOL_KEY), None)
    assert protocol_set is not None
    assert "NX" in protocol_set.args

    await mgr.stop(delete_heartbeat=True)


@pytest.mark.asyncio
async def test_register_raises_on_cross_type_collision():
    client = FakeClient()
    owner_meta = {**_agent_meta("foo"), "type": "semantic_cache"}
    client.hashes[REGISTRY_KEY] = {"foo": json.dumps(owner_meta)}
    owner_json = client.hashes[REGISTRY_KEY]["foo"]

    mgr = _make_manager(client)

    with pytest.raises(AgentCacheUsageError, match="semantic_cache"):
        await mgr.register()

    # Registry entry must not have been overwritten
    assert client.hashes[REGISTRY_KEY]["foo"] == owner_json


@pytest.mark.asyncio
async def test_register_overwrites_with_warning_on_same_type_different_version():
    client = FakeClient()
    older = {**_agent_meta("foo"), "version": "0.4.5"}
    client.hashes[REGISTRY_KEY] = {"foo": json.dumps(older)}

    warnings: list[str] = []

    class _Logger:
        def warning(self, msg):
            warnings.append(msg)

        def debug(self, msg):
            pass

    mgr = _make_manager(client, logger=_Logger())

    await mgr.register()

    assert any("overwriting marker" in w for w in warnings)
    parsed = json.loads(client.hashes[REGISTRY_KEY]["foo"])
    assert parsed["version"] == "0.5.0"

    await mgr.stop(delete_heartbeat=True)


@pytest.mark.asyncio
async def test_register_does_not_raise_when_hset_fails_and_increments_counter():
    client = FakeClient()
    client.fail_hset_once()
    write_failed_calls = []
    mgr = _make_manager(client, on_write_failed=lambda: write_failed_calls.append(1))

    # Must not raise
    await mgr.register()

    assert len(write_failed_calls) >= 1

    await mgr.stop(delete_heartbeat=True)


@pytest.mark.asyncio
async def test_register_writes_initial_heartbeat():
    client = FakeClient()
    mgr = _make_manager(client)

    await mgr.register()

    heartbeat_entry = client.strings.get(f"{HEARTBEAT_KEY_PREFIX}foo")
    assert heartbeat_entry is not None
    assert heartbeat_entry["expires_at"] is not None

    await mgr.stop(delete_heartbeat=True)


# ─── DiscoveryManager heartbeat tests ────────────────────────────────────────


@pytest.mark.asyncio
async def test_tick_heartbeat_writes_heartbeat_key_with_60s_ttl():
    client = FakeClient()
    tool_policy_names: list[str] = []

    def build_metadata():
        return _agent_meta("foo", tool_policy_names=tool_policy_names)

    mgr = DiscoveryManager(
        client=client,
        name="foo",
        build_metadata=build_metadata,
        heartbeat_interval_s=999_999.0,
    )

    await mgr.register()

    tool_policy_names.append("weather_lookup")
    await mgr.tick_heartbeat()

    heartbeat_call = next(
        (c for c in client.set_calls if c.key == f"{HEARTBEAT_KEY_PREFIX}foo"),
        None,
    )
    assert heartbeat_call is not None
    arg_list = list(heartbeat_call.args)
    assert "EX" in arg_list
    ex_index = arg_list.index("EX")
    assert arg_list[ex_index + 1] == HEARTBEAT_TTL_SECONDS

    refreshed = client.hashes.get(REGISTRY_KEY, {}).get("foo")
    assert refreshed is not None
    parsed = json.loads(refreshed)
    assert parsed["tool_policies"] == ["weather_lookup"]

    await mgr.stop(delete_heartbeat=True)


@pytest.mark.asyncio
async def test_tick_heartbeat_failure_bumps_on_write_failed():
    client = FakeClient()
    client.fail_sets_matching(lambda key: key == f"{HEARTBEAT_KEY_PREFIX}foo")

    write_failed_calls = []
    mgr = _make_manager(client, on_write_failed=lambda: write_failed_calls.append(1))

    await mgr.tick_heartbeat()

    assert len(write_failed_calls) >= 1


@pytest.mark.asyncio
async def test_stop_delete_heartbeat_removes_heartbeat_key_not_registry():
    client = FakeClient()
    mgr = _make_manager(client)

    await mgr.register()
    await mgr.tick_heartbeat()

    registry_before = client.hashes.get(REGISTRY_KEY, {}).get("foo")

    await mgr.stop(delete_heartbeat=True)

    assert f"{HEARTBEAT_KEY_PREFIX}foo" in client.del_calls
    assert client.hashes.get(REGISTRY_KEY, {}).get("foo") == registry_before


@pytest.mark.asyncio
async def test_stop_no_delete_heartbeat_leaves_key_intact():
    client = FakeClient()
    mgr = _make_manager(client)

    await mgr.register()

    await mgr.stop(delete_heartbeat=False)

    assert f"{HEARTBEAT_KEY_PREFIX}foo" not in client.del_calls


@pytest.mark.asyncio
async def test_hget_failure_increments_counter_but_does_not_raise():
    """HGET failure during register() is swallowed — counter is bumped."""
    client = FakeClient()
    client.fail_hget_once()

    write_failed_calls = []
    mgr = _make_manager(client, on_write_failed=lambda: write_failed_calls.append(1))

    await mgr.register()

    assert len(write_failed_calls) >= 1

    await mgr.stop(delete_heartbeat=True)
