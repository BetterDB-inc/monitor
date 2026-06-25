from __future__ import annotations

from betterdb_agent_memory.build_recall_query import (
    ConsolidateFilterOptions,
    build_consolidate_filter,
    build_recall_query,
)
from betterdb_agent_memory.types import MemoryScope


def test_bare_knn_query_without_filters() -> None:
    assert build_recall_query(32, MemoryScope(), []) == "*=>[KNN 32 @vector $vec AS __score]"


def test_filters_by_scope_and_tags_with_and_semantics() -> None:
    assert (
        build_recall_query(8, MemoryScope(thread_id="t1", namespace="user:1"), ["pref"])
        == "(@threadId:{t1} @namespace:{user\\:1} @tags:{pref})=>[KNN 8 @vector $vec AS __score]"
    )


def test_escapes_scope_and_tag_values() -> None:
    assert (
        build_recall_query(8, MemoryScope(agent_id="a:b"), ["x y"])
        == "(@agentId:{a\\:b} @tags:{x\\ y})=>[KNN 8 @vector $vec AS __score]"
    )


def test_consolidate_filter_appends_ranges_and_source_exclusion() -> None:
    assert build_consolidate_filter(
        MemoryScope(namespace="u1"),
        ["pref"],
        ConsolidateFilterOptions(max_created_at=1000, max_importance=0.5, exclude_source="summary"),
    ) == (
        "(@namespace:{u1} @tags:{pref} @created_at:[-inf 1000] "
        "@importance:[-inf 0.5] -@source:{summary})"
    )


def test_consolidate_filter_omits_absent_predicates() -> None:
    assert (
        build_consolidate_filter(
            MemoryScope(thread_id="t"), [], ConsolidateFilterOptions(exclude_source="summary")
        )
        == "(@threadId:{t} -@source:{summary})"
    )


def test_consolidate_filter_constrains_by_range_without_scope() -> None:
    assert (
        build_consolidate_filter(MemoryScope(), [], ConsolidateFilterOptions(max_importance=0.3))
        == "(@importance:[-inf 0.3])"
    )
