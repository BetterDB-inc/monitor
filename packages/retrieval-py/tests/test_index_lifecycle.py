from __future__ import annotations

import pytest

from betterdb_retrieval import IndexDescription, Retriever
from betterdb_retrieval.ft_create import build_ft_create_args
from betterdb_retrieval.schema import RetrievalSchema

from .conftest import FakeClient, index_not_found_error

schema: RetrievalSchema = {
    "fields": {"source": {"type": "tag"}},
    "vector": {"metric": "cosine", "algorithm": "hnsw", "dims": 8},
}


async def test_create_index_issues_ft_create_when_missing() -> None:
    def handler(args):
        if args[0] == "FT.INFO":
            raise index_not_found_error()
        return "OK"

    client = FakeClient(handler)
    retriever = Retriever(client=client, name="docs", schema=schema)

    await retriever.create_index()

    assert ("FT.INFO", "docs:idx") in client.calls
    assert ("FT.CREATE", *build_ft_create_args("docs", schema)) in client.calls


async def test_create_index_skips_when_index_exists() -> None:
    def handler(args):
        if args[0] == "FT.INFO":
            return ["index_name", "docs:idx", "num_docs", "0"]
        return "OK"

    client = FakeClient(handler)
    retriever = Retriever(client=client, name="docs", schema=schema)

    await retriever.create_index()

    assert client.calls_for("FT.CREATE") == []


async def test_create_index_rethrows_non_index_error() -> None:
    boom = RuntimeError("LOADING Valkey is loading the dataset in memory")

    def handler(args):
        if args[0] == "FT.INFO":
            raise boom
        return "OK"

    client = FakeClient(handler)
    retriever = Retriever(client=client, name="docs", schema=schema)

    with pytest.raises(RuntimeError, match="LOADING"):
        await retriever.create_index()

    assert client.calls_for("FT.CREATE") == []


async def test_create_index_tolerates_concurrent_creation() -> None:
    # FT.INFO says not-found, but a racing worker creates the index before our
    # FT.CREATE, which then raises "Index already exists" — must be swallowed.
    def handler(args):
        if args[0] == "FT.INFO":
            raise index_not_found_error()
        if args[0] == "FT.CREATE":
            raise RuntimeError("Index already exists")
        return "OK"

    client = FakeClient(handler)
    retriever = Retriever(client=client, name="docs", schema=schema)

    await retriever.create_index()

    assert client.calls_for("FT.CREATE") != []


async def test_create_index_rethrows_non_already_exists_create_error() -> None:
    def handler(args):
        if args[0] == "FT.INFO":
            raise index_not_found_error()
        if args[0] == "FT.CREATE":
            raise RuntimeError("OOM command not allowed when used memory > 'maxmemory'")
        return "OK"

    client = FakeClient(handler)
    retriever = Retriever(client=client, name="docs", schema=schema)

    with pytest.raises(RuntimeError, match="OOM"):
        await retriever.create_index()


async def test_drop_index_issues_ft_dropindex() -> None:
    client = FakeClient(lambda args: "OK")
    retriever = Retriever(client=client, name="docs", schema=schema)

    await retriever.drop_index()

    assert ("FT.DROPINDEX", "docs:idx") in client.calls


async def test_drop_index_tolerates_missing_index() -> None:
    def handler(args):
        raise index_not_found_error()

    client = FakeClient(handler)
    retriever = Retriever(client=client, name="docs", schema=schema)

    await retriever.drop_index()


async def test_drop_index_rethrows_non_index_error() -> None:
    boom = RuntimeError("READONLY You can not write against a read only replica")

    def handler(args):
        raise boom

    client = FakeClient(handler)
    retriever = Retriever(client=client, name="docs", schema=schema)

    with pytest.raises(RuntimeError, match="READONLY"):
        await retriever.drop_index()


async def test_describe_index_parses_ft_info() -> None:
    info = [
        "index_name",
        "docs:idx",
        "num_docs",
        "42",
        "indexing",
        "0",
        "attributes",
        [["identifier", "embedding", "type", "VECTOR", "DIM", "8"]],
    ]

    def handler(args):
        if args[0] == "FT.INFO":
            return info
        return "OK"

    client = FakeClient(handler)
    retriever = Retriever(client=client, name="docs", schema=schema)

    description = await retriever.describe_index()

    assert ("FT.INFO", "docs:idx") in client.calls
    assert description == IndexDescription(name="docs", dims=8, num_docs=42, indexing_state="0")


async def test_describe_index_propagates_missing_index_error() -> None:
    def handler(args):
        raise index_not_found_error()

    client = FakeClient(handler)
    retriever = Retriever(client=client, name="docs", schema=schema)

    with pytest.raises(Exception, match="Unknown index name"):
        await retriever.describe_index()
