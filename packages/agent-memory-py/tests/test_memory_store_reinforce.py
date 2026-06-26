from __future__ import annotations

from typing import Any

from betterdb_agent_memory import MemoryStore

from .conftest import fake_client, fake_embed, now_ms

NOW = now_ms()


def one_hit() -> list[Any]:
    fields = {
        "content": "c",
        "importance": "0.5",
        "created_at": str(NOW),
        "last_accessed_at": str(NOW),
        "access_count": "0",
        "__score": "0.1",
    }
    flat: list[str] = []
    for field, value in fields.items():
        flat.extend([field, value])
    return ["1", "mem:mem:a", flat]


async def test_reinforces_recalled_items_by_default() -> None:
    def handler(command: str, *args: Any) -> Any:
        if command == "FT.SEARCH":
            return one_hit()
        return 1 if command == "EXISTS" else "OK"

    client = fake_client(handler)
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8))

    await store.recall("q", k=1, threshold=1)

    assert ["HINCRBY", "mem:mem:a", "access_count", "1"] in client.calls
    hset = next(
        (
            c
            for c in client.calls
            if c[0] == "HSET" and c[1] == "mem:mem:a" and c[2] == "last_accessed_at"
        ),
        None,
    )
    assert hset is not None


async def test_does_not_resurrect_recalled_hit_whose_hash_was_deleted() -> None:
    def handler(command: str, *args: Any) -> Any:
        if command == "FT.SEARCH":
            return one_hit()
        return 0 if command == "EXISTS" else "OK"

    client = fake_client(handler)
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8))

    await store.recall("q", k=1, threshold=1)

    assert not any(c[0] == "HSET" for c in client.calls)
    assert not any(c[0] == "HINCRBY" for c in client.calls)


async def test_does_not_reinforce_when_reinforce_is_false() -> None:
    client = fake_client(lambda command, *args: one_hit() if command == "FT.SEARCH" else "OK")
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8))

    await store.recall("q", k=1, threshold=1, reinforce=False)

    assert not any(c[0] == "HINCRBY" for c in client.calls)


async def test_reinforcement_failure_never_breaks_recall_read_path() -> None:
    def handler(command: str, *args: Any) -> Any:
        if command == "FT.SEARCH":
            return one_hit()
        if command == "EXISTS":
            return 1
        if command == "HINCRBY":
            raise RuntimeError("reinforce boom")
        return "OK"

    client = fake_client(handler)
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8))

    hits = await store.recall("q", k=1, threshold=1)

    assert len(hits) == 1
    assert hits[0].item.id == "a"
