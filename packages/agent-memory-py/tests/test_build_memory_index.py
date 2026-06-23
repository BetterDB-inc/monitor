from __future__ import annotations

import pytest
from betterdb_agent_memory.build_memory_index import (
    MEMORY_INDEX_ALGORITHM,
    build_memory_index_args,
    memory_index_name,
    memory_key_prefix,
)


def test_names_index_and_key_prefix_off_store_name() -> None:
    assert memory_index_name("mem") == "mem:mem:idx"
    assert memory_key_prefix("mem") == "mem:mem:"


def test_builds_ft_create_arg_list_scoped_to_keyspace() -> None:
    args = build_memory_index_args("mem", 16)
    assert args[:7] == ["mem:mem:idx", "ON", "HASH", "PREFIX", "1", "mem:mem:", "SCHEMA"]


def test_declares_vector_field_with_dimension_and_cosine_metric() -> None:
    args = build_memory_index_args("mem", 16)
    vec = args.index("vector")
    assert args[vec : vec + 12] == [
        "vector",
        "VECTOR",
        MEMORY_INDEX_ALGORITHM,
        "6",
        "TYPE",
        "FLOAT32",
        "DIM",
        "16",
        "DISTANCE_METRIC",
        "COSINE",
        "threadId",
        "TAG",
    ]


def test_indexes_scope_tag_fields_and_tags_separator() -> None:
    joined = " ".join(build_memory_index_args("mem", 16))
    assert "threadId TAG" in joined
    assert "agentId TAG" in joined
    assert "namespace TAG" in joined
    assert "tags TAG SEPARATOR ," in joined
    assert "source TAG" in joined


def test_indexes_numeric_tunables_and_content_text() -> None:
    joined = " ".join(build_memory_index_args("mem", 16))
    for field in ["importance", "created_at", "last_accessed_at", "access_count"]:
        assert f"{field} NUMERIC" in joined
    assert "content TEXT" in joined


def test_rejects_non_positive_or_non_integer_dimension() -> None:
    with pytest.raises(ValueError, match="positive integer"):
        build_memory_index_args("mem", 0)
    with pytest.raises(ValueError, match="positive integer"):
        build_memory_index_args("mem", -4)
    with pytest.raises(ValueError, match="positive integer"):
        build_memory_index_args("mem", 1.5)
