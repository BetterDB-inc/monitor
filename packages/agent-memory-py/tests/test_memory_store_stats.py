from __future__ import annotations

from typing import Any

from betterdb_agent_memory import MemoryStore

from .conftest import fake_client


async def test_returns_item_count_evictions_and_config() -> None:
    def handler(command: str, *args: Any) -> Any:
        if command == "FT.INFO":
            return ["num_docs", "5", "indexing", "0"]
        if command == "HGETALL":
            return ["evictions", "3"]
        return "OK"

    client = fake_client(handler)
    store = MemoryStore(client=client, name="mem")

    stats = await store.stats()

    assert stats.item_count == 5
    assert stats.evictions == 3
    assert abs(stats.config.threshold - 0.33) < 1e-9
    assert client.find_call("FT.INFO") == ["FT.INFO", "mem:mem:idx"]
    assert client.find_call("HGETALL") == ["HGETALL", "mem:__mem_stats"]


async def test_reports_zero_evictions_when_stats_hash_absent() -> None:
    client = fake_client(
        lambda command, *args: ["num_docs", "0", "indexing", "0"] if command == "FT.INFO" else []
    )
    store = MemoryStore(client=client, name="mem")

    assert (await store.stats()).evictions == 0
