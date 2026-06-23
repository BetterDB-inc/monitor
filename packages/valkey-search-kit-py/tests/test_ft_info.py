from betterdb_valkey_search_kit import (
    FtIndexStats,
    parse_dimension_from_info,
    parse_ft_info_stats,
)


def test_parses_the_flat_dim_pair_shape():
    info = [
        "index_name",
        "sc:idx",
        "attributes",
        [["identifier", "embedding", "type", "VECTOR", "DIM", "1536"]],
    ]
    assert parse_dimension_from_info(info) == 1536


def test_parses_the_nested_v12_index_dimensions_shape():
    info = [
        "index_name",
        "sc:idx",
        "attributes",
        [["identifier", "embedding", "type", "VECTOR", "index", ["dimensions", "768"]]],
    ]
    assert parse_dimension_from_info(info) == 768


def test_reads_attributes_under_the_legacy_fields_key():
    info = ["fields", [["identifier", "embedding", "type", "VECTOR", "dim", "384"]]]
    assert parse_dimension_from_info(info) == 384


def test_ignores_non_vector_attributes_with_a_dim_pair():
    info = ["attributes", [["identifier", "prompt", "type", "TEXT", "DIM", "99"]]]
    assert parse_dimension_from_info(info) == 0


def test_returns_zero_when_no_vector_attribute_exists():
    info = ["index_name", "sc:idx", "num_docs", "5"]
    assert parse_dimension_from_info(info) == 0


def test_parses_bytes_info_from_valkey_py():
    info = [
        b"attributes",
        [[b"identifier", b"embedding", b"type", b"VECTOR", b"DIM", b"1536"]],
    ]
    assert parse_dimension_from_info(info) == 1536


def test_stats_extracts_num_docs_and_indexing_state():
    info = ["index_name", "sc:idx", "num_docs", "42", "indexing", "0"]
    assert parse_ft_info_stats(info) == FtIndexStats(num_docs=42, indexing_state="0")


def test_stats_defaults_when_keys_absent():
    assert parse_ft_info_stats(["index_name", "sc:idx"]) == FtIndexStats(
        num_docs=0, indexing_state="unknown"
    )


def test_stats_coerces_unparseable_num_docs_to_zero():
    assert parse_ft_info_stats(["num_docs", "garbage"]) == FtIndexStats(
        num_docs=0, indexing_state="unknown"
    )
