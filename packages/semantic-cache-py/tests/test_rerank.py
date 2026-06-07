"""Tests for the built-in keyword-overlap rerank factory."""

from __future__ import annotations

import pytest

from betterdb_semantic_cache.rerank import create_keyword_overlap_rerank


# -- compare="prompt" (default) --

async def test_prompt_compare_picks_entity_match():
    """Berlin query should prefer the Berlin candidate, not Paris."""
    rerank = create_keyword_overlap_rerank()
    candidates = [
        {"prompt": "what is the weather in paris", "response": "Sunny, 25C", "similarity": 0.05},
        {"prompt": "what is the weather in berlin", "response": "Cloudy, 18C", "similarity": 0.05},
    ]
    idx = await rerank("what is the weather in berlin", candidates)
    assert idx == 1


async def test_default_compare_is_prompt():
    """Omitting compare= should behave like compare='prompt'."""
    rerank_default = create_keyword_overlap_rerank()
    rerank_explicit = create_keyword_overlap_rerank(compare="prompt")
    candidates = [
        {"prompt": "what is the weather in paris", "response": "weather in berlin", "similarity": 0.05},
        {"prompt": "what is the weather in berlin", "response": "weather in paris", "similarity": 0.05},
    ]
    query = "what is the weather in berlin"
    assert await rerank_default(query, candidates) == await rerank_explicit(query, candidates)


# -- compare="response" --

async def test_response_compare_picks_response_overlap():
    """When compare='response', selection follows response overlap."""
    rerank = create_keyword_overlap_rerank(compare="response")
    candidates = [
        {"prompt": "what is the weather in berlin", "response": "Sunny in paris", "similarity": 0.05},
        {"prompt": "what is the weather in paris", "response": "Cloudy in berlin", "similarity": 0.05},
    ]
    idx = await rerank("weather in berlin", candidates)
    assert idx == 1


# -- cosine_weight extremes --

async def test_cosine_weight_1_ignores_overlap():
    """cosine_weight=1.0 reduces to pure cosine (overlap ignored)."""
    rerank = create_keyword_overlap_rerank(cosine_weight=1.0)
    # Candidate 0 has worse prompt overlap but better similarity
    candidates = [
        {"prompt": "completely different text", "response": "", "similarity": 0.01},
        {"prompt": "what is the weather in berlin", "response": "", "similarity": 0.5},
    ]
    idx = await rerank("what is the weather in berlin", candidates)
    assert idx == 0  # pure cosine: 0.01 distance wins


async def test_cosine_weight_0_ignores_cosine():
    """cosine_weight=0.0 reduces to pure overlap."""
    rerank = create_keyword_overlap_rerank(cosine_weight=0.0)
    # Candidate 1 has perfect prompt overlap but terrible similarity
    candidates = [
        {"prompt": "completely different text", "response": "", "similarity": 0.01},
        {"prompt": "what is the weather in berlin", "response": "", "similarity": 0.99},
    ]
    idx = await rerank("what is the weather in berlin", candidates)
    assert idx == 1  # pure overlap: perfect match wins


# -- Edge cases --

async def test_empty_query_no_crash():
    """Empty query -> overlap contributes 0, falls back to cosine ordering."""
    rerank = create_keyword_overlap_rerank()
    candidates = [
        {"prompt": "hello world", "response": "hi", "similarity": 0.3},
        {"prompt": "foo bar", "response": "baz", "similarity": 0.1},
    ]
    idx = await rerank("", candidates)
    assert idx == 1  # cosine dominates: 0.1 distance wins


async def test_missing_prompt_on_candidate_no_crash():
    """Missing/empty prompt on a candidate -> treated as empty, no crash."""
    rerank = create_keyword_overlap_rerank()
    candidates = [
        {"response": "some response", "similarity": 0.05},  # no prompt key
        {"prompt": "", "response": "other", "similarity": 0.05},  # empty prompt
        {"prompt": "what is the weather in berlin", "response": "", "similarity": 0.05},
    ]
    idx = await rerank("what is the weather in berlin", candidates)
    assert idx == 2  # only candidate 2 has overlap


async def test_cosine_weight_out_of_range_raises():
    """cosine_weight outside [0, 1] raises ValueError."""
    with pytest.raises(ValueError, match="cosine_weight must be in"):
        create_keyword_overlap_rerank(cosine_weight=1.5)
    with pytest.raises(ValueError, match="cosine_weight must be in"):
        create_keyword_overlap_rerank(cosine_weight=-0.1)


# -- Phase 1 contract: candidate dicts include prompt --

async def test_check_candidate_includes_prompt_key():
    """The candidate dicts built by SemanticCache.check include a 'prompt' key."""
    from unittest.mock import AsyncMock
    from tests.conftest import make_client, make_telemetry
    from betterdb_semantic_cache import SemanticCache, SemanticCacheOptions, CacheCheckOptions, RerankOptions

    client = make_client(search_result={
        "key": "entry:1",
        "fields": {"prompt": "stored prompt text", "response": "cached resp", "cost_micros": "100"},
    })
    telemetry = make_telemetry()

    captured: list[dict] | None = None

    async def spy_rerank(query: str, candidates: list[dict]) -> int:
        nonlocal captured
        captured = candidates
        return 0

    cache = SemanticCache(SemanticCacheOptions(
        client=client,
        embed_fn=AsyncMock(return_value=[0.1, 0.2]),
        name="test_cache",
    ))
    cache._telemetry = telemetry
    cache._initialized = True
    cache._dimension = 2

    await cache.check("incoming query", CacheCheckOptions(
        rerank=RerankOptions(k=3, rerank_fn=spy_rerank),
    ))

    assert captured is not None
    assert len(captured) >= 1
    assert "prompt" in captured[0]
    assert captured[0]["prompt"] == "stored prompt text"
    assert "response" in captured[0]
    assert "similarity" in captured[0]
