from __future__ import annotations

from betterdb_retrieval import Retriever
from betterdb_retrieval.schema import RetrievalSchema

from .conftest import FakeClient

schema: RetrievalSchema = {
    "fields": {"source": {"type": "tag"}},
    "vector": {"metric": "cosine", "algorithm": "hnsw", "dims": 4},
}

ft_info = [
    "index_name",
    "docs:idx",
    "num_docs",
    "42",
    "indexing",
    "0",
    "percent_indexed",
    "0.5",
    "attributes",
    [["identifier", "embedding", "type", "VECTOR", "DIM", "4"]],
]


async def test_parses_health_snapshot() -> None:
    client = FakeClient(lambda args: ft_info)
    retriever = Retriever(client=client, name="docs", schema=schema)

    health = await retriever.health()

    assert ("FT.INFO", "docs:idx") in client.calls
    assert health.name == "docs"
    assert health.num_docs == 42
    assert health.indexing_state == "0"
    assert health.dims == 4
    assert health.percent_indexed == 50
    assert health.estimated_recall is None


async def test_invokes_recall_estimator() -> None:
    client = FakeClient(lambda args: ft_info)
    calls = []

    def estimator(snapshot):
        calls.append(snapshot)
        return 0.93

    retriever = Retriever(client=client, name="docs", schema=schema, recall_estimator=estimator)

    health = await retriever.health()

    assert len(calls) == 1
    assert health.estimated_recall == 0.93


async def test_percent_indexed_absent_is_zero() -> None:
    info = [
        "index_name",
        "docs:idx",
        "num_docs",
        "5",
        "indexing",
        "0",
        "attributes",
        [["identifier", "embedding", "type", "VECTOR", "DIM", "4"]],
    ]
    client = FakeClient(lambda args: info)
    retriever = Retriever(client=client, name="docs", schema=schema)

    health = await retriever.health()

    assert health.percent_indexed == 0


async def test_backfill_complete_percent_fraction() -> None:
    info = [
        "index_name",
        "docs:idx",
        "num_docs",
        "5",
        "indexing",
        "0",
        "backfill_complete_percent",
        "1.000000",
        "attributes",
        [["identifier", "embedding", "type", "VECTOR", "DIM", "4"]],
    ]
    client = FakeClient(lambda args: info)
    retriever = Retriever(client=client, name="docs", schema=schema)

    health = await retriever.health()

    assert health.percent_indexed == 100


async def test_percent_indexed_already_in_0_100_range() -> None:
    info = ["index_name", "docs:idx", "percent_indexed", "50"]
    client = FakeClient(lambda args: info)
    retriever = Retriever(client=client, name="docs", schema=schema)

    health = await retriever.health()

    assert health.percent_indexed == 50
