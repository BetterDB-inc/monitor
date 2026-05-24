"""
vCache SemBenchmarkLmArena dataset loader.

Dataset: vCache/SemBenchmarkLmArena on HuggingFace.
Two prompts are a true semantic match if and only if they share the same
ID_Set value (equivalence class). The field name is confirmed at runtime —
if the dataset schema changes, a warning is logged and we fall back to
detecting the first field whose name contains "set", "class", or "equivalence".
"""
from __future__ import annotations

import logging
import random
from itertools import combinations

from cache_benchmark.types import QueryPair

logger = logging.getLogger(__name__)

DATASET_NAME = "vCache/SemBenchmarkLmArena"
PREFERRED_SPLIT = "train"
# Field used to group semantically equivalent prompts.
# Confirmed from dataset features: ID_Set groups prompts that share the same
# semantic intent (equivalence class). Two prompts with the same ID_Set are
# a true cache hit; different ID_Set means they should not match.
EQUIVALENCE_FIELD = "ID_Set"


def _detect_equivalence_field(features: dict) -> str:
    if EQUIVALENCE_FIELD in features:
        return EQUIVALENCE_FIELD
    # Fallback: look for any field with "set", "class", or "equivalence" in name
    for name in features:
        lower = name.lower()
        if "set" in lower or "class" in lower or "equivalence" in lower:
            logger.warning(
                "Field '%s' not found; using '%s' as equivalence field", EQUIVALENCE_FIELD, name
            )
            return name
    raise ValueError(
        f"Cannot find equivalence field in dataset features: {list(features.keys())}"
    )


def load_vcache_lmarena(limit: int | None = None) -> list[QueryPair]:
    """Load SemBenchmarkLmArena and return labeled QueryPair instances.

    Each prompt belongs to an equivalence class. We form pairs by taking all
    combinations of prompts within the same class (positive pairs) and an
    equal number of cross-class pairs (negative pairs) to keep the dataset balanced.

    Args:
        limit: If given, truncate the returned list to this many pairs.

    Returns:
        List of QueryPair with is_semantic_match=True for same-class pairs.
    """
    from datasets import load_dataset  # type: ignore

    try:
        ds = load_dataset(DATASET_NAME, split=PREFERRED_SPLIT)
    except Exception as e:
        logger.warning("Could not load split '%s': %s. Trying first available split.", PREFERRED_SPLIT, e)
        ds_dict = load_dataset(DATASET_NAME)
        first_split = list(ds_dict.keys())[0]
        logger.warning("Using split: %s", first_split)
        ds = ds_dict[first_split]

    eq_field = _detect_equivalence_field(dict(ds.features))

    # Group prompts by equivalence class
    classes: dict[str, list[str]] = {}
    # Determine which field holds the prompt text (confirmed: "prompt" in this dataset)
    prompt_field = next(
        (f for f in ("prompt", "query", "question", "text") if f in ds.features),
        None,
    )
    if prompt_field is None:
        raise ValueError(f"Cannot find prompt field in dataset features: {list(ds.features.keys())}")
    logger.info("Using field '%s' as prompt text", prompt_field)

    for row in ds:
        cls_id = str(row[eq_field])
        prompt = row[prompt_field]
        if prompt:
            classes.setdefault(cls_id, []).append(prompt)

    pairs: list[QueryPair] = []

    # Positive pairs: all combinations within each class
    for cls_id, prompts in classes.items():
        for a, b in combinations(prompts, 2):
            pairs.append(QueryPair(
                prompt_a=a,
                prompt_b=b,
                is_semantic_match=True,
                category=cls_id,
                source="vcache_lmarena",
            ))

    # Negative pairs: sample cross-class pairs to match positive count.
    # random.sample(k=2) always returns distinct elements, so no id_a == id_b check needed.
    class_ids = list(classes.keys())
    n_positive = len(pairs)
    neg_pairs: list[QueryPair] = []
    attempts = 0
    while len(neg_pairs) < n_positive and attempts < n_positive * 10:
        attempts += 1
        id_a, id_b = random.sample(class_ids, 2)
        pa = random.choice(classes[id_a])
        pb = random.choice(classes[id_b])
        neg_pairs.append(QueryPair(
            prompt_a=pa,
            prompt_b=pb,
            is_semantic_match=False,
            category=None,
            source="vcache_lmarena",
        ))

    pairs.extend(neg_pairs)
    random.shuffle(pairs)

    if limit is not None:
        pairs = pairs[:limit]

    return pairs


if __name__ == "__main__":
    pairs = load_vcache_lmarena(limit=100)
    for p in pairs[:3]:
        print(p)
    print(f"Total pairs: {len(pairs)}")
