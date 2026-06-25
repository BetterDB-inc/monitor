from __future__ import annotations

from typing import Any

import pytest
from betterdb_agent_memory import MemoryStore
from betterdb_valkey_search_kit import encode_float32

from .conftest import fake_client, fake_embed

from .test_memory_store_recall import spy_embed


def hset_fields(call: list[Any]) -> dict[str, Any]:
    fields = call[2:]
    out: dict[str, Any] = {}
    for i in range(0, len(fields), 2):
        out[str(fields[i])] = fields[i + 1]
    return out


async def test_embeds_content_once_hsets_hash_and_returns_id() -> None:
    embed_fn = spy_embed(8)
    client = fake_client()
    store = MemoryStore(client=client, name="mem", embed_fn=embed_fn)

    memory_id = await store.remember(
        "the user prefers dark mode",
        thread_id="t1",
        agent_id="a1",
        namespace="user:1",
        tags=["pref", "ui"],
        source="user",
    )

    assert isinstance(memory_id, str)
    assert len(memory_id) > 0
    assert embed_fn.calls == ["the user prefers dark mode"]

    hset = client.find_call("HSET")
    assert hset is not None
    assert hset[1] == f"mem:mem:{memory_id}"

    fields = hset_fields(hset)
    assert fields["content"] == "the user prefers dark mode"
    assert fields["threadId"] == "t1"
    assert fields["agentId"] == "a1"
    assert fields["namespace"] == "user:1"
    assert fields["tags"] == "pref,ui"
    assert fields["source"] == "user"
    assert fields["importance"] == "0.5"
    assert fields["access_count"] == "0"
    assert fields["vector"] == encode_float32(await fake_embed(8)("the user prefers dark mode"))
    assert isinstance(fields["created_at"], str)
    assert fields["last_accessed_at"] == fields["created_at"]


async def test_honors_provided_importance_and_omits_absent_optional_fields() -> None:
    client = fake_client()
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(8))

    await store.remember("a bare fact", importance=0.9)

    hset = client.find_call("HSET")
    assert hset is not None
    fields = hset_fields(hset)
    assert fields["importance"] == "0.9"
    assert "tags" not in fields
    assert "threadId" not in fields
    assert "source" not in fields


async def test_throws_when_later_embedding_has_mismatched_dimension() -> None:
    class DimEmbed:
        def __init__(self) -> None:
            self.dims = 8

        async def __call__(self, text: str) -> list[float]:
            return [0.1] * self.dims

    embed_fn = DimEmbed()
    store = MemoryStore(client=fake_client(), name="mem", embed_fn=embed_fn)

    await store.remember("first")
    embed_fn.dims = 4

    with pytest.raises(ValueError, match="dimension"):
        await store.remember("second")
