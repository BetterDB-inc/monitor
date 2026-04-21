import pytest
from betterdb_agent_cache.utils import (
    canonical_json,
    escape_glob_pattern,
    llm_cache_hash,
    parse_tool_call_args,
    sha256,
    tool_cache_hash,
)


def test_sha256_is_hex():
    result = sha256("hello")
    assert len(result) == 64
    assert all(c in "0123456789abcdef" for c in result)


def test_sha256_deterministic():
    assert sha256("hello") == sha256("hello")
    assert sha256("hello") != sha256("world")


# ─── canonical_json ───────────────────────────────────────────────────────────

def test_canonical_json_sorts_keys():
    assert canonical_json({"b": 2, "a": 1}) == '{"a":1,"b":2}'


def test_canonical_json_sorts_nested():
    result = canonical_json({"z": {"y": 2, "x": 1}})
    assert result == '{"z":{"x":1,"y":2}}'


def test_canonical_json_preserves_array_order():
    assert canonical_json({"a": [3, 1, 2]}) == '{"a":[3,1,2]}'


def test_canonical_json_none_is_null():
    assert canonical_json({"a": None}) == '{"a":null}'


def test_canonical_json_compact():
    result = canonical_json({"a": 1})
    assert " " not in result


# ─── escape_glob_pattern ──────────────────────────────────────────────────────

def test_escape_glob_asterisk():
    assert escape_glob_pattern("foo*bar") == "foo\\*bar"


def test_escape_glob_question():
    assert escape_glob_pattern("foo?bar") == "foo\\?bar"


def test_escape_glob_brackets():
    assert escape_glob_pattern("foo[bar]") == "foo\\[bar\\]"


def test_escape_glob_backslash_first():
    assert escape_glob_pattern("foo\\*bar") == "foo\\\\\\*bar"


def test_escape_glob_no_special():
    assert escape_glob_pattern("betterdb_ac") == "betterdb_ac"


# ─── llm_cache_hash ───────────────────────────────────────────────────────────

def _base_params():
    return {
        "model": "gpt-4o",
        "messages": [{"role": "user", "content": "hello"}],
    }


def test_llm_cache_hash_deterministic():
    params = _base_params()
    assert llm_cache_hash(params) == llm_cache_hash(params)


def test_llm_cache_hash_model_changes_hash():
    p1 = {**_base_params(), "model": "gpt-4o"}
    p2 = {**_base_params(), "model": "gpt-4o-mini"}
    assert llm_cache_hash(p1) != llm_cache_hash(p2)


def test_llm_cache_hash_message_changes_hash():
    p1 = {"model": "gpt-4o", "messages": [{"role": "user", "content": "hello"}]}
    p2 = {"model": "gpt-4o", "messages": [{"role": "user", "content": "world"}]}
    assert llm_cache_hash(p1) != llm_cache_hash(p2)


def test_llm_cache_hash_tools_sorted():
    params_ab = {
        **_base_params(),
        "tools": [
            {"type": "function", "function": {"name": "b_tool", "description": "B"}},
            {"type": "function", "function": {"name": "a_tool", "description": "A"}},
        ],
    }
    params_ba = {
        **_base_params(),
        "tools": [
            {"type": "function", "function": {"name": "a_tool", "description": "A"}},
            {"type": "function", "function": {"name": "b_tool", "description": "B"}},
        ],
    }
    assert llm_cache_hash(params_ab) == llm_cache_hash(params_ba)


def test_llm_cache_hash_missing_optional_same_as_none():
    p1 = _base_params()
    p2 = {**_base_params(), "max_tokens": None}
    # None values should be excluded, same as missing
    assert llm_cache_hash(p1) == llm_cache_hash(p2)


def test_llm_cache_hash_optional_included_when_set():
    p1 = _base_params()
    p2 = {**_base_params(), "max_tokens": 256}
    assert llm_cache_hash(p1) != llm_cache_hash(p2)


# ─── tool_cache_hash ──────────────────────────────────────────────────────────

def test_tool_cache_hash_deterministic():
    args = {"city": "London", "units": "celsius"}
    assert tool_cache_hash(args) == tool_cache_hash(args)


def test_tool_cache_hash_key_order_independent():
    a = {"city": "London", "units": "celsius"}
    b = {"units": "celsius", "city": "London"}
    assert tool_cache_hash(a) == tool_cache_hash(b)


def test_tool_cache_hash_none_args():
    assert len(tool_cache_hash(None)) == 64


# ─── parse_tool_call_args ─────────────────────────────────────────────────────

def test_parse_tool_call_args_valid_json():
    assert parse_tool_call_args('{"city":"London"}') == {"city": "London"}


def test_parse_tool_call_args_empty_string():
    assert parse_tool_call_args("") == {}


def test_parse_tool_call_args_invalid_json():
    assert parse_tool_call_args("not json") == {"__raw": "not json"}
