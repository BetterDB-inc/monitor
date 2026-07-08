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
    # Reconciliation key, present on fact memories written by consolidate_facts.
    subject: str | None = None
    # Asserted fact date, present on dated fact memories (source of truth for datedness).
    date: str | None = None
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
class Fact:
    """An atomic, durable fact distilled from one or more memories.

    ``subject`` is a short normalized attribute key (e.g. ``"employer"``,
    ``"home_city"``) used to reconcile restatements; ``date`` (if known) drives
    newer-wins resolution and is preserved in the written memory's content.
    ``tombstone=True`` marks the subject as retracted.
    """

    subject: str
    statement: str
    date: str | None = None
    tombstone: bool = False


# Caller-provided LLM seam that distills a batch of source memories into atomic
# facts. The library never bakes in a model - you supply the extraction (mirrors
# the ``summarize`` seam on consolidate()).
FactExtractor = Callable[[list[MemoryItem]], Awaitable[list[Fact]]]


@dataclass
class ConsolidationConfig:
    # Enable write-time fact consolidation (consolidate_facts). Off by default.
    enabled: bool | None = None
    # Source label written on fact memories and excluded from re-consolidation.
    fact_source: str | None = None
    # Default importance assigned to each written fact memory.
    fact_importance: float | None = None


@dataclass
class ConsolidateFactsResult:
    # Source memories examined.
    candidates: int
    # Curated facts after reconciliation (the full set now materialized for the scope).
    facts: int
    # Ids of the newly written fact memories (added or superseded subjects).
    created: list[str]
    # Prior fact memories deleted because a run superseded or retracted their subject.
    deleted: int


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
class MemoryStats:
    item_count: int
    evictions: int
    config: MemoryConfigSnapshot


@dataclass
class MemoryListOptions:
    thread_id: str | None = None
    agent_id: str | None = None
    namespace: str | None = None
    tags: list[str] | None = None
    limit: int | None = None
    offset: int | None = None


@dataclass
class MemoryListResult:
    items: list[MemoryItem]
    total: int


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
