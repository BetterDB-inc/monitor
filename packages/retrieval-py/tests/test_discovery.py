from __future__ import annotations

import json

from betterdb_retrieval import Retriever
from betterdb_retrieval.discovery import REGISTRY_KEY, build_retrieval_marker
from betterdb_retrieval.schema import RetrievalSchema

from .conftest import FakeClient

schema: RetrievalSchema = {
    "fields": {"source": {"type": "tag"}},
    "vector": {"metric": "cosine", "algorithm": "hnsw", "dims": 4},
}


def test_build_retrieval_marker() -> None:
    assert build_retrieval_marker(
        name="docs", version="0.1.0", started_at="2026-06-15T00:00:00.000Z"
    ) == {
        "type": "retrieval",
        "prefix": "docs",
        "version": "0.1.0",
        "protocol_version": 1,
        "capabilities": ["upsert", "query", "delete"],
        "index_name": "docs:idx",
        "started_at": "2026-06-15T00:00:00.000Z",
    }


async def test_register_writes_marker() -> None:
    client = FakeClient(lambda args: None if args[0] == "HGET" else 1)
    retriever = Retriever(client=client, name="docs", schema=schema)

    await retriever.register()

    hset = client.calls_for("HSET")[0]
    assert hset[1] == REGISTRY_KEY
    assert hset[2] == "docs"
    marker = json.loads(hset[3])
    assert marker["type"] == "retrieval"
    assert marker["prefix"] == "docs"
    assert isinstance(marker["started_at"], str)


async def test_register_does_not_overwrite_foreign_marker(caplog) -> None:
    client = FakeClient(
        lambda args: json.dumps({"type": "agent_cache"}) if args[0] == "HGET" else 1
    )
    retriever = Retriever(client=client, name="docs", schema=schema)

    await retriever.register()

    assert client.calls_for("HSET") == []


async def test_unregister_deletes_own_marker() -> None:
    client = FakeClient(lambda args: json.dumps({"type": "retrieval"}) if args[0] == "HGET" else 1)
    retriever = Retriever(client=client, name="docs", schema=schema)

    await retriever.unregister()

    assert ("HDEL", REGISTRY_KEY, "docs") in client.calls


async def test_unregister_does_not_delete_foreign_marker() -> None:
    client = FakeClient(
        lambda args: json.dumps({"type": "agent_cache"}) if args[0] == "HGET" else 1
    )
    retriever = Retriever(client=client, name="docs", schema=schema)

    await retriever.unregister()

    assert client.calls_for("HDEL") == []
