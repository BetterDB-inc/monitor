from __future__ import annotations

from typing import Any

import pytest
from betterdb_agent_memory import MATCH_ALL_MEMORY_QUERY, MemoryStore
from betterdb_agent_memory.types import RecallWeights

from .conftest import fake_client, fake_embed, ft_reply, now_ms


def fields(importance: float, last_accessed_at: int) -> dict[str, str]:
    return {"importance": str(importance), "last_accessed_at": str(last_accessed_at)}


# -- TTL writes -------------------------------------------------------------


async def test_durable_memory_uses_plain_hset_without_ttl() -> None:
    client = fake_client()
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8))

    await store.remember("durable")

    commands = client.commands()
    assert "HSET" in commands
    assert "EXPIRE" not in commands
    assert "MULTI" not in commands


async def test_expiring_memory_written_atomically_when_ttl_set() -> None:
    client = fake_client()
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8))

    await store.remember("temporary", ttl=3600)

    assert client.commands() == ["MULTI", "HSET", "EXPIRE", "EXEC"]
    hset = client.find_call("HSET")
    expire = client.find_call("EXPIRE")
    assert hset is not None and expire is not None
    assert expire[1] == hset[1]
    assert expire[2] == "3600"


async def test_non_positive_ttl_is_durable() -> None:
    client = fake_client()
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8))

    await store.remember("x", ttl=0)

    commands = client.commands()
    assert "HSET" in commands
    assert "EXPIRE" not in commands


async def test_ttl_write_discards_and_propagates_on_mid_transaction_failure() -> None:
    def handler(command: str, *args: Any) -> Any:
        if command == "EXPIRE":
            raise RuntimeError("boom")
        return "OK"

    client = fake_client(handler)
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8))

    with pytest.raises(RuntimeError, match="boom"):
        await store.remember("x", ttl=60)
    assert any(c[0] == "DISCARD" for c in client.calls)


# -- capacity eviction ------------------------------------------------------


async def test_evicts_lowest_ranked_item_and_bumps_eviction_counter() -> None:
    def handler(command: str, *args: Any) -> Any:
        if command == "FT.SEARCH":
            if "RETURN" in args:
                return ft_reply(
                    3,
                    [
                        ("mem:mem:a", fields(0.1, 1000)),
                        ("mem:mem:b", fields(0.9, 5000)),
                        ("mem:mem:c", fields(0.5, 9000)),
                    ],
                )
            return ft_reply(3)
        if command == "DEL":
            return len(args)
        return "OK"

    client = fake_client(handler)
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8), max_items_per_scope=2)

    await store.remember("content", namespace="u1")

    assert client.find_call("DEL") == ["DEL", "mem:mem:a"]
    hincr = next((c for c in client.calls if c[0] == "HINCRBY" and c[1] == "mem:__mem_stats"), None)
    assert hincr == ["HINCRBY", "mem:__mem_stats", "evictions", "1"]


async def test_counts_only_actual_removals_when_index_lists_deleted_keys() -> None:
    def handler(command: str, *args: Any) -> Any:
        if command == "FT.SEARCH":
            if "RETURN" in args:
                return ft_reply(
                    4,
                    [
                        ("mem:mem:a", fields(0.1, 1000)),
                        ("mem:mem:b", fields(0.2, 2000)),
                        ("mem:mem:c", fields(0.9, 5000)),
                        ("mem:mem:d", fields(0.5, 9000)),
                    ],
                )
            return ft_reply(4)
        # Two keys evicted but only one was still live.
        if command == "DEL":
            return 1
        return "OK"

    client = fake_client(handler)
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8), max_items_per_scope=2)

    await store.remember("content", namespace="u1")

    hincr = next((c for c in client.calls if c[0] == "HINCRBY" and c[1] == "mem:__mem_stats"), None)
    assert hincr == ["HINCRBY", "mem:__mem_stats", "evictions", "1"]


async def test_queries_capacity_by_written_item_scope() -> None:
    client = fake_client(lambda command, *args: ft_reply(2) if command == "FT.SEARCH" else "OK")
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8), max_items_per_scope=2)

    await store.remember("content", namespace="u1")

    search = client.find_call("FT.SEARCH")
    assert search is not None
    assert search[1] == "mem:mem:idx"
    assert search[2] == "(@namespace:{u1})"


async def test_partitions_capacity_by_tags() -> None:
    client = fake_client(lambda command, *args: ft_reply(2) if command == "FT.SEARCH" else "OK")
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8), max_items_per_scope=2)

    await store.remember("content", tags=["teamx"])

    search = client.find_call("FT.SEARCH")
    assert search is not None
    assert search[2] == "(@tags:{teamx})"
    assert search[2] != MATCH_ALL_MEMORY_QUERY


async def test_does_not_evict_or_fetch_candidates_within_capacity() -> None:
    client = fake_client(lambda command, *args: ft_reply(2) if command == "FT.SEARCH" else "OK")
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8), max_items_per_scope=2)

    await store.remember("content", namespace="u1")

    assert len(client.calls_for("FT.SEARCH")) == 1
    commands = client.commands()
    assert "DEL" not in commands
    assert "HINCRBY" not in commands


async def test_no_capacity_check_when_max_items_not_configured() -> None:
    client = fake_client()
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8))

    await store.remember("content", namespace="u1")

    assert not any(c[0] == "FT.SEARCH" for c in client.calls)


async def test_skips_capacity_enforcement_for_fully_unscoped_write() -> None:
    client = fake_client()
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8), max_items_per_scope=1)

    await store.remember("content")

    assert not any(c[0] == "FT.SEARCH" for c in client.calls)


async def test_capacity_enforcement_failure_never_breaks_write() -> None:
    def handler(command: str, *args: Any) -> Any:
        if command == "FT.SEARCH":
            raise RuntimeError("search boom")
        return "OK"

    client = fake_client(handler)
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8), max_items_per_scope=2)

    memory_id = await store.remember("content", namespace="u1")

    assert isinstance(memory_id, str)
    assert len(memory_id) > 0


async def test_snapshots_eviction_weights_so_mid_pass_refresh_cannot_change_victim() -> None:
    holder: list[MemoryStore] = []

    def handler(command: str, *args: Any) -> Any:
        if command == "HGETALL":
            return [
                "recall.weights.similarity",
                "0",
                "recall.weights.recency",
                "0.9",
                "recall.weights.importance",
                "0.1",
            ]
        if command == "FT.SEARCH":
            if "RETURN" in args:

                async def refresh_then_reply() -> list[Any]:
                    await holder[0].refresh_config()
                    return ft_reply(
                        2,
                        [
                            ("mem:mem:stale", fields(0.9, 1000)),
                            ("mem:mem:recent", fields(0.1, now_ms())),
                        ],
                    )

                return refresh_then_reply()
            return ft_reply(2)
        return "OK"

    client = fake_client(handler)
    store = MemoryStore(
        client=client,
        name="mem",
        embed_fn=fake_embed(8),
        max_items_per_scope=1,
        half_life_seconds=100,
        weights=RecallWeights(similarity=0, recency=0.1, importance=0.9),
    )
    holder.append(store)

    await store.remember("content", namespace="u1")

    assert client.find_call("DEL") == ["DEL", "mem:mem:recent"]
