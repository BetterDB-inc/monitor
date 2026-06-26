from __future__ import annotations

import pytest
from betterdb_valkey_search_kit import encode_float32

from betterdb_retrieval import QueryHit, Retriever
from betterdb_retrieval.schema import RetrievalSchema

from .conftest import FakeClient, index_not_found_error, search_reply

schema: RetrievalSchema = {
    "fields": {"source": {"type": "tag"}, "updated": {"type": "numeric"}},
    "vector": {"metric": "cosine", "algorithm": "hnsw", "dims": 4},
}


async def test_embeds_runs_search_and_maps_hits() -> None:
    vec = [0.1, 0.2, 0.3, 0.4]
    embed_calls = []

    async def embed_fn(text: str) -> list[float]:
        embed_calls.append(text)
        return vec

    reply = search_reply(
        [
            (
                "docs:doc:1",
                {
                    "source": "docs",
                    "updated": "1717200000",
                    "__text": "hello world",
                    "__score": "0.12",
                    "embedding": "rawbytes",
                },
            )
        ]
    )
    client = FakeClient(lambda args: reply)
    retriever = Retriever(client=client, name="docs", schema=schema, embed_fn=embed_fn)

    hits = await retriever.query(text="hi", k=10, filter={"source": "docs"})

    assert embed_calls == ["hi"]
    assert (
        "FT.SEARCH",
        "docs:idx",
        "(@source:{docs})=>[KNN 10 @embedding $vec AS __score]",
        "PARAMS",
        "2",
        "vec",
        encode_float32(vec),
        "LIMIT",
        "0",
        "10",
        "DIALECT",
        "2",
    ) in client.calls
    assert hits == [
        QueryHit(
            id="doc:1",
            score=0.12,
            text="hello world",
            fields={"source": "docs", "updated": "1717200000"},
        )
    ]


async def test_precomputed_vector_skips_embed() -> None:
    vec = [0.5, 0.5, 0.5, 0.5]
    embed_calls = []

    async def embed_fn(_text: str) -> list[float]:
        embed_calls.append(_text)
        return [0, 0, 0, 0]

    client = FakeClient(lambda args: search_reply([]))
    retriever = Retriever(client=client, name="docs", schema=schema, embed_fn=embed_fn)

    await retriever.query(vector=vec, k=5)

    assert embed_calls == []
    assert (
        "FT.SEARCH",
        "docs:idx",
        "*=>[KNN 5 @embedding $vec AS __score]",
        "PARAMS",
        "2",
        "vec",
        encode_float32(vec),
        "LIMIT",
        "0",
        "5",
        "DIALECT",
        "2",
    ) in client.calls


async def test_throws_when_both_text_and_vector() -> None:
    client = FakeClient(lambda args: search_reply([]))
    retriever = Retriever(client=client, name="docs", schema=schema, embed_fn=_unused_embed)

    with pytest.raises(ValueError, match="(?i)both"):
        await retriever.query(text="a", vector=[1, 2, 3, 4], k=5)

    assert client.calls == []


async def test_throws_when_neither_text_nor_vector() -> None:
    client = FakeClient(lambda args: search_reply([]))
    retriever = Retriever(client=client, name="docs", schema=schema)

    with pytest.raises(ValueError, match="(?i)text or"):
        await retriever.query(k=5)

    assert client.calls == []


async def test_empty_result() -> None:
    client = FakeClient(lambda args: search_reply([]))
    retriever = Retriever(client=client, name="docs", schema=schema, embed_fn=_unused_embed)

    hits = await retriever.query(text="x", k=5)

    assert hits == []


async def test_rerank_reorders_hits() -> None:
    reply = search_reply(
        [
            ("docs:a", {"__text": "first", "__score": "0.9", "source": "docs"}),
            ("docs:b", {"__text": "second", "__score": "0.8", "source": "docs"}),
        ]
    )
    passed = []

    async def rerank_fn(_query_text: str, hits: list[QueryHit]) -> list[QueryHit]:
        passed.append(list(hits))
        return list(reversed(hits))

    client = FakeClient(lambda args: reply)
    retriever = Retriever(
        client=client, name="docs", schema=schema, embed_fn=_unused_embed, rerank_fn=rerank_fn
    )

    hits = await retriever.query(text="q", k=5, hybrid="rerank")

    assert passed[0] == [
        QueryHit(id="a", score=0.9, text="first", fields={"source": "docs"}),
        QueryHit(id="b", score=0.8, text="second", fields={"source": "docs"}),
    ]
    assert [h.id for h in hits] == ["b", "a"]


async def test_rerank_without_rerank_fn() -> None:
    client = FakeClient(lambda args: search_reply([]))
    retriever = Retriever(client=client, name="docs", schema=schema, embed_fn=_unused_embed)

    with pytest.raises(ValueError, match="rerankFn"):
        await retriever.query(text="q", k=5, hybrid="rerank")

    assert client.calls == []


async def test_rerank_without_text() -> None:
    async def rerank_fn(_q: str, hits: list[QueryHit]) -> list[QueryHit]:
        return hits

    client = FakeClient(lambda args: search_reply([]))
    retriever = Retriever(client=client, name="docs", schema=schema, rerank_fn=rerank_fn)

    with pytest.raises(ValueError, match="(?i)text"):
        await retriever.query(vector=[1, 2, 3, 4], k=5, hybrid="rerank")

    assert client.calls == []


@pytest.mark.parametrize("k", [0, -1, 1.5])
async def test_k_must_be_positive_integer(k) -> None:
    client = FakeClient(lambda args: search_reply([]))
    retriever = Retriever(client=client, name="docs", schema=schema, embed_fn=_unused_embed)

    with pytest.raises(ValueError, match="(?i)positive integer"):
        await retriever.query(text="x", k=k)

    assert client.calls == []


async def test_precomputed_vector_wrong_dimension() -> None:
    client = FakeClient(lambda args: search_reply([]))
    retriever = Retriever(client=client, name="docs", schema=schema)

    with pytest.raises(ValueError, match="(?i)dimension"):
        await retriever.query(vector=[1, 2], k=5)

    assert client.calls == []


async def test_precomputed_vector_mismatches_cached_dims() -> None:
    no_dims: RetrievalSchema = {
        "fields": {"source": {"type": "tag"}},
        "vector": {"metric": "cosine", "algorithm": "hnsw"},
    }

    def handler(args):
        if args[0] == "FT.INFO":
            raise index_not_found_error()
        return search_reply([])

    client = FakeClient(handler)
    retriever = Retriever(client=client, name="docs", schema=no_dims, embed_fn=_unused_embed)

    await retriever.create_index()

    with pytest.raises(ValueError, match="(?i)dimension"):
        await retriever.query(vector=[1, 2], k=5)

    assert client.calls_for("FT.SEARCH") == []


async def test_precomputed_vector_against_inferred_dims_before_index() -> None:
    no_dims: RetrievalSchema = {
        "fields": {"source": {"type": "tag"}},
        "vector": {"metric": "cosine", "algorithm": "hnsw"},
    }
    client = FakeClient(lambda args: search_reply([]))
    retriever = Retriever(client=client, name="docs", schema=no_dims, embed_fn=_unused_embed)

    with pytest.raises(ValueError, match="(?i)dimension"):
        await retriever.query(vector=[1, 2], k=5)

    assert client.calls_for("FT.SEARCH") == []


async def _unused_embed(_text: str) -> list[float]:
    return [0, 0, 0, 0]
