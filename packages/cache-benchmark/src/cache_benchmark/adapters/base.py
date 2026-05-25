from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Literal

from cache_benchmark.types import CheckResult


class CacheAdapter(ABC):
    """Abstract interface for all cache backends under benchmark."""

    name: str = "base"

    def __init__(
        self,
        *,
        threshold: float,
        embedding_model: str,
        redis_url: str | None = None,
        mode: Literal["bare", "local", "full", "autotune"] = "bare",
        **kwargs,
    ) -> None:
        self.threshold = threshold
        self.embedding_model = embedding_model
        self.redis_url = redis_url
        self.mode = mode

    @abstractmethod
    def enabled_features(self) -> list[str]:
        """Return a human-readable list of quality features active in the current mode.

        Used for the transparency log printed before each (adapter, threshold) run.
        Always list what is NOT enabled too, so the log is honest.
        """

    async def initialize(self) -> None:
        """Set up the cache (create index, warm model, etc.). No-op by default."""

    @abstractmethod
    async def store(self, prompt: str, response: str) -> None:
        """Store a prompt-response pair in the cache."""

    @abstractmethod
    async def check(self, prompt: str) -> CheckResult:
        """Look up a prompt; returns CheckResult with hit/miss + metadata."""

    @abstractmethod
    async def clear(self) -> None:
        """Clear all cached entries. Called between threshold sweeps."""

    async def close(self) -> None:
        """Tear down connections. No-op by default."""
