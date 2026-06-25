from __future__ import annotations

from betterdb_agent_memory import MATCH_ALL_MEMORY_QUERY, MemoryStore
from betterdb_agent_memory.types import MemoryListOptions

from .conftest import fake_client, ft_reply


async def test_search_by_scope_with_server_side_sortby_and_limit() -> None:
    reply = ft_reply(
        3,
        [
            ("mem:mem:b", {"content": "new", "created_at": "300", "importance": "0.5"}),
            ("mem:mem:c", {"content": "mid", "created_at": "200", "importance": "0.5"}),
            ("mem:mem:a", {"content": "old", "created_at": "100", "importance": "0.5"}),
        ],
    )
    client = fake_client(lambda command, *args: reply if command == "FT.SEARCH" else "OK")
    store = MemoryStore(client=client, name="mem")

    result = await store.list(MemoryListOptions(thread_id="t1"))

    search = client.find_call("FT.SEARCH")
    assert search is not None
    assert search[1] == "mem:mem:idx"
    assert search[2] == "(@threadId:{t1})"
    sortby_idx = search.index("SORTBY")
    assert search[sortby_idx + 1] == "created_at"
    assert search[sortby_idx + 2] == "DESC"
    limit_idx = search.index("LIMIT")
    assert search[limit_idx + 1] == "0"
    assert search[limit_idx + 2] == "20"
    assert result.total == 3
    assert [i.id for i in result.items] == ["b", "c", "a"]


async def test_passes_offset_and_limit_to_search() -> None:
    reply = ft_reply(1, [("mem:mem:c", {"content": "x", "created_at": "200"})])
    client = fake_client(lambda command, *args: reply if command == "FT.SEARCH" else "OK")
    store = MemoryStore(client=client, name="mem")

    result = await store.list(MemoryListOptions(limit=1, offset=1))

    search = client.find_call("FT.SEARCH")
    assert search is not None
    limit_idx = search.index("LIMIT")
    assert search[limit_idx + 1] == "1"
    assert search[limit_idx + 2] == "1"
    assert [i.id for i in result.items] == ["c"]
    assert result.total == 1


async def test_uses_match_all_query_when_no_scope() -> None:
    reply = ft_reply(1, [("mem:mem:a", {"content": "x", "created_at": "100", "importance": "0.5"})])
    client = fake_client(lambda command, *args: reply if command == "FT.SEARCH" else "OK")
    store = MemoryStore(client=client, name="mem")

    await store.list(MemoryListOptions())

    search = client.find_call("FT.SEARCH")
    assert search is not None
    assert search[2] == MATCH_ALL_MEMORY_QUERY
    assert search[2] != "*"
