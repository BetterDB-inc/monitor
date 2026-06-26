from __future__ import annotations

from typing import Any

import pytest
from betterdb_agent_memory import MemoryStore
from betterdb_agent_memory.build_memory_index import build_memory_index_args

from .conftest import fake_client, fake_embed

from .test_memory_store_recall import spy_embed


def index_not_found() -> Exception:
    return RuntimeError("Unknown index name 'mem:mem:idx'")


async def test_creates_index_with_memory_schema_when_absent() -> None:
    def handler(command: str, *args: Any) -> Any:
        if command == "FT.INFO":
            raise index_not_found()
        return "OK"

    client = fake_client(handler)
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(16))

    await store.ensure_index()

    create = client.find_call("FT.CREATE")
    assert create == ["FT.CREATE", *build_memory_index_args("mem", 16)]


async def test_ensure_index_is_idempotent() -> None:
    def handler(command: str, *args: Any) -> Any:
        if command == "FT.INFO":
            return ["index_name", "mem:mem:idx"]
        return "OK"

    client = fake_client(handler)
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(16))

    await store.ensure_index()

    assert not any(c[0] == "FT.CREATE" for c in client.calls)


async def test_resolves_dimension_from_embed_fn_when_none_observed() -> None:
    def handler(command: str, *args: Any) -> Any:
        if command == "FT.INFO":
            raise index_not_found()
        return "OK"

    client = fake_client(handler)
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(32))

    await store.ensure_index()

    create = client.find_call("FT.CREATE")
    dim_idx = create.index("DIM")
    assert create[dim_idx + 1] == "32"


async def test_reuses_observed_dimension_without_reprobing() -> None:
    embed_fn = spy_embed(16)

    def handler(command: str, *args: Any) -> Any:
        if command == "FT.INFO":
            raise index_not_found()
        return "OK"

    client = fake_client(handler)
    store = MemoryStore(client=client, name="mem", embed_fn=embed_fn)
    await store.remember("seed")
    calls_after_write = len(embed_fn.calls)

    await store.ensure_index()

    assert len(embed_fn.calls) == calls_after_write
    create = client.find_call("FT.CREATE")
    dim_idx = create.index("DIM")
    assert create[dim_idx + 1] == "16"


async def test_rethrows_ft_info_errors_that_are_not_index_not_found() -> None:
    def handler(command: str, *args: Any) -> Any:
        if command == "FT.INFO":
            raise RuntimeError("CONNECTION BROKEN")
        return "OK"

    client = fake_client(handler)
    store = MemoryStore(client=client, name="mem", embed_fn=fake_embed(16))

    with pytest.raises(RuntimeError, match="(?i)connection broken"):
        await store.ensure_index()
    assert not any(c[0] == "FT.CREATE" for c in client.calls)
