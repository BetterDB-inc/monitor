"""The root import surface of ``betterdb_ai``."""

from __future__ import annotations

import betterdb_agent_cache
import betterdb_semantic_cache

import betterdb_ai


def test_exports_the_primary_classes_flat() -> None:
    assert betterdb_ai.AgentCache is betterdb_agent_cache.AgentCache
    assert betterdb_ai.SemanticCache is betterdb_semantic_cache.SemanticCache
    assert callable(betterdb_ai.MemoryStore)
    assert callable(betterdb_ai.AgentMemory)
    assert callable(betterdb_ai.Retriever)


def test_exports_non_conflicting_helpers_flat() -> None:
    assert callable(betterdb_ai.escape_tag)
    assert callable(betterdb_ai.encode_float32)
    assert callable(betterdb_ai.create_keyword_overlap_rerank)
    assert callable(betterdb_ai.composite_score)
    assert betterdb_ai.TEXT_FIELD is not None


def test_exposes_all_five_namespaces() -> None:
    assert betterdb_ai.agent_cache.AgentCache is betterdb_ai.AgentCache
    assert betterdb_ai.semantic_cache.SemanticCache is betterdb_ai.SemanticCache
    assert betterdb_ai.retrieval.Retriever is betterdb_ai.Retriever
    assert betterdb_ai.memory.MemoryStore is betterdb_ai.MemoryStore
    assert callable(betterdb_ai.search_kit.encode_float32)


def test_keeps_both_valkey_command_errors_distinct_and_reachable() -> None:
    from_cache = betterdb_ai.agent_cache.ValkeyCommandError
    from_semantic = betterdb_ai.semantic_cache.ValkeyCommandError

    assert from_cache is not from_semantic

    err = from_semantic("GET", RuntimeError("boom"))
    assert isinstance(err, from_semantic)
    assert not isinstance(err, from_cache)


def test_does_not_export_conflicting_names_flat() -> None:
    for name in ["ValkeyCommandError", "Analytics", "EmbedFn", "hash_bytes", "ModelCost"]:
        assert not hasattr(betterdb_ai, name)


def test_shared_re_exports_are_flattened_once() -> None:
    # semantic-cache re-exports these straight from valkey-search-kit, so both
    # names point at one function and flattening is safe.
    assert betterdb_ai.escape_tag is betterdb_semantic_cache.escape_tag
    assert betterdb_ai.encode_float32 is betterdb_semantic_cache.encode_float32
