from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Protocol


class MemoryStoreClient(Protocol):
    """Client contract MemoryStore needs: a single ``execute_command`` entrypoint.

    The real ``valkey.asyncio.Valkey`` client satisfies this. Commands and their
    arguments are passed positionally, e.g. ``execute_command("HSET", key, ...)``.
    Binary arguments (encoded vectors) are passed as ``bytes``.
    """

    def execute_command(self, *args: Any) -> Awaitable[Any]: ...


EmbedFn = Callable[[str], Awaitable[list[float]]]


@dataclass
class MemoryScope:
    thread_id: str | None = None
    agent_id: str | None = None
    namespace: str | None = None


@dataclass
class MemoryItem:
    id: str
    content: str
    importance: float
    tags: list[str]
    created_at: int
    last_accessed_at: int
    access_count: int
    source: str | None = None
    thread_id: str | None = None
    agent_id: str | None = None
    namespace: str | None = None


@dataclass
class MemoryHit:
    item: MemoryItem
    # Raw KNN vector *distance* (cosine), not a similarity: lower means closer
    # (a perfect match approaches 0). Despite the field name, do not assume
    # higher is better. The composite ``score`` (higher is better) is the field
    # to rank recall results by.
    similarity: float
    # Composite recall score (similarity + recency + importance); higher is better.
    score: float


@dataclass
class ConsolidateResult:
    consolidated: int
    created: list[str]
    deleted: int


# Summarize callback: receives the candidate memories and returns a summary string.
SummarizeFn = Callable[[list[MemoryItem]], Awaitable[str]]


@dataclass
class RecallWeights:
    similarity: float
    recency: float
    importance: float


@dataclass
class MemoryDiscoveryConfig:
    version: str | None = None
    heartbeat_interval_ms: int | None = None


@dataclass
class MemoryConfigRefreshConfig:
    enabled: bool | None = None
    interval_ms: int | None = None


@dataclass
class MemoryConfigSnapshot:
    threshold: float
    weights: RecallWeights
    half_life_seconds: float
    max_items_per_scope: int | None = None


@dataclass
class AgentMemoryRecallConfig:
    weights: RecallWeights | None = None
    half_life_seconds: float | None = None


@dataclass
class AgentMemoryConfig:
    default_threshold: float | None = None
    recall: AgentMemoryRecallConfig | None = None
    max_items_per_scope: int | None = None
    discovery: bool | MemoryDiscoveryConfig = True
    config_refresh: bool | MemoryConfigRefreshConfig | None = None


def _empty_memory_config() -> AgentMemoryConfig:
    return AgentMemoryConfig()
