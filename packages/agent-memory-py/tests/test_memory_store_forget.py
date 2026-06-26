from __future__ import annotations

from typing import Any

import pytest
from betterdb_agent_memory import MemoryStore

from .conftest import fake_client, fake_embed, ft_reply


def keys_reply(keys: list[str]) -> list[Any]:
    return ft_reply(len(keys), [(key, {}) for key in keys])


async def test_forget_dels_hash_and_reports_it_existed() -> None:
    client = fake_client(lambda command, *args: 1 if command == "DEL" else "OK")
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8))

    assert await store.forget("doc1") is True
    assert ["DEL", "mem:mem:doc1"] in client.calls


async def test_forget_returns_false_when_absent() -> None:
    client = fake_client(lambda command, *args: 0 if command == "DEL" else "OK")
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8))

    assert await store.forget("missing") is False


async def test_forget_by_scope_searches_dels_matches_returns_count() -> None:
    pages = [keys_reply(["mem:mem:a", "mem:mem:b"]), keys_reply([])]
    call = [0]

    def handler(command: str, *args: Any) -> Any:
        if command == "FT.SEARCH":
            idx = min(call[0], len(pages) - 1)
            call[0] += 1
            return pages[idx]
        if command == "DEL":
            return len(args)
        return "OK"

    client = fake_client(handler)
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8))

    count = await store.forget_by_scope(thread_id="t1", tags=["x"])

    assert count == 2
    search = client.find_call("FT.SEARCH")
    assert search is not None
    assert search[1] == "mem:mem:idx"
    assert search[2] == "(@threadId:{t1} @tags:{x})"
    assert ["DEL", "mem:mem:a", "mem:mem:b"] in client.calls


async def test_forget_by_scope_escapes_glob_chars() -> None:
    client = fake_client(lambda command, *args: keys_reply([]) if command == "FT.SEARCH" else "OK")
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8))

    await store.forget_by_scope(thread_id="*")

    search = client.find_call("FT.SEARCH")
    assert search is not None
    assert search[2] == "(@threadId:{\\*})"


async def test_forget_by_scope_throws_without_scope_or_tag() -> None:
    store = MemoryStore(client=fake_client(), name="mem", embed_fn=fake_embed(8))

    with pytest.raises(ValueError, match="scope"):
        await store.forget_by_scope()


async def test_forget_by_scope_returns_zero_and_no_del_when_nothing_matches() -> None:
    client = fake_client(lambda command, *args: keys_reply([]) if command == "FT.SEARCH" else "OK")
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8))

    assert await store.forget_by_scope(thread_id="t") == 0
    assert not any(c[0] == "DEL" for c in client.calls)


async def test_forget_by_scope_paginates_across_batches() -> None:
    batches = [
        keys_reply(["mem:mem:a", "mem:mem:b"]),
        keys_reply(["mem:mem:c"]),
        keys_reply([]),
    ]
    call = [0]

    def handler(command: str, *args: Any) -> Any:
        if command == "FT.SEARCH":
            idx = min(call[0], len(batches) - 1)
            call[0] += 1
            return batches[idx]
        return len(args) if command == "DEL" else "OK"

    client = fake_client(handler)
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8))

    count = await store.forget_by_scope(thread_id="t")

    assert count == 3
    dels = client.calls_for("DEL")
    assert len(dels) == 2
    assert dels[0] == ["DEL", "mem:mem:a", "mem:mem:b"]
    assert dels[1] == ["DEL", "mem:mem:c"]


async def test_forget_by_scope_warns_when_batch_safety_cap_is_hit() -> None:
    def handler(command: str, *args: Any) -> Any:
        if command == "FT.SEARCH":
            return keys_reply(["mem:mem:x"])
        return len(args) if command == "DEL" else "OK"

    client = fake_client(handler)
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8))

    with pytest.warns(UserWarning, match="safety cap"):
        count = await store.forget_by_scope(thread_id="t")

    assert count == 10000
