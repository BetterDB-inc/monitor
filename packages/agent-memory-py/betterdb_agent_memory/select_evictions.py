from __future__ import annotations

from dataclasses import dataclass

from .composite_score import recency_decay
from .types import RecallWeights


@dataclass
class EvictionCandidate:
    key: str
    importance: float
    last_accessed_at: float


@dataclass
class SelectEvictionsOptions:
    now: int
    half_life_seconds: float
    weights: RecallWeights


def _eviction_score(candidate: EvictionCandidate, options: SelectEvictionsOptions) -> float:
    weights = options.weights
    denom = weights.importance + weights.recency
    if denom == 0:
        return 0.0
    age_seconds = (options.now - candidate.last_accessed_at) / 1000
    recency = recency_decay(age_seconds, options.half_life_seconds)
    return (weights.importance * candidate.importance + weights.recency * recency) / denom


def select_evictions(
    candidates: list[EvictionCandidate],
    max_items: int,
    options: SelectEvictionsOptions,
) -> list[str]:
    """Pick the keys to evict so that ``max_items`` remain.

    Eviction blends importance with last-access recency (the recall weights,
    minus similarity, renormalized); lowest-scoring keys go first, ties broken
    toward the older last-access.
    """
    drop_count = len(candidates) - max(0, max_items)
    if drop_count <= 0:
        return []
    ranked = sorted(
        (
            (candidate.key, _eviction_score(candidate, options), candidate.last_accessed_at)
            for candidate in candidates
        ),
        key=lambda entry: (entry[1], entry[2]),
    )
    return [entry[0] for entry in ranked[:drop_count]]
