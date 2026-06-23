from __future__ import annotations

import pytest

from betterdb_retrieval.ft_create import build_ft_create_args, index_name, key_prefix
from betterdb_retrieval.schema import RetrievalSchema


def test_minimal_schema_hnsw_defaults() -> None:
    schema: RetrievalSchema = {
        "fields": {},
        "vector": {"metric": "cosine", "algorithm": "hnsw", "dims": 128},
    }
    assert build_ft_create_args("myidx", schema) == [
        "myidx:idx",
        "ON",
        "HASH",
        "PREFIX",
        "1",
        "myidx:",
        "SCHEMA",
        "embedding",
        "VECTOR",
        "HNSW",
        "12",
        "TYPE",
        "FLOAT32",
        "DIM",
        "128",
        "DISTANCE_METRIC",
        "COSINE",
        "M",
        "16",
        "EF_CONSTRUCTION",
        "200",
        "EF_RUNTIME",
        "10",
    ]


def test_all_three_field_types() -> None:
    schema: RetrievalSchema = {
        "fields": {
            "title": {"type": "text"},
            "category": {"type": "tag", "separator": "|"},
            "score": {"type": "numeric", "sortable": True},
        },
        "vector": {"metric": "l2", "algorithm": "hnsw", "dims": 64},
    }
    assert build_ft_create_args("docs", schema) == [
        "docs:idx",
        "ON",
        "HASH",
        "PREFIX",
        "1",
        "docs:",
        "SCHEMA",
        "title",
        "TEXT",
        "category",
        "TAG",
        "SEPARATOR",
        "|",
        "score",
        "NUMERIC",
        "SORTABLE",
        "embedding",
        "VECTOR",
        "HNSW",
        "12",
        "TYPE",
        "FLOAT32",
        "DIM",
        "64",
        "DISTANCE_METRIC",
        "L2",
        "M",
        "16",
        "EF_CONSTRUCTION",
        "200",
        "EF_RUNTIME",
        "10",
    ]


def test_tag_without_separator() -> None:
    schema: RetrievalSchema = {
        "fields": {"tag_field": {"type": "tag"}},
        "vector": {"metric": "cosine", "algorithm": "hnsw", "dims": 8},
    }
    args = build_ft_create_args("t", schema)
    i = args.index("SCHEMA")
    assert args[i + 1 : i + 3] == ["tag_field", "TAG"]
    assert args[i + 3] != "SEPARATOR"


def test_numeric_without_sortable() -> None:
    schema: RetrievalSchema = {
        "fields": {"count": {"type": "numeric"}},
        "vector": {"metric": "cosine", "algorithm": "hnsw", "dims": 8},
    }
    args = build_ft_create_args("t", schema)
    i = args.index("SCHEMA")
    assert args[i + 1 : i + 3] == ["count", "NUMERIC"]
    assert args[i + 3] != "SORTABLE"


def test_hnsw_overrides_and_custom_field_name() -> None:
    schema: RetrievalSchema = {
        "fields": {},
        "vector": {
            "metric": "ip",
            "algorithm": "hnsw",
            "dims": 256,
            "fieldName": "vec",
            "m": 32,
            "efConstruction": 400,
            "efRuntime": 50,
        },
    }
    assert build_ft_create_args("custom", schema) == [
        "custom:idx",
        "ON",
        "HASH",
        "PREFIX",
        "1",
        "custom:",
        "SCHEMA",
        "vec",
        "VECTOR",
        "HNSW",
        "12",
        "TYPE",
        "FLOAT32",
        "DIM",
        "256",
        "DISTANCE_METRIC",
        "IP",
        "M",
        "32",
        "EF_CONSTRUCTION",
        "400",
        "EF_RUNTIME",
        "50",
    ]


def test_flat_algorithm() -> None:
    schema: RetrievalSchema = {
        "fields": {},
        "vector": {"metric": "cosine", "algorithm": "flat", "dims": 32},
    }
    assert build_ft_create_args("flatidx", schema) == [
        "flatidx:idx",
        "ON",
        "HASH",
        "PREFIX",
        "1",
        "flatidx:",
        "SCHEMA",
        "embedding",
        "VECTOR",
        "FLAT",
        "6",
        "TYPE",
        "FLOAT32",
        "DIM",
        "32",
        "DISTANCE_METRIC",
        "COSINE",
    ]


@pytest.mark.parametrize("param", ["m", "efConstruction", "efRuntime"])
def test_flat_rejects_hnsw_params(param: str) -> None:
    schema: RetrievalSchema = {
        "fields": {},
        "vector": {"metric": "cosine", "algorithm": "flat", "dims": 32, param: 16},
    }
    with pytest.raises(ValueError):
        build_ft_create_args("bad", schema)


def test_flat_missing_dims() -> None:
    schema: RetrievalSchema = {
        "fields": {},
        "vector": {"metric": "cosine", "algorithm": "flat"},
    }
    with pytest.raises(ValueError, match="dims must be a positive integer"):
        build_ft_create_args("bad", schema)


def test_flat_invalid_dims() -> None:
    schema: RetrievalSchema = {
        "fields": {},
        "vector": {"metric": "cosine", "algorithm": "flat", "dims": -5},
    }
    with pytest.raises(ValueError, match="dims must be a positive integer"):
        build_ft_create_args("bad", schema)


@pytest.mark.parametrize("metric,expected", [("cosine", "COSINE"), ("l2", "L2"), ("ip", "IP")])
def test_metric_mapping(metric: str, expected: str) -> None:
    schema: RetrievalSchema = {
        "fields": {},
        "vector": {"metric": metric, "algorithm": "hnsw", "dims": 4},
    }
    args = build_ft_create_args("m", schema)
    assert args[args.index("DISTANCE_METRIC") + 1] == expected


def test_text_fields_emitted_when_capabilities_omitted() -> None:
    schema: RetrievalSchema = {
        "fields": {"body": {"type": "text"}},
        "vector": {"metric": "cosine", "algorithm": "hnsw", "dims": 4},
    }
    assert "TEXT" in build_ft_create_args("n", schema)


def test_text_fields_emitted_when_capability_true() -> None:
    schema: RetrievalSchema = {
        "fields": {"body": {"type": "text"}},
        "vector": {"metric": "cosine", "algorithm": "hnsw", "dims": 4},
    }
    assert "TEXT" in build_ft_create_args("n", schema, {"textFields": True})


def test_text_fields_rejected_when_capability_false_lists_names() -> None:
    schema: RetrievalSchema = {
        "fields": {"title": {"type": "text"}, "body": {"type": "text"}},
        "vector": {"metric": "cosine", "algorithm": "hnsw", "dims": 4},
    }
    with pytest.raises(ValueError, match="title"):
        build_ft_create_args("n", schema, {"textFields": False})
    with pytest.raises(ValueError, match="body"):
        build_ft_create_args("n", schema, {"textFields": False})


def test_no_text_fields_capability_false_ok() -> None:
    schema: RetrievalSchema = {
        "fields": {"category": {"type": "tag"}},
        "vector": {"metric": "cosine", "algorithm": "hnsw", "dims": 4},
    }
    build_ft_create_args("n", schema, {"textFields": False})


@pytest.mark.parametrize("dims", [None, 0, -1, 1.5])
def test_dims_validation(dims: object) -> None:
    vector = {"metric": "cosine", "algorithm": "hnsw"}
    if dims is not None:
        vector["dims"] = dims
    schema: RetrievalSchema = {"fields": {}, "vector": vector}  # type: ignore[typeddict-item]
    with pytest.raises(ValueError, match="dims must be a positive integer"):
        build_ft_create_args("n", schema)


def test_field_name_empty() -> None:
    schema: RetrievalSchema = {
        "fields": {"": {"type": "tag"}},
        "vector": {"metric": "cosine", "algorithm": "hnsw", "dims": 4},
    }
    with pytest.raises(ValueError):
        build_ft_create_args("n", schema)


def test_field_name_collides_default_vector_field() -> None:
    schema: RetrievalSchema = {
        "fields": {"embedding": {"type": "tag"}},
        "vector": {"metric": "cosine", "algorithm": "hnsw", "dims": 4},
    }
    with pytest.raises(ValueError, match="embedding"):
        build_ft_create_args("n", schema)


def test_field_name_collides_custom_vector_field() -> None:
    schema: RetrievalSchema = {
        "fields": {"vec": {"type": "tag"}},
        "vector": {"metric": "cosine", "algorithm": "hnsw", "dims": 4, "fieldName": "vec"},
    }
    with pytest.raises(ValueError, match="vec"):
        build_ft_create_args("n", schema)


@pytest.mark.parametrize("name", ["", "   "])
def test_index_name_validation(name: str) -> None:
    schema: RetrievalSchema = {
        "fields": {},
        "vector": {"metric": "cosine", "algorithm": "hnsw", "dims": 4},
    }
    with pytest.raises(ValueError, match="Index name must not be empty"):
        build_ft_create_args(name, schema)


@pytest.mark.parametrize("field_name", ["", "   "])
def test_vector_field_name_validation(field_name: str) -> None:
    schema: RetrievalSchema = {
        "fields": {},
        "vector": {"metric": "cosine", "algorithm": "hnsw", "dims": 4, "fieldName": field_name},
    }
    with pytest.raises(ValueError, match="Vector field name must not be empty"):
        build_ft_create_args("n", schema)


@pytest.mark.parametrize("reserved", ["__score", "__text"])
def test_reserved_field_names(reserved: str) -> None:
    schema: RetrievalSchema = {
        "fields": {reserved: {"type": "tag"}},
        "vector": {"metric": "cosine", "algorithm": "hnsw", "dims": 4},
    }
    with pytest.raises(ValueError, match="reserved"):
        build_ft_create_args("docs", schema)


def test_index_name_helper() -> None:
    assert index_name("docs") == "docs:idx"
    with pytest.raises(ValueError, match="Index name must not be empty"):
        index_name("")


def test_key_prefix_helper() -> None:
    assert key_prefix("docs") == "docs:"
    with pytest.raises(ValueError, match="Index name must not be empty"):
        key_prefix("")
