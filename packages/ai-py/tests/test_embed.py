"""Embedder submodules.

All six are mirrored, not the five the npm facade can reach: nothing gates a
Python submodule, so ``betterdb_semantic_cache.embed.google`` was always
importable even while its npm counterpart was unreachable.
"""

from __future__ import annotations

import importlib

import pytest

PROVIDERS = ["openai", "bedrock", "voyage", "cohere", "ollama", "google"]


@pytest.mark.parametrize("provider", PROVIDERS)
def test_exposes_the_factory(provider: str) -> None:
    module = importlib.import_module(f"betterdb_ai.embed.{provider}")
    child = importlib.import_module(f"betterdb_semantic_cache.embed.{provider}")
    factory = f"create_{provider}_embed"

    assert callable(getattr(module, factory))
    assert getattr(module, factory) is getattr(child, factory)


def test_google_also_exposes_its_task_type() -> None:
    module = importlib.import_module("betterdb_ai.embed.google")

    assert module.GoogleEmbedTaskType is not None
