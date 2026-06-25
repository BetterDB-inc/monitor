from __future__ import annotations

from typing import Any

import pytest
from betterdb_agent_memory.build_memory_record import build_memory_record
from betterdb_valkey_search_kit import encode_float32


def to_object(fields: list[Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for i in range(0, len(fields), 2):
        out[str(fields[i])] = fields[i + 1]
    return out


def test_builds_key_and_deterministic_field_list() -> None:
    vector = [0.1, 0.2, 0.3, 0.4]
    record = build_memory_record(
        "mem",
        "id1",
        "hello world",
        vector,
        thread_id="t",
        agent_id="a",
        namespace="n",
        tags=["x", "y"],
        importance=0.7,
        source="user",
        now=1000,
    )

    assert record.key == "mem:mem:id1"
    f = to_object(record.fields)
    assert f["content"] == "hello world"
    assert f["importance"] == "0.7"
    assert f["tags"] == "x,y"
    assert f["threadId"] == "t"
    assert f["agentId"] == "a"
    assert f["namespace"] == "n"
    assert f["source"] == "user"
    assert f["created_at"] == "1000"
    assert f["last_accessed_at"] == "1000"
    assert f["access_count"] == "0"
    assert f["vector"] == encode_float32(vector)


def test_defaults_importance_and_omits_absent_optional_fields() -> None:
    record = build_memory_record("mem", "id2", "x", [0, 0], now=5)

    f = to_object(record.fields)
    assert f["importance"] == "0.5"
    assert "tags" not in f
    assert "threadId" not in f
    assert "source" not in f


def test_throws_when_tag_contains_comma() -> None:
    with pytest.raises(ValueError, match="comma"):
        build_memory_record("mem", "id3", "x", [0, 0], tags=["tool:web,search"], now=5)


def test_rejects_importance_outside_bounds_or_non_finite() -> None:
    for bad in [float("nan"), float("inf"), float("-inf"), -0.1, 1.5, 42]:
        with pytest.raises(ValueError, match="importance"):
            build_memory_record("mem", "idx", "x", [0, 0], importance=bad, now=5)


def test_accepts_inclusive_bounds() -> None:
    for ok in [0, 0.5, 1]:
        record = build_memory_record("mem", "idx", "x", [0, 0], importance=ok, now=5)
        assert to_object(record.fields)["importance"] == str(ok)
