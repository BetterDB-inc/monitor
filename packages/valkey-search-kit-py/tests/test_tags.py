from betterdb_valkey_search_kit import escape_tag


def test_escapes_tag_punctuation():
    assert escape_tag("a,b") == "a\\,b"
    assert escape_tag("a.b") == "a\\.b"
    assert escape_tag("a{b}") == "a\\{b\\}"
    assert escape_tag("a|b") == "a\\|b"


def test_escapes_spaces_to_prevent_or_semantics():
    assert escape_tag("gpt 4o") == "gpt\\ 4o"


def test_escapes_hyphens_and_slashes():
    assert escape_tag("gpt-4o") == "gpt\\-4o"
    assert escape_tag("a/b\\c") == "a\\/b\\\\c"


def test_leaves_alphanumerics_and_underscores_untouched():
    assert escape_tag("model_v2") == "model_v2"
