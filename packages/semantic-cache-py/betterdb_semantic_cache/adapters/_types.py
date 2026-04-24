from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ..utils import BinaryBlock, TextBlock


def _get(obj: Any, key: str, default: Any = None) -> Any:
    """Fetch a field from a dict or attribute from an object."""
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


@dataclass
class SemanticParams:
    """Parameters extracted from an LLM request for semantic cache lookup.

    Returned by every adapter's ``prepare_semantic_params()`` function.
    Pass ``text`` (or ``blocks`` for multi-modal prompts) to
    ``cache.check()`` / ``cache.store()``.
    """
    text: str
    blocks: list[TextBlock | BinaryBlock] | None = None
    model: str | None = None
