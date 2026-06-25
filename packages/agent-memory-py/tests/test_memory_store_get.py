from __future__ import annotations

from typing import Any

from betterdb_agent_memory import MemoryStore

from .conftest import fake_client, flat_fields


async def test_hgetall_and_parses_no_vector_bytes() -> None:
    def handler(command: str, *args: Any) -> Any:
        if command == "HGETALL":
            return flat_fields(
                {
                    "content": "hello",
                    "importance": "0.5",
                    "tags": "a,b",
                    "created_at": "100",
                    "last_accessed_at": "150",
                    "access_count": "2",
                    "threadId": "t1",
                    "vector": "RAWBYTES",
                }
            )
        return "OK"

    client = fake_client(handler)
    store = MemoryStore(client=client, name="mem")

    item = await store.get("doc1")

    assert client.find_call("HGETALL") == ["HGETALL", "mem:mem:doc1"]
    assert item is not None
    assert item.id == "doc1"
    assert item.content == "hello"
    assert item.importance == 0.5
    assert item.tags == ["a", "b"]
    assert item.created_at == 100
    assert item.last_accessed_at == 150
    assert item.access_count == 2
    assert item.thread_id == "t1"
    # MemoryItem never carries the raw vector blob.
    assert not hasattr(item, "vector")


async def test_returns_none_when_hash_is_empty() -> None:
    client = fake_client(lambda command, *args: [] if command == "HGETALL" else "OK")
    store = MemoryStore(client=client, name="mem")

    assert await store.get("missing") is None
