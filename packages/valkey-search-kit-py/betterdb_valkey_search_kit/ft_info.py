from __future__ import annotations

from dataclasses import dataclass
from typing import Any


def _s(x: Any) -> str:
    """Coerce a raw FT.INFO token (bytes from valkey-py, or str) to a string."""
    if isinstance(x, bytes):
        try:
            return x.decode()
        except UnicodeDecodeError:
            return ""
    return str(x)


def _to_int(x: Any) -> int:
    try:
        return int(_s(x))
    except ValueError:
        return 0


def parse_dimension_from_info(info: list[Any]) -> int:
    """Extract the vector field dimension from a raw FT.INFO reply.

    Handles both reply shapes across Valkey Search versions:

    - flat attribute pairs with a ``DIM`` key
    - Valkey Search 1.2, which nests dimension inside an ``index`` sub-array
      under a ``dimensions`` key

    Returns 0 if no vector field with a positive dimension is found.
    """
    for i in range(0, len(info) - 1, 2):
        key = _s(info[i])
        if key not in ("attributes", "fields"):
            continue

        attributes = info[i + 1]
        if not isinstance(attributes, (list, tuple)):
            continue

        for attr in attributes:
            if not isinstance(attr, (list, tuple)):
                continue

            is_vector = False
            dim = 0

            j = 0
            while j < len(attr) - 1:
                attr_key = _s(attr[j])
                if attr_key == "type" and _s(attr[j + 1]) == "VECTOR":
                    is_vector = True
                if attr_key.lower() == "dim":
                    dim = _to_int(attr[j + 1])
                if attr_key == "index" and isinstance(attr[j + 1], (list, tuple)):
                    index_arr = attr[j + 1]
                    k = 0
                    while k < len(index_arr) - 1:
                        if _s(index_arr[k]) == "dimensions":
                            d = _to_int(index_arr[k + 1])
                            if d > 0:
                                dim = d
                        k += 1
                j += 1

            if is_vector and dim > 0:
                return dim

    return 0


@dataclass(frozen=True)
class FtIndexStats:
    num_docs: int
    indexing_state: str


def parse_ft_info_stats(info: list[Any]) -> FtIndexStats:
    """Walk the flat key/value pairs of a raw FT.INFO reply and extract
    ``num_docs`` and the indexing state.
    """
    num_docs = 0
    indexing_state = "unknown"
    for i in range(0, len(info) - 1, 2):
        key = _s(info[i])
        if key == "num_docs":
            num_docs = _to_int(info[i + 1])
        elif key == "indexing":
            indexing_state = _s(info[i + 1])
    return FtIndexStats(num_docs=num_docs, indexing_state=indexing_state)
