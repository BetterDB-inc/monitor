from __future__ import annotations

from .build_recall_query import VECTOR_FIELD

MEMORY_INDEX_ALGORITHM = "HNSW"


def memory_index_name(name: str) -> str:
    return f"{name}:mem:idx"


def memory_key_prefix(name: str) -> str:
    return f"{name}:mem:"


def build_memory_index_args(name: str, dims: int) -> list[str]:
    if not isinstance(dims, int) or isinstance(dims, bool) or dims <= 0:
        raise ValueError(f"memory index dimension must be a positive integer, got: {dims}")
    return [
        memory_index_name(name),
        "ON",
        "HASH",
        "PREFIX",
        "1",
        memory_key_prefix(name),
        "SCHEMA",
        VECTOR_FIELD,
        "VECTOR",
        MEMORY_INDEX_ALGORITHM,
        "6",
        "TYPE",
        "FLOAT32",
        "DIM",
        str(dims),
        "DISTANCE_METRIC",
        "COSINE",
        "threadId",
        "TAG",
        "agentId",
        "TAG",
        "namespace",
        "TAG",
        "tags",
        "TAG",
        "SEPARATOR",
        ",",
        "source",
        "TAG",
        "importance",
        "NUMERIC",
        "created_at",
        "NUMERIC",
        "last_accessed_at",
        "NUMERIC",
        "access_count",
        "NUMERIC",
        "content",
        "TEXT",
    ]
