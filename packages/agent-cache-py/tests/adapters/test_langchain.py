"""Tests for the LangChain cache adapter."""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock

import pytest

# Guard: skip entire module if langchain-core is not installed
langchain_core = pytest.importorskip("langchain_core")

from betterdb_agent_cache.adapters.langchain import BetterDBLlmCache, _extract_model_name


# ─── _extract_model_name ──────────────────────────────────────────────────────

def test_extract_from_langchain_format():
    llm_string = '_model:"chatModel",_type:"openai",model_name:"gpt-4o-mini"'
    assert _extract_model_name(llm_string) == "gpt-4o-mini"


def test_extract_from_json_format():
    llm_string = json.dumps({"model_name": "gpt-4o", "temperature": 0.7})
    assert _extract_model_name(llm_string) == "gpt-4o"


def test_extract_fallback_to_raw_string():
    assert _extract_model_name("unknown-format") == "unknown-format"


# ─── BetterDBLlmCache ─────────────────────────────────────────────────────────

def _make_cache_adapter():
    llm_cache = MagicMock()
    llm_cache.check = AsyncMock()
    llm_cache.store = AsyncMock()
    agent_cache = MagicMock()
    agent_cache.llm = llm_cache
    return BetterDBLlmCache(cache=agent_cache), agent_cache


@pytest.mark.asyncio
async def test_alookup_miss():
    adapter, _ = _make_cache_adapter()
    adapter._cache.llm.check = AsyncMock(return_value=MagicMock(hit=False, response=None))

    result = await adapter.alookup("hello", 'model_name:"gpt-4o"')
    assert result is None


@pytest.mark.asyncio
async def test_alookup_hit_plain_text():
    adapter, _ = _make_cache_adapter()
    adapter._cache.llm.check = AsyncMock(return_value=MagicMock(hit=True, response="Hello!"))

    result = await adapter.alookup("hello", 'model_name:"gpt-4o"')
    assert result is not None
    assert result[0].text == "Hello!"


@pytest.mark.asyncio
async def test_alookup_hit_json_generations():
    adapter, _ = _make_cache_adapter()
    stored = json.dumps([{"text": "Hello"}, {"text": "World"}])
    adapter._cache.llm.check = AsyncMock(return_value=MagicMock(hit=True, response=stored))

    result = await adapter.alookup("hello", 'model_name:"gpt-4o"')
    assert result is not None
    assert len(result) == 2
    assert result[0].text == "Hello"
    assert result[1].text == "World"


@pytest.mark.asyncio
async def test_aupdate_stores_generations():
    adapter, agent_cache = _make_cache_adapter()
    generation = MagicMock()
    generation.text = "The answer"

    await adapter.aupdate("hello", 'model_name:"gpt-4o"', [generation])

    agent_cache.llm.store.assert_called_once()
    call_args = agent_cache.llm.store.call_args
    params = call_args.args[0]
    assert params["model"] == "gpt-4o"
    stored_text = call_args.args[1]
    assert "The answer" in stored_text


@pytest.mark.asyncio
async def test_aupdate_with_token_usage():
    adapter, agent_cache = _make_cache_adapter()
    msg = MagicMock()
    msg.usage_metadata = {"input_tokens": 10, "output_tokens": 20}
    generation = MagicMock()
    generation.text = "answer"
    generation.message = msg

    await adapter.aupdate("hello", 'model_name:"gpt-4o"', [generation])

    call_args = agent_cache.llm.store.call_args
    store_options = call_args.args[2] if len(call_args.args) > 2 else call_args.kwargs.get("options")
    assert store_options is not None
    assert store_options.tokens == {"input": 10, "output": 20}


def test_sync_lookup_raises():
    adapter, _ = _make_cache_adapter()
    with pytest.raises(RuntimeError, match="async"):
        adapter.lookup("hello", "gpt-4o")


def test_sync_update_raises():
    adapter, _ = _make_cache_adapter()
    with pytest.raises(RuntimeError, match="async"):
        adapter.update("hello", "gpt-4o", [])
