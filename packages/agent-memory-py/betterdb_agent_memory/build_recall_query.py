from __future__ import annotations

from dataclasses import dataclass

from betterdb_valkey_search_kit import escape_tag

from .types import MemoryScope

SCORE_FIELD = "__score"
VECTOR_FIELD = "vector"


def _scope_clauses(scope: MemoryScope, tags: list[str]) -> list[str]:
    clauses: list[str] = []
    if scope.thread_id is not None:
        clauses.append(f"@threadId:{{{escape_tag(scope.thread_id)}}}")
    if scope.agent_id is not None:
        clauses.append(f"@agentId:{{{escape_tag(scope.agent_id)}}}")
    if scope.namespace is not None:
        clauses.append(f"@namespace:{{{escape_tag(scope.namespace)}}}")
    for tag in tags:
        clauses.append(f"@tags:{{{escape_tag(tag)}}}")
    return clauses


def _join_clauses(clauses: list[str]) -> str:
    if len(clauses) == 0:
        return "*"
    return f"({' '.join(clauses)})"


def build_scope_filter(scope: MemoryScope, tags: list[str]) -> str:
    return _join_clauses(_scope_clauses(scope, tags))


@dataclass
class ConsolidateFilterOptions:
    max_created_at: int | None = None
    max_importance: float | None = None
    exclude_source: str | None = None


def build_consolidate_filter(
    scope: MemoryScope,
    tags: list[str],
    options: ConsolidateFilterOptions,
) -> str:
    clauses = _scope_clauses(scope, tags)
    if options.max_created_at is not None:
        clauses.append(f"@created_at:[-inf {options.max_created_at}]")
    if options.max_importance is not None:
        clauses.append(f"@importance:[-inf {options.max_importance}]")
    if options.exclude_source is not None:
        clauses.append(f"-@source:{{{escape_tag(options.exclude_source)}}}")
    return _join_clauses(clauses)


def build_recall_query(k: int, scope: MemoryScope, tags: list[str]) -> str:
    return f"{build_scope_filter(scope, tags)}=>[KNN {k} @{VECTOR_FIELD} $vec AS {SCORE_FIELD}]"
