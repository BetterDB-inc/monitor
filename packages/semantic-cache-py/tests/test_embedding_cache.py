"""Tests for the embedding cache subsystem."""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, call

import pytest

from betterdb_semantic_cache.semantic_cache import SemanticCache
from betterdb_semantic_cache.types import (
    DiscoveryOptions,
    EmbeddingCacheOptions,
    SemanticCacheOptions,
    TelemetryOptions,
)
from betterdb_semantic_cache.utils import encode_float32

from .conftest import _ft_info_response, _ft_search_miss, make_client, make_telemetry


def _make_cache(*, embedding_cache_enabled: bool = True) -> tuple[SemanticCache, MagicMock]:
    client = make_client()
    embed_fn = AsyncMock(return_value=[0.5, 0.5])
    opts = SemanticCacheOptions(
        client=client,
        embed_fn=embed_fn,
        name="emb",
        embedding_cache=EmbeddingCacheOptions(enabled=embedding_cache_enabled, ttl=3600),
        telemetry=TelemetryOptions(tracer_name="t", metrics_prefix="sc_emb"),
        use_default_cost_table=False,
        discovery=DiscoveryOptions(enabled=False),
    )
    cache = SemanticCache(opts)
    cache._telemetry = make_telemetry()
    # Manually set initialized state for unit tests that don't need full init
    return cache, client


@pytest.mark.asyncio
async def test_embed_stores_to_cache_on_first_call():
    cache, client = _make_cache()
    await cache.initialize()

    await cache.check("hello")

    # Should have called SET to store the embedding
    set_calls = [c for c in client.set.call_args_list]
    assert len(set_calls) >= 1
    # The stored value should be Float32-encoded bytes
    stored_val = set_calls[0].args[1]
    assert isinstance(stored_val, bytes)


@pytest.mark.asyncio
async def test_embed_returns_from_cache_on_second_call():
    cache, client = _make_cache()
    await cache.initialize()

    # First call: miss (client.get returns None)
    client.get = AsyncMock(return_value=None)
    await cache.check("hello")

    # Second call: hit (client.get returns cached bytes)
    encoded = encode_float32([0.5, 0.5])
    client.get = AsyncMock(return_value=encoded)
    embed_fn_call_count_before = cache._embed_fn.call_count
    await cache.check("hello")

    # embed_fn should NOT have been called again
    assert cache._embed_fn.call_count == embed_fn_call_count_before


@pytest.mark.asyncio
async def test_embed_cache_disabled_always_calls_embed_fn():
    cache, client = _make_cache(embedding_cache_enabled=False)
    await cache.initialize()

    await cache.check("hello")
    await cache.check("hello")

    assert cache._embed_fn.call_count >= 2
    # No GET calls for embedding cache
    embed_gets = [
        c for c in client.get.call_args_list
        if "embed:" in str(c.args[0] if c.args else "")
    ]
    assert len(embed_gets) == 0
