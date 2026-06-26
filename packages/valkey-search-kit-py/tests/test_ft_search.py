from betterdb_valkey_search_kit import parse_ft_search_response


def test_returns_empty_for_none():
    assert parse_ft_search_response(None) == []


def test_returns_empty_for_empty_list():
    assert parse_ft_search_response([]) == []


def test_returns_empty_for_zero_count():
    assert parse_ft_search_response(["0"]) == []


def test_parses_a_single_entry():
    raw = [
        "1",
        "cache:entry:abc",
        ["prompt", "hello", "response", "world", "__score", "0.05"],
    ]
    result = parse_ft_search_response(raw)
    assert len(result) == 1
    assert result[0]["key"] == "cache:entry:abc"
    assert result[0]["fields"]["prompt"] == "hello"
    assert result[0]["fields"]["response"] == "world"
    assert result[0]["fields"]["__score"] == "0.05"


def test_parses_bytes_response_from_valkey_py():
    raw = [b"1", b"cache:entry:abc", [b"prompt", b"hello", b"__score", b"0.05"]]
    result = parse_ft_search_response(raw)
    assert len(result) == 1
    assert result[0]["key"] == "cache:entry:abc"
    assert result[0]["fields"]["prompt"] == "hello"
    assert result[0]["fields"]["__score"] == "0.05"


def test_skips_undecodable_binary_field_value():
    raw = ["1", "k", ["embedding", b"\xff\xfe\x00\x01", "prompt", "hi"]]
    result = parse_ft_search_response(raw)
    assert len(result) == 1
    assert "embedding" not in result[0]["fields"]
    assert result[0]["fields"]["prompt"] == "hi"


def test_extracts_score_from_two_results():
    raw = [
        "2",
        "sc:entry:111",
        ["prompt", "q1", "response", "a1", "__score", "0.0234", "model", "gpt-4o"],
        "sc:entry:222",
        ["prompt", "q2", "response", "a2", "__score", "0.1500", "model", "gpt-4o"],
    ]
    result = parse_ft_search_response(raw)
    assert len(result) == 2
    assert abs(float(result[0]["fields"]["__score"]) - 0.0234) < 1e-4
    assert abs(float(result[1]["fields"]["__score"]) - 0.15) < 1e-4


def test_malformed_odd_length_field_list_skips_orphan():
    raw = ["1", "key1", ["field1", "val1", "orphan"]]
    result = parse_ft_search_response(raw)
    assert len(result) == 1
    assert result[0]["fields"]["field1"] == "val1"
    assert len(result[0]["fields"]) == 1


def test_two_result_response():
    raw = ["2", "key:a", ["f1", "v1"], "key:b", ["f2", "v2"]]
    result = parse_ft_search_response(raw)
    assert len(result) == 2
    assert result[0]["key"] == "key:a"
    assert result[0]["fields"]["f1"] == "v1"
    assert result[1]["key"] == "key:b"
    assert result[1]["fields"]["f2"] == "v2"


def test_return_zero_mode_keys_without_field_list():
    raw = ["2", "key:a", "key:b"]
    result = parse_ft_search_response(raw)
    assert len(result) == 2
    assert result[0] == {"key": "key:a", "fields": {}}
    assert result[1] == {"key": "key:b", "fields": {}}


def test_parses_a_float_formatted_total():
    # A RESP3 double may surface the total as "2.0"; match TS parseInt and
    # still return the hits instead of collapsing to [].
    raw = ["2.0", "key:a", ["f1", "v1"], "key:b", ["f2", "v2"]]
    result = parse_ft_search_response(raw)
    assert len(result) == 2
    assert result[0]["key"] == "key:a"
    assert result[1]["key"] == "key:b"


def test_parses_a_float_formatted_total_in_bytes():
    raw = [b"1", b"key:a", [b"f1", b"v1"]]
    raw[0] = b"1.0"
    result = parse_ft_search_response(raw)
    assert len(result) == 1
    assert result[0]["key"] == "key:a"


def test_never_raises_on_garbage():
    assert parse_ft_search_response("garbage") == []
    assert parse_ft_search_response(123) == []
