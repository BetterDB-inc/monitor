from __future__ import annotations

from betterdb_agent_memory.composite_score import composite_score
from betterdb_agent_memory.types import RecallWeights

W = RecallWeights(similarity=0.6, recency=0.25, importance=0.15)
HALF = 604800  # 7 days


def test_decays_recency_to_half_at_one_half_life() -> None:
    score = composite_score(
        similarity=0,
        importance=0,
        age_seconds=HALF,
        weights=RecallWeights(similarity=0, recency=1, importance=0),
        half_life_seconds=HALF,
    )
    assert round(score, 5) == round(0.5, 5)


def test_combines_weighted_similarity_recency_importance() -> None:
    score = composite_score(
        similarity=1,
        importance=1,
        age_seconds=0,
        weights=W,
        half_life_seconds=HALF,
    )
    assert round(score, 5) == round(1, 5)


def test_ranks_identical_recent_above_distant() -> None:
    identical = composite_score(
        similarity=1, importance=0.5, age_seconds=0, weights=W, half_life_seconds=HALF
    )
    distant = composite_score(
        similarity=0.2, importance=0.5, age_seconds=0, weights=W, half_life_seconds=HALF
    )
    assert identical > distant


def test_recency_promotes_recent_weaker_over_old_closer() -> None:
    recent_weaker = composite_score(
        similarity=0.6, importance=0.5, age_seconds=0, weights=W, half_life_seconds=HALF
    )
    old_closer = composite_score(
        similarity=0.8, importance=0.5, age_seconds=HALF * 5, weights=W, half_life_seconds=HALF
    )
    assert recent_weaker > old_closer


def test_breaks_ties_by_importance() -> None:
    high = composite_score(
        similarity=0.5, importance=0.9, age_seconds=0, weights=W, half_life_seconds=HALF
    )
    low = composite_score(
        similarity=0.5, importance=0.1, age_seconds=0, weights=W, half_life_seconds=HALF
    )
    assert high > low
