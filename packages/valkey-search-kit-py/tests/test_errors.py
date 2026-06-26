from betterdb_valkey_search_kit import is_index_not_found_error


def test_matches_unknown_index_name_case_insensitively():
    assert is_index_not_found_error(Exception("Unknown Index Name")) is True
    assert is_index_not_found_error(Exception("UNKNOWN INDEX NAME sc:idx")) is True


def test_matches_no_such_index_case_insensitively():
    assert is_index_not_found_error(Exception("no such index")) is True
    assert is_index_not_found_error(Exception("sc:idx: No Such Index")) is True


def test_matches_redis8_ft_search_phrasing():
    assert is_index_not_found_error(Exception("No such index nonexistent_idx_xyz")) is True


def test_matches_index_scoped_not_found_phrasings():
    assert is_index_not_found_error(Exception("Index sc:idx: not found")) is True
    assert is_index_not_found_error(Exception("index not found")) is True
    assert is_index_not_found_error(Exception("Index with name foo not found")) is True


def test_matches_the_valkey_search_12_phrasing():
    assert (
        is_index_not_found_error(
            Exception("Index with name 'nonexistent_idx_xyz' not found in database 0")
        )
        is True
    )


def test_rejects_not_found_messages_without_index_context():
    assert is_index_not_found_error(Exception("key not found")) is False
    assert is_index_not_found_error(Exception("function not found")) is False
    assert is_index_not_found_error(Exception("ERR value not found")) is False


def test_rejects_index_messages_without_not_found_context():
    assert is_index_not_found_error(Exception("index is being created")) is False


def test_rejects_unrelated_error_messages():
    assert is_index_not_found_error(Exception("connection refused")) is False


def test_rejects_non_exception_values():
    assert is_index_not_found_error("index not found") is False
    assert is_index_not_found_error(None) is False
    assert is_index_not_found_error({"message": "index not found"}) is False
