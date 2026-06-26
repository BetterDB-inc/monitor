from __future__ import annotations

from typing import Any

from betterdb_agent_memory import MATCH_ALL_MEMORY_QUERY, MemoryStore

from .conftest import fake_client, ft_reply


async def test_runs_knn_with_supplied_vector_and_needs_no_embed_fn() -> None:
    reply = ft_reply(
        1,
        [
            (
                "mem:mem:a",
                {
                    "__score": "0.10",
                    "content": "hit",
                    "importance": "0.5",
                    "created_at": "100",
                    "last_accessed_at": "100",
                    "access_count": "0",
                },
            )
        ],
    )

    def handler(command: str, *args: Any) -> Any:
        if command == "FT.SEARCH":
            return reply
        if command == "EXISTS":
            return 1
        return "OK"

    client = fake_client(handler)
    store = MemoryStore(client=client, name="mem")

    hits = await store.recall_by_vector([0, 1, 0, 0, 0, 0, 0, 0], thread_id="t1", reinforce=False)

    assert [h.item.id for h in hits] == ["a"]
    search = client.find_call("FT.SEARCH")
    assert search is not None
    assert search[1] == "mem:mem:idx"
    assert "KNN" in str(search[2])
    # No embedding happened: read-only vector recall never reads/writes a hash.
    assert client.find_call("HGETALL") is None


async def test_uses_match_all_query_when_no_scope() -> None:
    reply = ft_reply(
        1,
        [
            (
                "mem:mem:b",
                {
                    "__score": "0.05",
                    "content": "no-scope hit",
                    "importance": "0.5",
                    "created_at": "200",
                    "last_accessed_at": "200",
                    "access_count": "0",
                },
            )
        ],
    )

    def handler(command: str, *args: Any) -> Any:
        if command == "FT.SEARCH":
            return reply
        if command == "EXISTS":
            return 1
        return "OK"

    client = fake_client(handler)
    store = MemoryStore(client=client, name="mem")

    await store.recall_by_vector([0, 1, 0, 0, 0, 0, 0, 0], reinforce=False)

    search = client.find_call("FT.SEARCH")
    assert search is not None
    assert f"{MATCH_ALL_MEMORY_QUERY}=>[KNN" in str(search[2])
    assert "*=>[KNN" not in str(search[2])
