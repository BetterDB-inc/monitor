from __future__ import annotations

import json

from betterdb_agent_cache.discovery import HEARTBEAT_KEY_PREFIX, REGISTRY_KEY
from betterdb_agent_memory import MemoryStore
from betterdb_agent_memory.types import MemoryDiscoveryConfig

from .conftest import fake_client, fake_embed

HEARTBEAT_KEY = f"{HEARTBEAT_KEY_PREFIX}mem:mem"


async def test_registers_a_discovery_marker_when_discovery_enabled() -> None:
    client = fake_client(lambda command, *args: None if command == "HGET" else "OK")
    store = MemoryStore(
        client=client,
        name="mem",
        embed_fn=fake_embed(8),
        discovery=MemoryDiscoveryConfig(version="1.0.0", heartbeat_interval_ms=999_999),
    )

    await store.close()

    hset = next((c for c in client.calls if c[0] == "HSET" and c[1] == REGISTRY_KEY), None)
    assert hset is not None
    assert hset[2] == "mem:mem"
    marker = json.loads(hset[3])
    assert marker["type"] == "agent_memory"
    assert marker["stats_key"] == "mem:__mem_stats"
    assert any(c[0] == "DEL" and c[1] == HEARTBEAT_KEY for c in client.calls)


async def test_does_not_touch_registry_when_discovery_not_enabled() -> None:
    client = fake_client(lambda command, *args: "OK")
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8))

    await store.close()

    assert not any(c[0] == "HSET" and c[1] == REGISTRY_KEY for c in client.calls)
