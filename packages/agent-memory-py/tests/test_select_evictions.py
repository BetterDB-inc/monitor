from __future__ import annotations

from betterdb_agent_memory.select_evictions import (
    EvictionCandidate,
    SelectEvictionsOptions,
    select_evictions,
)
from betterdb_agent_memory.types import RecallWeights

HALF_LIFE = 604800
NOW = 1_000_000_000_000
WEIGHTS = RecallWeights(similarity=0.6, recency=0.25, importance=0.15)


def candidate(key: str, importance: float, age_seconds: float) -> EvictionCandidate:
    return EvictionCandidate(
        key=key, importance=importance, last_accessed_at=NOW - age_seconds * 1000
    )


def opts(weights: RecallWeights = WEIGHTS) -> SelectEvictionsOptions:
    return SelectEvictionsOptions(now=NOW, half_life_seconds=HALF_LIFE, weights=weights)


def test_evicts_nothing_at_or_under_capacity() -> None:
    items = [candidate("a", 0.1, 0), candidate("b", 0.9, 0)]
    assert select_evictions(items, 2, opts()) == []
    assert select_evictions(items, 5, opts()) == []


def test_drops_exactly_count_minus_max() -> None:
    items = [
        candidate("a", 0.1, 0),
        candidate("b", 0.2, 0),
        candidate("c", 0.3, 0),
        candidate("d", 0.4, 0),
    ]
    assert len(select_evictions(items, 2, opts())) == 2


def test_evicts_lowest_importance_when_recency_equal() -> None:
    items = [candidate("low", 0.1, 0), candidate("mid", 0.5, 0), candidate("high", 0.9, 0)]
    assert select_evictions(items, 1, opts()) == ["low", "mid"]


def test_evicts_oldest_when_importance_equal() -> None:
    items = [
        candidate("fresh", 0.5, 0),
        candidate("week", 0.5, HALF_LIFE),
        candidate("ancient", 0.5, HALF_LIFE * 4),
    ]
    assert select_evictions(items, 1, opts()) == ["ancient", "week"]


def test_fresh_trivial_outranks_stale_important_when_recency_dominates() -> None:
    recency_heavy = RecallWeights(similarity=0, recency=0.9, importance=0.1)
    items = [
        candidate("staleImportant", 0.9, HALF_LIFE * 6),
        candidate("freshTrivial", 0.1, 0),
    ]
    assert select_evictions(items, 1, opts(recency_heavy)) == ["staleImportant"]


def test_returns_every_key_when_max_is_zero() -> None:
    items = [candidate("a", 0.5, 0), candidate("b", 0.5, 10)]
    assert sorted(select_evictions(items, 0, opts())) == ["a", "b"]
