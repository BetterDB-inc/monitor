"""
STS Benchmark (STSb) dataset loader.

Dataset: mteb/stsbenchmark-sts on HuggingFace.
Each pair has a human-annotated similarity score (0-5) and a genre label
(main-captions, main-news, main-forum).

Unlike vcache_lmarena and paws_wiki which have binary labels, STSb has
continuous scores.  We convert to binary is_semantic_match using a
configurable match_threshold (default 0.6 on a 0-1 normalized scale,
i.e. 3.0 on the raw 0-5 scale).  Pairs near this boundary are the ones
that stress the self-tuning algorithm's threshold decision signals.

Genre labels are forwarded as category so per-category tuning can be
exercised — something neither vcache_lmarena nor paws_wiki support.
"""
from __future__ import annotations

from cache_benchmark.types import QueryPair

DATASET_NAME = "mteb/stsbenchmark-sts"


def _clean_genre(genre: str) -> str:
    """Normalize STSb genre names to a consistent set."""
    g = genre.removeprefix("main-") if genre else "unknown"
    # The source data uses both "forum" and "forums" — normalize.
    if g == "forums":
        g = "forum"
    return g


def load_stsb(
    match_threshold: float = 0.6,
    limit: int | None = None,
) -> list[QueryPair]:
    """Load STSb and return labeled QueryPair instances.

    Args:
        match_threshold: Normalized similarity score (0-1) at or above which
            a pair is considered a semantic match.  Default 0.6 (= 3.0/5.0),
            the boundary between "roughly equivalent" and "not equivalent"
            in the STS annotation guidelines.
        limit: If given, truncate the returned list to this many pairs.

    Returns:
        List of QueryPair with genre-based category labels.
    """
    from datasets import load_dataset  # type: ignore

    # Load all splits and concatenate for maximum data (8,628 pairs total).
    ds = load_dataset(DATASET_NAME)
    rows: list[dict] = []
    for split in ds:
        for row in ds[split]:
            rows.append(row)

    pairs: list[QueryPair] = []
    for row in rows:
        # mteb variant has raw 0-5 scores; normalize to 0-1.
        score = float(row["score"]) / 5.0
        pairs.append(QueryPair(
            prompt_a=row["sentence1"],
            prompt_b=row["sentence2"],
            is_semantic_match=score >= match_threshold,
            category=_clean_genre(row.get("genre", "")),
            source="stsb",
        ))

    if limit is not None:
        pairs = pairs[:limit]

    return pairs


if __name__ == "__main__":
    pairs = load_stsb(limit=100)
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
