"""Key divergence tests for the LlamaIndex adapter.

Proves that tool definitions, tool order, and non-serializable closures are
handled correctly in cache key computation.
"""
from __future__ import annotations

import pytest
from betterdb_agent_cache.adapters.llamaindex import prepare_params
from betterdb_agent_cache.utils import llm_cache_hash


MSGS = [{"role": "user", "content": "Hello"}]


class _ToolMetadata:
    """Mimics LlamaIndex ToolMetadata (attribute-based, not a dict)."""

    def __init__(self, name: str, description: str, parameters: dict | None = None):
        self.name = name
        self.description = description
        self.parameters = parameters


class _FakeTool:
    """Mimics LlamaIndex BaseTool with metadata + a non-serializable call."""

    def __init__(self, meta: _ToolMetadata):
        self.metadata = meta

    def call(self, _input):  # noqa: ANN001, ANN201  — intentionally untyped
        raise RuntimeError("should never be serialized")


TOOL_A_META = _ToolMetadata("get_weather", "Get weather", {"type": "object", "properties": {"city": {"type": "string"}}})
TOOL_B_META = _ToolMetadata("search", "Search web", {"type": "object", "properties": {"q": {"type": "string"}}})
TOOL_A_ALT_META = _ToolMetadata("get_weather", "Get weather", {"type": "object", "properties": {"location": {"type": "string"}}})

TOOL_A = _FakeTool(TOOL_A_META)
TOOL_B = _FakeTool(TOOL_B_META)
TOOL_A_ALT = _FakeTool(TOOL_A_ALT_META)


# ─── Case 1: Tool sensitivity ────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_different_tool_names_produce_different_keys():
    p1 = await prepare_params(MSGS, model="gpt-4o", tools=[TOOL_A])
    p2 = await prepare_params(MSGS, model="gpt-4o", tools=[TOOL_B])
    assert llm_cache_hash(p1) != llm_cache_hash(p2)


@pytest.mark.asyncio
async def test_same_name_different_params_produce_different_keys():
    p1 = await prepare_params(MSGS, model="gpt-4o", tools=[TOOL_A])
    p2 = await prepare_params(MSGS, model="gpt-4o", tools=[TOOL_A_ALT])
    assert llm_cache_hash(p1) != llm_cache_hash(p2)


# ─── Case 2: Tool stability (order invariance) ───────────────────────────────

@pytest.mark.asyncio
async def test_same_tools_different_order_produce_same_key():
    p1 = await prepare_params(MSGS, model="gpt-4o", tools=[TOOL_A, TOOL_B])
    p2 = await prepare_params(MSGS, model="gpt-4o", tools=[TOOL_B, TOOL_A])
    assert llm_cache_hash(p1) == llm_cache_hash(p2)


# ─── Case 3: Tools-absent baseline ───────────────────────────────────────────

@pytest.mark.asyncio
async def test_no_tools_vs_with_tools_produce_different_keys():
    p_no = await prepare_params(MSGS, model="gpt-4o")
    p_yes = await prepare_params(MSGS, model="gpt-4o", tools=[TOOL_A])
    assert llm_cache_hash(p_no) != llm_cache_hash(p_yes)


@pytest.mark.asyncio
async def test_no_tools_both_calls_produce_same_key():
    p1 = await prepare_params(MSGS, model="gpt-4o")
    p2 = await prepare_params(MSGS, model="gpt-4o")
    assert llm_cache_hash(p1) == llm_cache_hash(p2)


# ─── Case 6: Closure safety ──────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_tool_with_closure_produces_same_key_as_plain_metadata():
    """A tool carrying a non-serializable call closure must not throw and
    must produce a key derived only from its metadata."""
    tool_with_closure = _FakeTool(TOOL_A_META)
    tool_plain = {"metadata": {"name": "get_weather", "description": "Get weather",
                               "parameters": {"type": "object", "properties": {"city": {"type": "string"}}}}}

    p1 = await prepare_params(MSGS, model="gpt-4o", tools=[tool_with_closure])
    p2 = await prepare_params(MSGS, model="gpt-4o", tools=[tool_plain])
    assert llm_cache_hash(p1) == llm_cache_hash(p2)


@pytest.mark.asyncio
async def test_closure_key_is_deterministic():
    tool = _FakeTool(TOOL_A_META)
    p1 = await prepare_params(MSGS, model="gpt-4o", tools=[tool])
    p2 = await prepare_params(MSGS, model="gpt-4o", tools=[tool])
    assert llm_cache_hash(p1) == llm_cache_hash(p2)
