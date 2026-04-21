"""Unit tests for AgentCache cost table behavior."""
from __future__ import annotations

import json
from unittest.mock import patch

import pytest

from betterdb_agent_cache import DEFAULT_COST_TABLE
from betterdb_agent_cache.agent_cache import AgentCache
from betterdb_agent_cache.types import AgentCacheOptions, LlmStoreOptions, ModelCost

from .conftest import make_client


def _make_cache(**kwargs) -> AgentCache:
    client = make_client()
    options = AgentCacheOptions(client=client, **kwargs)
    with patch("betterdb_agent_cache.agent_cache.create_analytics"):
        return AgentCache(options)


def _params(model: str = "gpt-4o"):
    return {"model": model, "messages": [{"role": "user", "content": "hello"}]}


@pytest.mark.asyncio
async def test_default_cost_table_applies_when_no_cost_table_provided():
    """Default table is active so gpt-4o gets a cost > 0."""
    cache = _make_cache()

    await cache.llm.store(
        _params("gpt-4o"),
        "response text",
        LlmStoreOptions(tokens={"input": 1000, "output": 1000}),
    )

    stored_json = cache.llm._client.set.call_args.args[1]
    entry = json.loads(stored_json)
    assert entry["cost"] > 0


@pytest.mark.asyncio
async def test_user_cost_table_overrides_default_per_model():
    """User-supplied entry wins; cost = (1000/1k)*99 + (1000/1k)*99 = 198."""
    cache = _make_cache(cost_table={"gpt-4o": ModelCost(input_per_1k=99, output_per_1k=99)})

    await cache.llm.store(
        _params("gpt-4o"),
        "response text",
        LlmStoreOptions(tokens={"input": 1000, "output": 1000}),
    )

    stored_json = cache.llm._client.set.call_args.args[1]
    entry = json.loads(stored_json)
    assert entry["cost"] == pytest.approx(198)


@pytest.mark.asyncio
async def test_user_cost_table_does_not_remove_other_default_entries():
    """Overriding gpt-4o keeps gpt-4o-mini in the merged table."""
    assert "gpt-4o-mini" in DEFAULT_COST_TABLE

    cache = _make_cache(cost_table={"gpt-4o": ModelCost(input_per_1k=99, output_per_1k=99)})

    await cache.llm.store(
        _params("gpt-4o-mini"),
        "response text",
        LlmStoreOptions(tokens={"input": 1000, "output": 1000}),
    )

    stored_json = cache.llm._client.set.call_args.args[1]
    entry = json.loads(stored_json)
    assert entry["cost"] > 0


@pytest.mark.asyncio
async def test_use_default_cost_table_false_disables_cost_tracking():
    """No cost field stored when default table is disabled and no user table given."""
    cache = _make_cache(use_default_cost_table=False)

    await cache.llm.store(
        _params("gpt-4o"),
        "response text",
        LlmStoreOptions(tokens={"input": 1000, "output": 1000}),
    )

    stored_json = cache.llm._client.set.call_args.args[1]
    entry = json.loads(stored_json)
    assert "cost" not in entry
