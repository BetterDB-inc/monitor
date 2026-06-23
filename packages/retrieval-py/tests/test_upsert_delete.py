from __future__ import annotations

import pytest
from betterdb_valkey_search_kit import encode_float32

from betterdb_retrieval import Retriever, UpsertEntry
from betterdb_retrieval.ft_create import build_ft_create_args
from betterdb_retrieval.schema import RetrievalSchema

from .conftest import FakeClient, index_not_found_error

schema_with_dims: RetrievalSchema = {
    "fields": {"source": {"type": "tag"}, "updated": {"type": "numeric"}},
    "vector": {"metric": "cosine", "algorithm": "hnsw", "dims": 4},
}

schema_no_dims: RetrievalSchema = {
    "fields": {"source": {"type": "tag"}},
    "vector": {"metric": "cosine", "algorithm": "hnsw"},
}


def fake_embed(dims: int):
    async def embed(_text: str) -> list[float]:
        return [0.5] * dims

    return embed


async def test_probes_embed_fn_for_dims() -> None:
    embed_calls = []

    async def embed_fn(text: str) -> list[float]:
        embed_calls.append(text)
        return [0.5] * 16

    def handler(args):
        if args[0] == "FT.INFO":
            raise index_not_found_error()
        return "OK"

    client = FakeClient(handler)
    retriever = Retriever(client=client, name="docs", schema=schema_no_dims, embed_fn=embed_fn)

    await retriever.create_index()

    assert len(embed_calls) == 1
    expected_args = build_ft_create_args(
        "docs",
        {"fields": schema_no_dims["fields"], "vector": {**schema_no_dims["vector"], "dims": 16}},
    )
    assert ("FT.CREATE", *expected_args) in client.calls


async def test_throws_when_no_dims_and_no_embed_fn() -> None:
    def handler(args):
        if args[0] == "FT.INFO":
            raise index_not_found_error()
        return "OK"

    client = FakeClient(handler)
    retriever = Retriever(client=client, name="docs", schema=schema_no_dims)

    with pytest.raises(ValueError, match="provide schema.vector.dims or an embedFn"):
        await retriever.create_index()


async def test_upsert_hsets_entry_hash() -> None:
    vec = [0.1, 0.2, 0.3, 0.4]
    embed_calls = []

    async def embed_fn(text: str) -> list[float]:
        embed_calls.append(text)
        return vec

    client = FakeClient(lambda args: "OK")
    retriever = Retriever(client=client, name="docs", schema=schema_with_dims, embed_fn=embed_fn)

    await retriever.upsert(
        [
            UpsertEntry(
                id="doc:1", text="hello world", fields={"source": "docs", "updated": 1717200000}
            )
        ]
    )

    assert embed_calls == ["hello world"]
    assert (
        "HSET",
        "docs:doc:1",
        "source",
        "docs",
        "updated",
        "1717200000",
        "embedding",
        encode_float32(vec),
        "__text",
        "hello world",
    ) in client.calls


async def test_upsert_without_embed_fn() -> None:
    client = FakeClient(lambda args: "OK")
    retriever = Retriever(client=client, name="docs", schema=schema_with_dims)

    with pytest.raises(ValueError, match="embedFn"):
        await retriever.upsert([UpsertEntry(id="doc:1", text="x", fields={})])

    assert client.calls_for("HSET") == []


async def test_upsert_embedding_dim_mismatch() -> None:
    async def embed_fn(_text: str) -> list[float]:
        return [0.1, 0.2]

    client = FakeClient(lambda args: "OK")
    retriever = Retriever(client=client, name="docs", schema=schema_with_dims, embed_fn=embed_fn)

    with pytest.raises(ValueError, match="(?i)dimension"):
        await retriever.upsert([UpsertEntry(id="doc:1", text="x", fields={})])

    assert client.calls_for("HSET") == []


async def test_upsert_one_hash_per_entry() -> None:
    client = FakeClient(lambda args: "OK")
    retriever = Retriever(
        client=client, name="docs", schema=schema_with_dims, embed_fn=fake_embed(4)
    )

    await retriever.upsert(
        [
            UpsertEntry(id="a", text="first", fields={"source": "docs", "updated": 1}),
            UpsertEntry(id="b", text="second", fields={"source": "docs", "updated": 2}),
        ]
    )

    hsets = client.calls_for("HSET")
    assert len(hsets) == 2
    assert hsets[0][1] == "docs:a"
    assert hsets[1][1] == "docs:b"


async def test_upsert_empty_list_issues_no_commands() -> None:
    embed_calls = []

    async def embed_fn(text: str) -> list[float]:
        embed_calls.append(text)
        return [0.5] * 4

    client = FakeClient(lambda args: "OK")
    retriever = Retriever(client=client, name="docs", schema=schema_with_dims, embed_fn=embed_fn)

    await retriever.upsert([])

    assert client.calls == []
    assert embed_calls == []


@pytest.mark.parametrize("bad_field", ["__text", "embedding", "__score"])
async def test_upsert_rejects_reserved_fields(bad_field: str) -> None:
    client = FakeClient(lambda args: "OK")
    retriever = Retriever(
        client=client, name="docs", schema=schema_with_dims, embed_fn=fake_embed(4)
    )

    with pytest.raises(ValueError, match="(?i)reserved"):
        await retriever.upsert([UpsertEntry(id="doc:1", text="x", fields={bad_field: "oops"})])

    assert client.calls_for("HSET") == []


async def test_upsert_probes_once_caches_dims() -> None:
    embed_calls = []

    async def embed_fn(text: str) -> list[float]:
        embed_calls.append(text)
        return [0.5] * 8

    client = FakeClient(lambda args: "OK")
    retriever = Retriever(client=client, name="docs", schema=schema_no_dims, embed_fn=embed_fn)

    await retriever.upsert(
        [
            UpsertEntry(id="a", text="first", fields={"source": "docs"}),
            UpsertEntry(id="b", text="second", fields={"source": "docs"}),
        ]
    )

    assert len(embed_calls) == 3
    assert embed_calls[0] == "probe"


async def test_upsert_zero_length_probe() -> None:
    async def embed_fn(_text: str) -> list[float]:
        return []

    client = FakeClient(lambda args: "OK")
    retriever = Retriever(client=client, name="docs", schema=schema_no_dims, embed_fn=embed_fn)

    with pytest.raises(ValueError, match="(?i)dimension"):
        await retriever.upsert([UpsertEntry(id="doc:1", text="x", fields={"source": "docs"})])

    assert client.calls_for("HSET") == []


async def test_upsert_non_positive_dims() -> None:
    schema_bad: RetrievalSchema = {
        "fields": {"source": {"type": "tag"}},
        "vector": {"metric": "cosine", "algorithm": "hnsw", "dims": 0},
    }
    embed_calls = []

    async def embed_fn(text: str) -> list[float]:
        embed_calls.append(text)
        return [0.5] * 4

    client = FakeClient(lambda args: "OK")
    retriever = Retriever(client=client, name="docs", schema=schema_bad, embed_fn=embed_fn)

    with pytest.raises(ValueError, match="(?i)dims"):
        await retriever.upsert([UpsertEntry(id="doc:1", text="x", fields={"source": "docs"})])

    assert embed_calls == []


async def test_upsert_batch_atomic_on_later_invalid_entry() -> None:
    client = FakeClient(lambda args: "OK")
    retriever = Retriever(
        client=client, name="docs", schema=schema_with_dims, embed_fn=fake_embed(4)
    )

    with pytest.raises(ValueError, match="(?i)reserved"):
        await retriever.upsert(
            [
                UpsertEntry(id="good", text="first", fields={"source": "docs"}),
                UpsertEntry(id="bad", text="second", fields={"__text": "oops"}),
            ]
        )

    assert client.calls_for("HSET") == []


async def test_delete_dels_derived_keys() -> None:
    client = FakeClient(lambda args: 2)
    retriever = Retriever(client=client, name="docs", schema=schema_with_dims)

    await retriever.delete(["doc:1", "doc:2"])

    assert ("DEL", "docs:doc:1", "docs:doc:2") in client.calls


async def test_delete_empty_list() -> None:
    client = FakeClient(lambda args: 0)
    retriever = Retriever(client=client, name="docs", schema=schema_with_dims)

    await retriever.delete([])

    assert client.calls == []
