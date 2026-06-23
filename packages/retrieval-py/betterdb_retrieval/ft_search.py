from __future__ import annotations

import math

from betterdb_valkey_search_kit import escape_tag

from .fields import SCORE_FIELD
from .ft_create import resolve_vector_field_name
from .schema import RetrievalSchema

QueryFilter = dict[str, "str | int | float"]


def _is_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _build_filter_clause(field: str, value: str | int | float, schema: RetrievalSchema) -> str:
    spec = schema["fields"].get(field)
    if spec is None:
        raise ValueError(f"Cannot filter on unknown field '{field}'")
    field_type = spec.get("type")
    if field_type == "tag":
        return f"@{field}:{{{escape_tag(str(value))}}}"
    if field_type == "numeric":
        if not _is_number(value):
            raise ValueError(
                f"Numeric filter on field '{field}' requires a number, got: {type(value).__name__}"
            )
        if isinstance(value, float) and not math.isfinite(value):
            raise ValueError(
                f"Numeric filter on field '{field}' requires a finite number, got: {value!r}"
            )
        return f"@{field}:[{value} {value}]"
    raise ValueError(
        f"Cannot filter on TEXT field '{field}'; only tag and numeric fields are filterable"
    )


def build_ft_search_query(
    schema: RetrievalSchema,
    k: int,
    filter: QueryFilter | None = None,
) -> str:
    vector_field = resolve_vector_field_name(schema["vector"])
    clauses: list[str] = []
    if filter is not None:
        for field, value in filter.items():
            clauses.append(_build_filter_clause(field, value, schema))
    filter_expr = f"({' '.join(clauses)})" if clauses else "*"
    return f"{filter_expr}=>[KNN {k} @{vector_field} $vec AS {SCORE_FIELD}]"
