"""betterdb-agent-memory: long-term vector memory tier for AI agents on Valkey.

Re-exports everything from ``betterdb-agent-cache`` (the short-term cache tiers)
alongside the memory tier so the facade is a single import.
"""

from __future__ import annotations

import betterdb_agent_cache as _agent_cache
from betterdb_agent_cache import *  # noqa: F401,F403

from .agent_memory import AgentMemory, AgentMemoryOptions
from .build_recall_query import MATCH_ALL_MEMORY_QUERY
from .composite_score import (
    composite_score,
    recency_decay,
    similarity_from_distance,
)
from .discovery import MEMORY_CACHE_TYPE, MEMORY_CAPABILITIES, MemoryDiscovery
from .memory_store import MemoryStore
from .telemetry import (
    DEFAULT_METRICS_PREFIX,
    DEFAULT_TRACER_NAME,
    MemoryMetrics,
    MemoryTelemetry,
    MemoryTelemetryOptions,
    create_memory_telemetry,
)
from .types import (
    AgentMemoryConfig,
    AgentMemoryRecallConfig,
    ConsolidateResult,
    EmbedFn,
    MemoryConfigRefreshConfig,
    MemoryConfigSnapshot,
    MemoryDiscoveryConfig,
    MemoryHit,
    MemoryItem,
    MemoryListOptions,
    MemoryListResult,
    MemoryScope,
    MemoryStats,
    MemoryStoreClient,
    RecallWeights,
    SummarizeFn,
)

__all__ = [
    # Memory tier
    "AgentMemory",
    "AgentMemoryOptions",
    "AgentMemoryConfig",
    "AgentMemoryRecallConfig",
    "MemoryStore",
    "MemoryDiscovery",
    "MEMORY_CACHE_TYPE",
    "MEMORY_CAPABILITIES",
    # Telemetry
    "create_memory_telemetry",
    "DEFAULT_METRICS_PREFIX",
    "DEFAULT_TRACER_NAME",
    "MemoryTelemetry",
    "MemoryTelemetryOptions",
    "MemoryMetrics",
    # Scoring
    "composite_score",
    "similarity_from_distance",
    "recency_decay",
    # Types
    "EmbedFn",
    "MemoryStoreClient",
    "MemoryScope",
    "MemoryItem",
    "MemoryHit",
    "MemoryListOptions",
    "MemoryListResult",
    "MemoryStats",
    "ConsolidateResult",
    "SummarizeFn",
    "RecallWeights",
    "MemoryConfigSnapshot",
    "MemoryDiscoveryConfig",
    "MemoryConfigRefreshConfig",
    "MATCH_ALL_MEMORY_QUERY",
]

# Surface everything agent-cache exports so consumers need only one import.
__all__ += list(getattr(_agent_cache, "__all__", []))
