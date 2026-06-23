from __future__ import annotations

import math

from .types import RecallWeights


def recency_decay(age_seconds: float, half_life_seconds: float) -> float:
    """True half-life decay: 1 at age 0, 0.5 at one half_life_seconds, approaching 0 beyond."""
    return math.exp((-math.log(2) * age_seconds) / half_life_seconds)


def composite_score(
    *,
    similarity: float,
    age_seconds: float,
    importance: float,
    weights: RecallWeights,
    half_life_seconds: float,
) -> float:
    """Weighted blend of semantic similarity, recency, and importance.

    Recency is a true half-life decay: 0.5 at one half_life_seconds.
    """
    recency = recency_decay(age_seconds, half_life_seconds)
    return (
        weights.similarity * similarity
        + weights.recency * recency
        + weights.importance * importance
    )


def similarity_from_distance(distance: float) -> float:
    """Map cosine distance (0..2, lower = closer) to a 0..1 similarity score."""
    return 1 - distance / 2
