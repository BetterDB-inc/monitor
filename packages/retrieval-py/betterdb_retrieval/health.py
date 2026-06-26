from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Optional


@dataclass
class IndexHealthSnapshot:
    name: str
    num_docs: int
    indexing_state: str
    dims: int
    percent_indexed: float
    estimated_recall: Optional[float] = None


RecallEstimator = Callable[[IndexHealthSnapshot], float]

_PERCENT_INDEXED_KEYS = ("percent_indexed", "backfill_complete_percent")


def _s(x: Any) -> str:
    if isinstance(x, bytes):
        try:
            return x.decode()
        except UnicodeDecodeError:
            return ""
    return str(x)


def parse_percent_indexed(info: list[Any]) -> float:
    """Extract the percent-indexed value from a raw FT.INFO reply.

    valkey-search/RediSearch report either a 0-1 fraction or a 0-100
    percentage depending on the version; both are normalized to 0-100. Returns
    0 if the field is absent or unparseable.
    """
    for i in range(0, len(info) - 1, 2):
        if _s(info[i]) not in _PERCENT_INDEXED_KEYS:
            continue
        try:
            value = float(_s(info[i + 1]))
        except ValueError:
            return 0.0
        return value * 100 if value <= 1 else value
    return 0.0
