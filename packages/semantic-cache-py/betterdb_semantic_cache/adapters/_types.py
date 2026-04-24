from __future__ import annotations

from dataclasses import dataclass

from ..utils import BinaryBlock, TextBlock


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
