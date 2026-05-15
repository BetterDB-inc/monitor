"""Unit tests for LLM-as-judge adjudication (CacheCheckOptions.judge).

Fixture scores with default_threshold=0.10, uncertainty_band=0.05:
  high-confidence:  __score = 0.02  (score <= 0.05 = threshold - band)
  borderline:       __score = 0.08  (0.05 < score <= 0.10)
  miss:             FT.SEARCH returns 0 rows
"""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from betterdb_semantic_cache.semantic_cache import SemanticCache
from betterdb_semantic_cache.errors import SemanticCacheUsageError
from betterdb_semantic_cache.types import (
    CacheCheckOptions,
    EmbeddingCacheOptions,
    JudgeOptions,
    RerankOptions,
    SemanticCacheOptions,
)

from .conftest import _ft_info_response, _ft_search_hit, _ft_search_miss, make_telemetry

THRESHOLD = 0.10
BAND = 0.05
HIGH_SCORE = "0.02"
BORDERLINE_SCORE = "0.08"
RESPONSE = "Cached response"


def make_client(score: str, response: str = RESPONSE, *, no_result: bool = False) -> MagicMock:
    client = MagicMock()
    client.delete = AsyncMock(return_value=1)
    client.expire = AsyncMock(return_value=1)
    client.hincrby = AsyncMock(return_value=1)
    client.hgetall = AsyncMock(return_value={})
    client.hset = AsyncMock(return_value=1)
    client.get = AsyncMock(return_value=None)
    client.set = AsyncMock(return_value=True)
    client.zadd = AsyncMock(return_value=1)
    client.zrange = AsyncMock(return_value=[])
    client.zremrangebyscore = AsyncMock(return_value=0)
    client.zremrangebyrank = AsyncMock(return_value=0)

    def _execute(*args):
        cmd = args[0] if args else ""
        if cmd == "FT.INFO":
            return _ft_info_response(2, has_binary_refs=False)
        if cmd in ("FT.CREATE", "FT.DROPINDEX"):
            return "OK"
        if cmd == "FT.SEARCH":
            if no_result:
                return _ft_search_miss()
            return _ft_search_hit(
                "test_judge:entry:abc",
                {"response": response, "model": "", "category": "", "__score": score},
            )
        return None

    client.execute_command = AsyncMock(side_effect=_execute)

    pipe = MagicMock()
    pipe.hincrby = MagicMock()
    pipe.expire = MagicMock()
    pipe.zadd = MagicMock()
    pipe.zremrangebyscore = MagicMock()
    pipe.zremrangebyrank = MagicMock()
    pipe.execute = AsyncMock(return_value=[])
    client.pipeline = MagicMock(return_value=pipe)
    return client


async def make_cache(client: MagicMock) -> SemanticCache:
    cache = SemanticCache(SemanticCacheOptions(
        client=client,
        embed_fn=AsyncMock(return_value=[0.5, 0.5]),
        name="test_judge",
        default_threshold=THRESHOLD,
        uncertainty_band=BAND,
        embedding_cache=EmbeddingCacheOptions(enabled=False),
    ))
    cache._telemetry = make_telemetry()
    await cache.initialize()
    return cache


# ── 1. accept on borderline hit ───────────────────────────────────────────────

@pytest.mark.asyncio
async def test_judge_accept_promotes_to_high_confidence():
    cache = await make_cache(make_client(BORDERLINE_SCORE))
    judge_fn = AsyncMock(return_value=True)
    result = await cache.check("hello", CacheCheckOptions(
        judge=JudgeOptions(judge_fn=judge_fn)
    ))
    assert result.hit is True
    assert result.confidence == "high"
    assert abs(result.similarity - 0.08) < 1e-5
    judge_fn.assert_awaited_once()
    cache._telemetry.metrics.judge_decisions_total.labels.assert_called_with(
        cache_name="test_judge", decision="accept"
    )


# ── 2. reject on borderline hit ───────────────────────────────────────────────

@pytest.mark.asyncio
async def test_judge_reject_returns_miss_with_nearest_miss():
    cache = await make_cache(make_client(BORDERLINE_SCORE))
    judge_fn = AsyncMock(return_value=False)
    result = await cache.check("hello", CacheCheckOptions(
        judge=JudgeOptions(judge_fn=judge_fn)
    ))
    assert result.hit is False
    assert result.confidence == "miss"
    assert result.similarity is not None
    assert abs(result.similarity - 0.08) < 1e-5
    assert result.nearest_miss is not None
    assert result.nearest_miss.delta_to_threshold <= 0
    assert result.nearest_miss.threshold == THRESHOLD
    assert result.nearest_miss.matched_key is not None
    cache._telemetry.metrics.judge_decisions_total.labels.assert_called_with(
        cache_name="test_judge", decision="reject"
    )


# ── 3. NOT invoked on high-confidence hit ─────────────────────────────────────

@pytest.mark.asyncio
async def test_judge_not_invoked_on_high_confidence_hit():
    cache = await make_cache(make_client(HIGH_SCORE))
    judge_fn = AsyncMock(return_value=True)
    result = await cache.check("hello", CacheCheckOptions(
        judge=JudgeOptions(judge_fn=judge_fn)
    ))
    assert result.hit is True
    assert result.confidence == "high"
    judge_fn.assert_not_awaited()


# ── 4. NOT invoked on miss (zero FT.SEARCH results) ──────────────────────────

@pytest.mark.asyncio
async def test_judge_not_invoked_on_miss():
    cache = await make_cache(make_client(BORDERLINE_SCORE, no_result=True))
    judge_fn = AsyncMock(return_value=True)
    result = await cache.check("hello", CacheCheckOptions(
        judge=JudgeOptions(judge_fn=judge_fn)
    ))
    assert result.hit is False
    judge_fn.assert_not_awaited()


# ── 5. error with on_error=accept ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_judge_error_on_error_accept_returns_uncertain_hit():
    cache = await make_cache(make_client(BORDERLINE_SCORE))
    async def failing_fn(_): raise ValueError("oops")
    result = await cache.check("hello", CacheCheckOptions(
        judge=JudgeOptions(judge_fn=failing_fn, on_error="accept")
    ))
    assert result.hit is True
    assert result.confidence == "high"  # promoted by accept path
    cache._telemetry.metrics.judge_decisions_total.labels.assert_called_with(
        cache_name="test_judge", decision="error_accept"
    )


# ── 6. error with on_error=reject ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_judge_error_on_error_reject_returns_miss():
    cache = await make_cache(make_client(BORDERLINE_SCORE))
    async def failing_fn(_): raise ValueError("oops")
    result = await cache.check("hello", CacheCheckOptions(
        judge=JudgeOptions(judge_fn=failing_fn, on_error="reject")
    ))
    assert result.hit is False
    assert result.confidence == "miss"
    cache._telemetry.metrics.judge_decisions_total.labels.assert_called_with(
        cache_name="test_judge", decision="error_reject"
    )


# ── 7. timeout with on_error=accept ───────────────────────────────────────────

@pytest.mark.asyncio
async def test_judge_timeout_on_error_accept_returns_hit():
    cache = await make_cache(make_client(BORDERLINE_SCORE))
    async def slow_fn(_): await asyncio.sleep(10)
    result = await cache.check("hello", CacheCheckOptions(
        judge=JudgeOptions(judge_fn=slow_fn, on_error="accept", timeout_ms=10)
    ))
    assert result.hit is True
    cache._telemetry.metrics.judge_decisions_total.labels.assert_called_with(
        cache_name="test_judge", decision="timeout_accept"
    )


# ── 8. timeout with on_error=reject ───────────────────────────────────────────

@pytest.mark.asyncio
async def test_judge_timeout_on_error_reject_returns_miss():
    cache = await make_cache(make_client(BORDERLINE_SCORE))
    async def slow_fn(_): await asyncio.sleep(10)
    result = await cache.check("hello", CacheCheckOptions(
        judge=JudgeOptions(judge_fn=slow_fn, on_error="reject", timeout_ms=10)
    ))
    assert result.hit is False
    assert result.confidence == "miss"
    cache._telemetry.metrics.judge_decisions_total.labels.assert_called_with(
        cache_name="test_judge", decision="timeout_reject"
    )


# ── 9. composes with rerank ───────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_judge_composes_with_rerank_accept():
    cache = await make_cache(make_client(BORDERLINE_SCORE))
    judge_fn = AsyncMock(return_value=True)
    rerank_fn = AsyncMock(return_value=0)
    result = await cache.check("hello", CacheCheckOptions(
        rerank=RerankOptions(k=1, rerank_fn=rerank_fn),
        judge=JudgeOptions(judge_fn=judge_fn),
    ))
    assert result.hit is True
    assert result.confidence == "high"
    judge_fn.assert_awaited_once()


@pytest.mark.asyncio
async def test_judge_composes_with_rerank_reject():
    cache = await make_cache(make_client(BORDERLINE_SCORE))
    judge_fn = AsyncMock(return_value=False)
    rerank_fn = AsyncMock(return_value=0)
    result = await cache.check("hello", CacheCheckOptions(
        rerank=RerankOptions(k=1, rerank_fn=rerank_fn),
        judge=JudgeOptions(judge_fn=judge_fn),
    ))
    assert result.hit is False
    assert result.nearest_miss is not None
    assert result.nearest_miss.delta_to_threshold <= 0


# ── 10. judgeFn receives correct inputs ───────────────────────────────────────

@pytest.mark.asyncio
async def test_judge_fn_receives_correct_inputs():
    cache = await make_cache(make_client(BORDERLINE_SCORE, response="Test response"))
    received: dict = {}
    async def capturing_fn(inp: dict) -> bool:
        received.update(inp)
        return True
    await cache.check("my prompt", CacheCheckOptions(
        judge=JudgeOptions(judge_fn=capturing_fn),
        category="test-cat",
    ))
    assert received["prompt"] == "my prompt"
    assert received["response"] == "Test response"
    assert abs(received["similarity"] - 0.08) < 1e-5
    assert received["threshold"] == THRESHOLD
    assert received["category"] == "test-cat"


# ── 11. check_batch raises when judge is supplied ─────────────────────────────

@pytest.mark.asyncio
async def test_check_batch_raises_with_judge():
    cache = await make_cache(make_client(BORDERLINE_SCORE))
    with pytest.raises(SemanticCacheUsageError, match="judge"):
        await cache.check_batch(
            ["hello"],
            CacheCheckOptions(judge=JudgeOptions(judge_fn=AsyncMock(return_value=True))),
        )
