from __future__ import annotations

import asyncio
import json
from typing import Any

from betterdb_agent_cache.discovery import (
    HEARTBEAT_KEY_PREFIX,
    PROTOCOL_KEY,
    PROTOCOL_VERSION,
    REGISTRY_KEY,
)
from betterdb_agent_memory.discovery import MemoryDiscovery

from .conftest import fake_client

HEARTBEAT_KEY = f"{HEARTBEAT_KEY_PREFIX}mem:mem"


def fresh_client() -> Any:
    return fake_client(lambda command, *args: None if command == "HGET" else "OK")


def make_discovery(client: Any, **overrides: Any) -> MemoryDiscovery:
    kwargs: dict[str, Any] = {
        "client": client,
        "name": "mem",
        "version": "1.2.3",
        "stats_key": "mem:__mem_stats",
        "heartbeat_interval_s": 999_999,
    }
    kwargs.update(overrides)
    return MemoryDiscovery(**kwargs)


async def test_registers_agent_memory_marker_with_capabilities_and_stats_key() -> None:
    client = fresh_client()
    disco = make_discovery(client)

    await disco.register()
    await disco.stop(delete_heartbeat=False)

    hset = next((c for c in client.calls if c[0] == "HSET" and c[1] == REGISTRY_KEY), None)
    assert hset is not None
    assert hset[2] == "mem:mem"
    marker = json.loads(hset[3])
    assert marker["type"] == "agent_memory"
    assert marker["prefix"] == "mem"
    assert marker["version"] == "1.2.3"
    assert marker["protocol_version"] == PROTOCOL_VERSION
    assert marker["capabilities"] == ["recall", "consolidate", "reinforce"]
    assert marker["stats_key"] == "mem:__mem_stats"


async def test_sets_protocol_key_nx_and_writes_heartbeat_with_ttl() -> None:
    client = fresh_client()
    disco = make_discovery(client)

    await disco.register()
    await disco.stop(delete_heartbeat=False)

    sets = [c for c in client.calls if c[0] == "SET"]
    assert any(c[1] == PROTOCOL_KEY and c[3] == "NX" for c in sets)
    heartbeat = next((c for c in sets if c[1] == HEARTBEAT_KEY), None)
    assert heartbeat is not None
    assert heartbeat[3] == "EX"
    assert heartbeat[4] == "60"


async def test_warns_visibly_and_overwrites_on_collision_with_different_type() -> None:
    import pytest

    client = fake_client(
        lambda command, *args: json.dumps({"type": "agent_cache"}) if command == "HGET" else "OK"
    )
    disco = make_discovery(client)

    with pytest.warns(UserWarning, match="(?i)marker"):
        await disco.register()
    await disco.stop(delete_heartbeat=False)

    assert any(c[0] == "HSET" and c[1] == REGISTRY_KEY for c in client.calls)


async def test_overwrites_existing_marker_of_same_type_without_throwing() -> None:
    client = fake_client(
        lambda command, *args: (
            json.dumps({"type": "agent_memory", "version": "0.0.1"}) if command == "HGET" else "OK"
        )
    )
    disco = make_discovery(client)

    await disco.register()
    await disco.stop(delete_heartbeat=False)

    assert any(c[0] == "HSET" and c[1] == REGISTRY_KEY for c in client.calls)


async def test_deletes_heartbeat_key_on_stop_when_asked() -> None:
    client = fresh_client()
    disco = make_discovery(client)

    await disco.register()
    await disco.stop(delete_heartbeat=True)

    assert any(c[0] == "DEL" and c[1] == HEARTBEAT_KEY for c in client.calls)


async def test_rewrites_heartbeat_and_marker_on_tick_heartbeat() -> None:
    client = fresh_client()
    disco = make_discovery(client)
    await disco.register()
    before = len(client.calls)

    await disco.tick_heartbeat()
    await disco.stop(delete_heartbeat=False)

    after = client.calls[before:]
    assert any(c[0] == "SET" and c[1] == HEARTBEAT_KEY for c in after)
    assert any(c[0] == "HSET" and c[1] == REGISTRY_KEY for c in after)


async def test_heartbeats_on_the_configured_interval() -> None:
    client = fresh_client()
    disco = make_discovery(client, heartbeat_interval_s=0.05)
    await disco.register()
    before = len([c for c in client.calls if c[0] == "HSET"])

    await asyncio.sleep(0.12)

    after = len([c for c in client.calls if c[0] == "HSET"])
    assert after > before
    await disco.stop(delete_heartbeat=False)


async def test_waits_for_in_flight_tick_before_deleting() -> None:
    gate = asyncio.Event()
    release = asyncio.Event()
    order: list[str] = []

    def handler(command: str, *args: Any) -> Any:
        order.append(command)
        if gate.is_set() and command == "SET" and args[0] == HEARTBEAT_KEY:

            async def blocked() -> str:
                await release.wait()
                return "OK"

            return blocked()
        return None if command == "HGET" else "OK"

    client = fake_client(handler)
    disco = make_discovery(client, heartbeat_interval_s=0.05)
    await disco.register()

    gate.set()
    await asyncio.sleep(0.08)  # fire one tick; its heartbeat SET blocks

    stop_task = asyncio.create_task(disco.stop(delete_heartbeat=True))
    await asyncio.sleep(0)
    assert "DEL" not in order  # DEL waits behind the in-flight tick

    release.set()
    await stop_task
    assert order[-1] == "DEL"  # DEL is the final write


async def test_never_throws_when_registry_write_fails_best_effort() -> None:
    calls: list[int] = []

    def on_write_failed() -> None:
        calls.append(1)

    def handler(command: str, *args: Any) -> Any:
        if command == "HGET":
            return None
        if command == "HSET":
            raise RuntimeError("registry boom")
        return "OK"

    client = fake_client(handler)
    disco = make_discovery(client, on_write_failed=on_write_failed)

    await disco.register()
    await disco.stop(delete_heartbeat=False)
    assert len(calls) > 0
