from __future__ import annotations

import json
import logging

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
    # The atomic register script returns nil when it wrote our marker.
    client = FakeClient(lambda args: None)
    retriever = Retriever(client=client, name="docs", schema=schema)

    await retriever.register()

    eval_call = client.calls_for("EVAL")[0]
    # ("EVAL", script, numkeys, KEYS[1], ARGV[1], ARGV[2], ARGV[3])
    assert eval_call[3] == REGISTRY_KEY
    assert eval_call[4] == "docs"
    marker = json.loads(eval_call[5])
    assert marker["type"] == "retrieval"
    assert marker["prefix"] == "docs"
    assert isinstance(marker["started_at"], str)
    assert eval_call[6] == "retrieval"
    # Never a raw HSET — the compare-and-set happens atomically server-side.
    assert client.calls_for("HSET") == []


async def test_register_does_not_overwrite_foreign_marker(caplog) -> None:
    # The script returns the foreign type when it skips the write.
    client = FakeClient(lambda args: b"agent_cache")
    retriever = Retriever(client=client, name="docs", schema=schema)

    with caplog.at_level(logging.WARNING):
        await retriever.register()

    assert client.calls_for("HSET") == []
    assert any("agent_cache" in r.getMessage() for r in caplog.records)


async def test_unregister_deletes_own_marker() -> None:
    # The atomic unregister script returns the HDEL count when it owned the field.
    client = FakeClient(lambda args: 1)
    retriever = Retriever(client=client, name="docs", schema=schema)

    await retriever.unregister()

    eval_call = client.calls_for("EVAL")[0]
    # ("EVAL", script, numkeys, KEYS[1], ARGV[1], ARGV[2])
    assert eval_call[3] == REGISTRY_KEY
    assert eval_call[4] == "docs"
    assert eval_call[5] == "retrieval"
    # Never a raw HDEL — the ownership check happens atomically server-side.
    assert client.calls_for("HDEL") == []


async def test_unregister_never_issues_a_raw_hdel() -> None:
    # Even when the field is foreign (script returns 0), we only ever delegate to
    # the ownership-guarded script, never a direct HDEL that could clobber it.
    client = FakeClient(lambda args: 0)
    retriever = Retriever(client=client, name="docs", schema=schema)

    await retriever.unregister()

    assert client.calls_for("HDEL") == []
    assert client.calls_for("EVAL")[0][5] == "retrieval"
