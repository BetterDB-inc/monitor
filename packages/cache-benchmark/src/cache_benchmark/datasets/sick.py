"""
SICK (Sentences Involving Compositional Knowledge) dataset loader.

Dataset: mteb/sickr-sts on HuggingFace.
Each pair has a human-annotated relatedness score (1-5).

SICK is designed to test compositional semantics — pairs that are superficially
similar but semantically different (and vice versa). The dense [3,4) score band
(3,904 of 9,927 pairs) is the "ambiguous middle" where self-tuning threshold
decisions are hardest.

The original SICK dataset also has entailment labels (entailment/neutral/
contradiction) but the MTEB variant only has scores. We derive categories
from the score itself: "high" (>=4), "medium" ([3,4)), "low" (<3). This
mirrors the entailment split — high-score pairs are mostly entailments,
low-score pairs are mostly contradictions, and the medium band is where
neutral pairs cluster.
"""
from __future__ import annotations

from cache_benchmark.types import QueryPair

DATASET_NAME = "mteb/sickr-sts"


def _score_to_category(score: float) -> str:
    """Map relatedness score to a category."""
    if score >= 4.0:
        return "high"
    if score >= 3.0:
        return "medium"
    return "low"


def load_sick(
    match_threshold: float = 0.6,
    limit: int | None = None,
) -> list[QueryPair]:
    """Load SICK-R and return labeled QueryPair instances.

    Args:
        match_threshold: Normalized similarity score (0-1) at or above which
            a pair is considered a semantic match. Default 0.6 (= 3.0/5.0).
        limit: If given, truncate the returned list to this many pairs.

    Returns:
        List of QueryPair with score-derived category labels.
    """
    from datasets import load_dataset  # type: ignore

    ds = load_dataset(DATASET_NAME, split="test")

    pairs: list[QueryPair] = []
    for row in ds:
        # MTEB variant has raw 1-5 scores; normalize to 0-1.
        score = float(row["score"]) / 5.0
        pairs.append(QueryPair(
            prompt_a=row["sentence1"],
            prompt_b=row["sentence2"],
            is_semantic_match=score >= match_threshold,
            category=_score_to_category(float(row["score"])),
            source="sick",
        ))

    if limit is not None:
        pairs = pairs[:limit]

    return pairs


if __name__ == "__main__":
    pairs = load_sick()
    categories = {}
    matches = 0
    for p in pairs:
        categories[p.category] = categories.get(p.category, 0) + 1
        if p.is_semantic_match:
            matches += 1
    print(f"Total pairs: {len(pairs)}")
    print(f"Matches: {matches}, Non-matches: {len(pairs) - matches}")
    print(f"Categories: {categories}")
    for p in pairs[:3]:
        print(p)
