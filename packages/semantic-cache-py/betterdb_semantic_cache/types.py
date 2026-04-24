from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

# EmbedFn: async callable that returns a float embedding vector for a text string.
EmbedFn = Callable[[str], Awaitable[list[float]]]


@dataclass
class ModelCost:
    input_per_1k: float
    output_per_1k: float


@dataclass
class EmbeddingCacheOptions:
    enabled: bool = True
    ttl: int = 86400


@dataclass
class TelemetryOptions:
    tracer_name: str = "betterdb-semantic-cache"
    metrics_prefix: str = "semantic_cache"
    registry: Any = None  # prometheus_client.CollectorRegistry


@dataclass
class AnalyticsOptions:
    disabled: bool = False
    stats_interval_s: float = 300.0


@dataclass
class SemanticCacheOptions:
    client: Any  # valkey.asyncio.Valkey or ValkeyCluster
    embed_fn: EmbedFn
    name: str = "betterdb_scache"
    default_threshold: float = 0.1
    default_ttl: int | None = None
    category_thresholds: dict[str, float] = field(default_factory=dict)
    uncertainty_band: float = 0.05
    cost_table: dict[str, ModelCost] = field(default_factory=dict)
    use_default_cost_table: bool = True
    normalizer: Any = None  # BinaryNormalizer | None
    embedding_cache: EmbeddingCacheOptions = field(default_factory=EmbeddingCacheOptions)
    telemetry: TelemetryOptions = field(default_factory=TelemetryOptions)
    analytics: AnalyticsOptions = field(default_factory=AnalyticsOptions)


@dataclass
class RerankOptions:
    k: int
    rerank_fn: Callable[[str, list[dict]], Awaitable[int]]


@dataclass
class CacheCheckOptions:
    threshold: float | None = None
    category: str = ""
    filter: str | None = None
    k: int = 1
    stale_after_model_change: bool = False
    current_model: str | None = None
    rerank: RerankOptions | None = None


@dataclass
class CacheStoreOptions:
    ttl: int | None = None
    category: str = ""
    model: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)
    input_tokens: int | None = None
    output_tokens: int | None = None
    temperature: float | None = None
    top_p: float | None = None
    seed: int | None = None


CacheConfidence = str  # 'high' | 'uncertain' | 'miss'


@dataclass
class NearestMiss:
    similarity: float
    delta_to_threshold: float


@dataclass
class CacheCheckResult:
    hit: bool
    confidence: CacheConfidence
    response: str | None = None
    similarity: float | None = None
    matched_key: str | None = None
    nearest_miss: NearestMiss | None = None
    cost_saved: float | None = None
    content_blocks: list[Any] | None = None


@dataclass
class InvalidateResult:
    deleted: int
    truncated: bool


@dataclass
class CacheStats:
    hits: int
    misses: int
    total: int
    hit_rate: float
    cost_saved_micros: int


@dataclass
class IndexInfo:
    name: str
    num_docs: int
    dimension: int
    indexing_state: str


@dataclass
class ThresholdEffectivenessResult:
    category: str
    sample_count: int
    current_threshold: float
    hit_rate: float
    uncertain_hit_rate: float
    near_miss_rate: float
    avg_hit_similarity: float
    avg_miss_similarity: float
    recommendation: str  # 'tighten_threshold' | 'loosen_threshold' | 'optimal' | 'insufficient_data'
    reasoning: str
    recommended_threshold: float | None = None
