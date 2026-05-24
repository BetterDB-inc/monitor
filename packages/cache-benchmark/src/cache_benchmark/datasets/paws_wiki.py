"""
PAWS-Wiki dataset loader.

Dataset: paws/labeled_final on HuggingFace (CC BY 4.0).
label=1 means paraphrase (is_semantic_match=True).
label=0 means non-paraphrase with high lexical overlap (is_semantic_match=False).

This dataset is the false-positive stress test: pairs share surface-level similarity
but may not be semantically equivalent, exercising cache precision.
"""
from __future__ import annotations

from cache_benchmark.types import QueryPair


def load_paws_wiki(split: str = "test", limit: int | None = None) -> list[QueryPair]:
    """Load PAWS-Wiki labeled_final and return QueryPair instances.

    Args:
        split: Dataset split to load ("train", "validation", "test").
        limit: If given, truncate the returned list to this many pairs.

    Returns:
        List of QueryPair with is_semantic_match based on label field.
    """
    from datasets import load_dataset  # type: ignore

    ds = load_dataset("google-research-datasets/paws", "labeled_final", split=split)

    pairs: list[QueryPair] = []
    for row in ds:
        pairs.append(QueryPair(
            prompt_a=row["sentence1"],
            prompt_b=row["sentence2"],
            is_semantic_match=bool(row["label"] == 1),
            category="paws_wiki",
            source="paws_wiki",
        ))

    if limit is not None:
        pairs = pairs[:limit]

    return pairs


if __name__ == "__main__":
    pairs = load_paws_wiki(limit=100)
    for p in pairs[:3]:
        print(p)
    print(f"Total pairs: {len(pairs)}")
