"""Adapter submodules, each merging both caches behind one import."""

from __future__ import annotations

import importlib

import pytest

BOTH_CACHES = ["openai", "openai_responses", "anthropic", "llamaindex"]
AGENT_CACHE_ONLY = ["openai_agents", "pydantic_ai"]


def test_exposes_both_langchain_adapters() -> None:
    module = importlib.import_module("betterdb_ai.langchain")

    assert callable(module.BetterDBLlmCache)
    assert callable(module.BetterDBSemanticCache)


def test_exposes_both_langgraph_adapters() -> None:
    module = importlib.import_module("betterdb_ai.langgraph")

    assert callable(module.BetterDBSaver)
    assert callable(module.BetterDBSemanticStore)


@pytest.mark.parametrize("name", BOTH_CACHES)
def test_exposes_both_prepare_functions(name: str) -> None:
    module = importlib.import_module(f"betterdb_ai.{name}")

    assert callable(module.prepare_params)
    assert callable(module.prepare_semantic_params)
    assert module.prepare_params is not module.prepare_semantic_params


@pytest.mark.parametrize("name", BOTH_CACHES)
def test_prepare_functions_are_the_child_objects(name: str) -> None:
    module = importlib.import_module(f"betterdb_ai.{name}")
    agent = importlib.import_module(f"betterdb_agent_cache.adapters.{name}")
    semantic = importlib.import_module(f"betterdb_semantic_cache.adapters.{name}")

    assert module.prepare_params is agent.prepare_params
    assert module.prepare_semantic_params is semantic.prepare_semantic_params


@pytest.mark.parametrize("name", AGENT_CACHE_ONLY)
def test_agent_cache_only_adapters_have_no_semantic_half(name: str) -> None:
    module = importlib.import_module(f"betterdb_ai.{name}")

    assert callable(module.prepare_params)
    # semantic-cache ships no counterpart for these two, so promising one would
    # be a lie rather than a convenience.
    assert not hasattr(module, "prepare_semantic_params")


@pytest.mark.parametrize("name", BOTH_CACHES + AGENT_CACHE_ONLY + ["langchain", "langgraph"])
def test_declared_names_all_resolve(name: str) -> None:
    module = importlib.import_module(f"betterdb_ai.{name}")

    assert [n for n in module.__all__ if not hasattr(module, n)] == []
