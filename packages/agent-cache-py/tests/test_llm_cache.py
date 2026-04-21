"""Unit tests for LlmCache."""
from __future__ import annotations

import json
import time
from unittest.mock import AsyncMock, MagicMock

import pytest

from betterdb_agent_cache.errors import ValkeyCommandError
from betterdb_agent_cache.tiers.llm_cache import LlmCache, LlmCacheConfig
from betterdb_agent_cache.types import LlmCacheParams, LlmStoreOptions, ModelCost

from .conftest import make_client, make_telemetry


def _make_cache(
    default_ttl: int | None = None,
    tier_ttl: int | None = None,
    cost_table=None,
) -> tuple[LlmCache, MagicMock]:
    client = make_client()
    config = LlmCacheConfig(
        client=client,
        name="test",
        default_ttl=default_ttl,
        tier_ttl=tier_ttl,
        cost_table=cost_table,
        telemetry=make_telemetry(),
        stats_key="test:__stats",
    )
    return LlmCache(config), client


def _params(model: str = "gpt-4o", content: str = "hello") -> LlmCacheParams:
    return {"model": model, "messages": [{"role": "user", "content": content}]}


def _stored_entry(response: str = "world", model: str = "gpt-4o") -> str:
    return json.dumps({"response": response, "model": model, "storedAt": 0})


# ─── check ────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_check_miss_when_key_absent():
    cache, client = _make_cache()
    client.get = AsyncMock(return_value=None)

    result = await cache.check(_params())

    assert result.hit is False
    assert result.response is None


@pytest.mark.asyncio
async def test_check_hit_returns_response():
    cache, client = _make_cache()
    client.get = AsyncMock(return_value=_stored_entry("the answer").encode())

    result = await cache.check(_params())

    assert result.hit is True
    assert result.response == "the answer"


@pytest.mark.asyncio
async def test_check_hit_returns_content_blocks():
    cache, client = _make_cache()
    blocks = [{"type": "text", "text": "hello"}, {"type": "text", "text": " world"}]
    entry = json.dumps({"response": "hello world", "contentBlocks": blocks, "model": "gpt-4o", "storedAt": 0})
    client.get = AsyncMock(return_value=entry.encode())

    result = await cache.check(_params())

    assert result.hit is True
    assert result.content_blocks == blocks


@pytest.mark.asyncio
async def test_check_corrupt_entry_returns_miss_and_deletes():
    cache, client = _make_cache()
    client.get = AsyncMock(return_value=b"not valid json{{{")

    result = await cache.check(_params())

    assert result.hit is False
    client.delete.assert_called_once()


@pytest.mark.asyncio
async def test_check_raises_on_valkey_get_error():
    cache, client = _make_cache()
    client.get = AsyncMock(side_effect=Exception("connection lost"))

    with pytest.raises(ValkeyCommandError, match="GET"):
        await cache.check(_params())


@pytest.mark.asyncio
async def test_check_hit_tracks_cost_when_present():
    cache, client = _make_cache()
    entry = json.dumps({
        "response": "r", "model": "gpt-4o", "storedAt": 0, "cost": 0.001
    })
    client.get = AsyncMock(return_value=entry.encode())
    pipe = client.pipeline()

    result = await cache.check(_params())

    assert result.hit is True
    # Pipeline should have recorded cost_saved_micros
    pipe.hincrby.assert_any_call("test:__stats", "cost_saved_micros", 1000)


# ─── store ────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_store_sets_key_without_ttl():
    cache, client = _make_cache()

    key = await cache.store(_params(), "the answer")

    assert key.startswith("test:llm:")
    client.set.assert_called_once()
    _, kwargs = client.set.call_args
    assert "ex" not in kwargs or kwargs.get("ex") is None


@pytest.mark.asyncio
async def test_store_sets_key_with_ttl():
    cache, client = _make_cache(default_ttl=3600)

    await cache.store(_params(), "the answer")

    client.set.assert_called_once()
    call = client.set.call_args
    assert call.kwargs.get("ex") == 3600


@pytest.mark.asyncio
async def test_store_per_call_ttl_overrides_default():
    cache, client = _make_cache(default_ttl=3600)

    await cache.store(_params(), "r", LlmStoreOptions(ttl=60))

    call = client.set.call_args
    assert call.kwargs.get("ex") == 60


@pytest.mark.asyncio
async def test_store_computes_cost_from_cost_table():
    cost_table = {"gpt-4o": ModelCost(input_per_1k=0.005, output_per_1k=0.015)}
    cache, client = _make_cache(cost_table=cost_table)

    await cache.store(_params(), "r", LlmStoreOptions(tokens={"input": 100, "output": 200}))

    stored_json = client.set.call_args.args[1]
    entry = json.loads(stored_json)
    expected = (100 / 1000) * 0.005 + (200 / 1000) * 0.015
    assert abs(entry["cost"] - expected) < 1e-9


@pytest.mark.asyncio
async def test_store_raises_on_valkey_set_error():
    cache, client = _make_cache()
    client.set = AsyncMock(side_effect=Exception("write error"))

    with pytest.raises(ValkeyCommandError, match="SET"):
        await cache.store(_params(), "r")


# ─── store_multipart ──────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_store_multipart_flattens_text_blocks():
    cache, client = _make_cache()
    blocks = [
        {"type": "text", "text": "hello "},
        {"type": "text", "text": "world"},
    ]

    await cache.store_multipart(_params(), blocks)

    stored_json = client.set.call_args.args[1]
    entry = json.loads(stored_json)
    assert entry["response"] == "hello world"
    assert entry["contentBlocks"] == blocks


# ─── invalidate_by_model ──────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_invalidate_by_model_deletes_matching_entries():
    cache, client = _make_cache()
    entry_match = _stored_entry(model="gpt-4o")
    entry_other = _stored_entry(model="gpt-3.5-turbo")

    client.scan = AsyncMock(return_value=(0, [b"test:llm:aaa", b"test:llm:bbb"]))
    # First call → GET results; second call → DEL results (integers)
    pipe = client.pipeline()
    pipe.execute = AsyncMock(side_effect=[
        [entry_match.encode(), entry_other.encode()],  # GET pipeline
        [1],                                            # DEL pipeline
    ])

    deleted = await cache.invalidate_by_model("gpt-4o")

    assert deleted == 1


@pytest.mark.asyncio
async def test_invalidate_by_model_no_keys_returns_zero():
    cache, client = _make_cache()
    client.scan = AsyncMock(return_value=(0, []))

    deleted = await cache.invalidate_by_model("gpt-4o")

    assert deleted == 0
