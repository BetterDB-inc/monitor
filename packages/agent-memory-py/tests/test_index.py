from __future__ import annotations

import inspect

from betterdb_agent_memory import AgentCache, AgentMemory, MemoryStore


def test_reexports_agent_cache_from_betterdb_agent_cache() -> None:
    assert inspect.isclass(AgentCache)


def test_exports_the_memory_store_tier() -> None:
    assert inspect.isclass(MemoryStore)


def test_exports_the_agent_memory_facade() -> None:
    assert inspect.isclass(AgentMemory)
