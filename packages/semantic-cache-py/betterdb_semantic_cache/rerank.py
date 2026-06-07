"""Built-in rerank factories for betterdb-semantic-cache."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Literal


def _tokenize(text: str) -> set[str]:
    """Lowercase, split on whitespace, strip surrounding punctuation.

    Deterministic and dependency-free.
    # IDF weighting would attach here at the token-weighting step.
    """
    out: set[str] = set()
    for raw in text.lower().split():
        tok = raw.strip(".,!?;:\"'()[]{}<>")
        if tok:
            out.add(tok)
    return out


def create_keyword_overlap_rerank(
    *,
    compare: Literal["prompt", "response"] = "prompt",
    cosine_weight: float = 0.7,
) -> Callable[[str, list[dict]], Awaitable[int]]:
    """Built-in keyword-overlap reranker.

    Blends cosine similarity with word overlap and returns the index of the
    best candidate.

    compare:
      "prompt"   - overlap of the incoming query against each candidate's stored
                   prompt. Equivalence signal. Catches entity mismatches
                   (e.g. "weather in Paris" vs "weather in Berlin"). Default.
      "response" - overlap of the incoming query against each candidate's cached
                   response. Relevance signal.

    cosine_weight: weight on cosine similarity in [0, 1]. Overlap weight is
                   (1 - cosine_weight). Default 0.7 (overlap 0.3).

    Candidate dicts are expected to carry: "similarity" (cosine distance, lower
    is more similar), "response" (str), and "prompt" (str, stored prompt).
    """
    if not 0.0 <= cosine_weight <= 1.0:
        raise ValueError("cosine_weight must be in [0, 1]")
    overlap_weight = 1.0 - cosine_weight

    async def rerank_fn(query: str, candidates: list[dict]) -> int:
        query_tokens = _tokenize(query)
        best_idx, best_score = 0, float("-inf")
        for i, cand in enumerate(candidates):
            text = str(cand.get(compare, "") or "")
            cand_tokens = _tokenize(text)
            if query_tokens:
                overlap = len(query_tokens & cand_tokens) / len(query_tokens)
            else:
                overlap = 0.0
            sim = float(cand.get("similarity", 1.0))
            cosine_sim = 1.0 - sim  # candidates carry cosine DISTANCE
            score = cosine_weight * cosine_sim + overlap_weight * overlap
            if score > best_score:
                best_score, best_idx = score, i
        return best_idx

    return rerank_fn
