from __future__ import annotations

import pytest

from betterdb_retrieval import Retriever, UpsertEntry
from betterdb_retrieval.schema import RetrievalSchema

from .conftest import FakeClient, search_reply

schema: RetrievalSchema = {
    "fields": {"source": {"type": "tag"}},
    "vector": {"metric": "cosine", "algorithm": "hnsw", "dims": 4},
}


class FakeMetrics:
    def __init__(self) -> None:
        self.operations: list[tuple[str, float]] = []
        self.query_results: list[int] = []
        self.embedding_calls = 0

    def observe_operation(self, operation, seconds):
        self.operations.append((operation, seconds))

    def record_query_results(self, count):
        self.query_results.append(count)

    def record_embedding_call(self):
        self.embedding_calls += 1


class FakeSpan:
    def __init__(self) -> None:
        self.ended = 0

    def end(self):
        self.ended += 1


class FakeTracer:
    def __init__(self) -> None:
        self.span = FakeSpan()
        self.started: list[str] = []

    def start_span(self, name):
        self.started.append(name)
        return self.span


async def _embed_zero(_text: str) -> list[float]:
    return [0, 0, 0, 0]


async def test_records_metrics_for_query() -> None:
    metrics = FakeMetrics()
    reply = search_reply([("docs:doc:1", {"__score": "0.1", "__text": "t", "source": "docs"})])
    client = FakeClient(lambda args: reply)
    retriever = Retriever(
        client=client, name="docs", schema=schema, embed_fn=_embed_zero, metrics=metrics
    )

    await retriever.query(text="q", k=5)

    assert metrics.operations[0][0] == "query"
    assert metrics.query_results == [1]
    assert metrics.embedding_calls == 1


async def test_records_metrics_for_upsert() -> None:
    metrics = FakeMetrics()
    client = FakeClient(lambda args: "OK")
    retriever = Retriever(
        client=client, name="docs", schema=schema, embed_fn=_embed_zero, metrics=metrics
    )

    await retriever.upsert(
        [
            UpsertEntry(id="a", text="x", fields={"source": "docs"}),
            UpsertEntry(id="b", text="y", fields={"source": "docs"}),
        ]
    )

    assert metrics.operations[0][0] == "upsert"
    assert metrics.embedding_calls == 2


async def test_opens_and_closes_span_for_query() -> None:
    tracer = FakeTracer()
    client = FakeClient(lambda args: search_reply([]))
    retriever = Retriever(
        client=client, name="docs", schema=schema, embed_fn=_embed_zero, tracer=tracer
    )

    await retriever.query(text="q", k=5)

    assert tracer.started == ["retrieval.query"]
    assert tracer.span.ended == 1


async def test_records_duration_and_ends_span_when_query_throws() -> None:
    metrics = FakeMetrics()
    tracer = FakeTracer()

    async def boom(_text: str) -> list[float]:
        raise RuntimeError("embed boom")

    client = FakeClient(lambda args: search_reply([]))
    retriever = Retriever(
        client=client, name="docs", schema=schema, embed_fn=boom, metrics=metrics, tracer=tracer
    )

    with pytest.raises(RuntimeError, match="embed boom"):
        await retriever.query(text="q", k=5)

    assert metrics.operations[0][0] == "query"
    assert tracer.span.ended == 1


async def test_counts_dims_probe_embedding_call() -> None:
    metrics = FakeMetrics()
    no_dims: RetrievalSchema = {
        "fields": {"source": {"type": "tag"}},
        "vector": {"metric": "cosine", "algorithm": "hnsw"},
    }
    client = FakeClient(lambda args: search_reply([]))
    retriever = Retriever(
        client=client, name="docs", schema=no_dims, embed_fn=_embed_zero, metrics=metrics
    )

    await retriever.query(text="q", k=5)

    assert metrics.embedding_calls == 2
