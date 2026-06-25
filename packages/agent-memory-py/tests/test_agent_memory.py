from __future__ import annotations

import json
from typing import Any

import pytest
from betterdb_agent_cache.types import (
    AnalyticsOptions,
    ConfigRefreshOptions,
    DiscoveryOptions,
    TelemetryOptions,
)
from betterdb_agent_memory import AgentMemory, MemoryStore
from betterdb_agent_memory.agent_memory import AgentMemoryOptions
from betterdb_agent_memory.types import (
    AgentMemoryConfig,
    AgentMemoryRecallConfig,
    RecallWeights,
)
from prometheus_client import CollectorRegistry, generate_latest

from .conftest import fake_embed


class FakeValkey:
    """Dual-mode mock: ``execute_command`` for the memory tier plus method-style
    calls (get/set/hget/...) for the agent-cache tiers and discovery."""

    def __init__(self) -> None:
        self.calls: list[list[Any]] = []
        self._on_command: Any = None

    async def execute_command(self, *args: Any) -> Any:
        self.calls.append(list(args))
        command = args[0]
        if isinstance(command, bytes):
            command = command.decode()
        if self._on_command is not None:
            return await self._on_command(command, *args[1:])
        return None if command in ("HGET", "GET") else "OK"

    async def get(self, *_args: Any) -> Any:
        return None

    async def set(self, *_args: Any) -> Any:
        return "OK"

    async def delete(self, *_args: Any) -> Any:
        return "OK"

    async def hget(self, *_args: Any) -> Any:
        return None

    async def hset(self, *_args: Any) -> Any:
        return "OK"

    async def hgetall(self, *_args: Any) -> Any:
        return {}

    async def hincrby(self, *_args: Any) -> Any:
        return 1

    async def expire(self, *_args: Any) -> Any:
        return "OK"

    async def exists(self, *_args: Any) -> Any:
        return 0

    async def scan(self, *_args: Any) -> Any:
        return ["0", []]


def make_options(**overrides: Any) -> AgentMemoryOptions:
    kwargs: dict[str, Any] = {
        "client": FakeValkey(),
        "embed_fn": fake_embed(8),
        "discovery": DiscoveryOptions(enabled=False),
        "config_refresh": ConfigRefreshOptions(enabled=False),
        "analytics": AnalyticsOptions(disabled=True),
    }
    kwargs.update(overrides)
    return AgentMemoryOptions(**kwargs)


async def test_exposes_the_three_short_term_tiers_plus_memory_tier() -> None:
    mem = AgentMemory(make_options())

    assert mem.llm is not None
    assert mem.tool is not None
    assert mem.session is not None
    assert isinstance(mem.memory, MemoryStore)

    await mem.close()


def test_throws_clear_error_when_constructed_without_embed_fn() -> None:
    options = make_options()
    options.embed_fn = None  # type: ignore[assignment]
    with pytest.raises(ValueError, match="(?i)embed_fn"):
        AgentMemory(options)


async def test_wires_memory_tier_to_shared_client_and_default_prefix() -> None:
    client = FakeValkey()
    mem = AgentMemory(make_options(client=client))

    id = await mem.memory.remember("hello")

    assert isinstance(id, str)
    hset = next(
        (
            c
            for c in client.calls
            if c[0] == "HSET" and isinstance(c[1], str) and c[1].startswith("betterdb_ac:mem:")
        ),
        None,
    )
    assert hset is not None

    await mem.close()


async def test_shares_configured_name_as_memory_key_prefix() -> None:
    client = FakeValkey()
    mem = AgentMemory(make_options(client=client, name="myapp"))

    await mem.memory.remember("hello")

    hset = next(
        (
            c
            for c in client.calls
            if c[0] == "HSET" and isinstance(c[1], str) and c[1].startswith("myapp:mem:")
        ),
        None,
    )
    assert hset is not None

    await mem.close()


async def test_maps_memory_sub_config_onto_memory_store() -> None:
    mem = AgentMemory(
        make_options(
            memory=AgentMemoryConfig(
                default_threshold=0.4,
                recall=AgentMemoryRecallConfig(
                    weights=RecallWeights(similarity=0.5, recency=0.3, importance=0.2),
                    half_life_seconds=3600,
                ),
                max_items_per_scope=100,
                discovery=False,
            )
        )
    )

    snap = mem.memory.current_config()
    assert snap.threshold == 0.4
    assert snap.weights == RecallWeights(similarity=0.5, recency=0.3, importance=0.2)
    assert snap.half_life_seconds == 3600
    assert snap.max_items_per_scope == 100

    await mem.close()


async def test_initialize_resolves_and_close_tears_down_both_tiers() -> None:
    mem = AgentMemory(make_options())
    closed: list[int] = []
    original_close = mem.memory.close

    async def spy_close() -> None:
        closed.append(1)
        await original_close()

    mem.memory.close = spy_close  # type: ignore[method-assign]

    await mem.initialize()
    await mem.close()

    assert len(closed) > 0


async def test_initialize_surfaces_cache_discovery_collision() -> None:
    mem = AgentMemory(make_options())

    async def boom() -> None:
        raise RuntimeError("cache name collision")

    mem._cache.ensure_discovery_ready = boom  # type: ignore[method-assign]

    with pytest.raises(RuntimeError, match="(?i)collision"):
        await mem.initialize()

    await mem.close()


async def test_initialize_creates_memory_index_when_missing() -> None:
    client = FakeValkey()

    async def on_command(command: str, *args: Any) -> Any:
        if command == "FT.INFO":
            raise RuntimeError("Unknown index name 'betterdb_ac:mem:idx'")
        return None if command == "HGET" else "OK"

    client._on_command = on_command
    mem = AgentMemory(make_options(client=client))

    await mem.initialize()

    create = next((c for c in client.calls if c[0] == "FT.CREATE"), None)
    assert create is not None
    assert create[1] == "betterdb_ac:mem:idx"

    await mem.close()


async def test_registers_memory_discovery_marker_by_default() -> None:
    client = FakeValkey()
    mem = AgentMemory(make_options(client=client))

    await mem.initialize()

    marker = next(
        (c for c in client.calls if c[0] == "HSET" and c[1] == "__betterdb:caches"),
        None,
    )
    assert marker is not None
    assert json.loads(marker[3])["type"] == "agent_memory"
    assert marker[2] == "betterdb_ac:mem"

    await mem.close()


async def test_allows_disabling_memory_discovery() -> None:
    client = FakeValkey()
    mem = AgentMemory(make_options(client=client, memory=AgentMemoryConfig(discovery=False)))

    await mem.initialize()
    await mem.close()

    marker = next(
        (c for c in client.calls if c[0] == "HSET" and c[1] == "__betterdb:caches"),
        None,
    )
    assert marker is None


async def test_shares_one_prom_registry_across_cache_and_memory_tiers() -> None:
    registry = CollectorRegistry()
    mem = AgentMemory(make_options(telemetry=TelemetryOptions(registry=registry)))

    await mem.memory.remember("x")

    text = generate_latest(registry).decode()
    assert "agent_memory_embedding_calls_total" in text
    assert "agent_cache_" in text

    await mem.close()
