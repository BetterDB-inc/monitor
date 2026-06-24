from __future__ import annotations

import pytest
from betterdb_agent_memory import MemoryStore

from .conftest import fake_client


def test_constructs_without_an_embed_fn() -> None:
    MemoryStore(client=fake_client(), name="mem")


async def test_remember_rejects_with_clear_error_when_embed_fn_absent() -> None:
    store = MemoryStore(client=fake_client(), name="mem")
    with pytest.raises(ValueError, match="embed_fn"):
        await store.remember("hi")


async def test_recall_rejects_with_clear_error_when_embed_fn_absent() -> None:
    store = MemoryStore(client=fake_client(), name="mem")
    with pytest.raises(ValueError, match="embed_fn"):
        await store.recall("hi")
