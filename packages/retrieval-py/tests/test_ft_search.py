from __future__ import annotations

import pytest

from betterdb_retrieval.ft_search import build_ft_search_query
from betterdb_retrieval.schema import RetrievalSchema

schema: RetrievalSchema = {
    "fields": {
        "source": {"type": "tag"},
        "title": {"type": "text"},
        "updated": {"type": "numeric"},
    },
    "vector": {"metric": "cosine", "algorithm": "hnsw", "dims": 4},
}


def test_bare_knn_no_filter() -> None:
    assert build_ft_search_query(schema, 10) == "*=>[KNN 10 @embedding $vec AS __score]"


def test_single_tag_filter() -> None:
    assert (
        build_ft_search_query(schema, 5, {"source": "docs"})
        == "(@source:{docs})=>[KNN 5 @embedding $vec AS __score]"
    )


def test_tag_and_numeric_and_semantics() -> None:
    assert (
        build_ft_search_query(schema, 5, {"source": "docs", "updated": 1717200000})
        == "(@source:{docs} @updated:[1717200000 1717200000])=>[KNN 5 @embedding $vec AS __score]"
    )


def test_escapes_tag_values() -> None:
    assert (
        build_ft_search_query(schema, 5, {"source": "a:b c"})
        == "(@source:{a\\:b\\ c})=>[KNN 5 @embedding $vec AS __score]"
    )


def test_unknown_field() -> None:
    with pytest.raises(ValueError, match="(?i)unknown"):
        build_ft_search_query(schema, 5, {"missing": "x"})


def test_text_field_not_filterable() -> None:
    with pytest.raises(ValueError, match="(?i)text"):
        build_ft_search_query(schema, 5, {"title": "x"})


def test_numeric_filter_requires_number() -> None:
    with pytest.raises(ValueError, match="(?i)numeric"):
        build_ft_search_query(schema, 5, {"updated": "recent"})
