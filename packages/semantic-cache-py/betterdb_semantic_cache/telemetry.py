from __future__ import annotations

import weakref
from dataclasses import dataclass
from typing import Any

from opentelemetry import trace
from opentelemetry.trace import Tracer
from prometheus_client import REGISTRY as _DEFAULT_REGISTRY
from prometheus_client import CollectorRegistry, Counter, Histogram

_OPERATION_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0]
_SIMILARITY_BUCKETS = [0.02, 0.05, 0.08, 0.1, 0.12, 0.15, 0.2, 0.3, 0.5, 1.0, 2.0]

# WeakKeyDictionary keyed on the registry object itself so entries are
# automatically evicted when the registry is garbage-collected, preventing
# stale metric instances from being returned to a new registry that happens
# to occupy the same memory address.
_metric_cache: weakref.WeakKeyDictionary[CollectorRegistry, dict[str, Any]] = (
    weakref.WeakKeyDictionary()
)


def _get_or_create_counter(
    registry: CollectorRegistry,
    name: str,
    documentation: str,
    labelnames: list[str],
) -> Counter:
    by_name = _metric_cache.setdefault(registry, {})
    if name not in by_name:
        try:
            by_name[name] = Counter(name, documentation, labelnames, registry=registry)
        except ValueError:
            # Metric already registered externally — retrieve via the private
            # _names_to_collectors map (guarded against removal in future releases).
            existing = getattr(registry, "_names_to_collectors", {}).get(name)
            if existing is None:
                raise
            by_name[name] = existing
    return by_name[name]  # type: ignore[return-value]


def _get_or_create_histogram(
    registry: CollectorRegistry,
    name: str,
    documentation: str,
    labelnames: list[str],
    buckets: list[float],
) -> Histogram:
    by_name = _metric_cache.setdefault(registry, {})
    if name not in by_name:
        try:
            by_name[name] = Histogram(
                name, documentation, labelnames, buckets=buckets, registry=registry
            )
        except ValueError:
            # Metric already registered externally — retrieve via the private
            # _names_to_collectors map (guarded against removal in future releases).
            existing = getattr(registry, "_names_to_collectors", {}).get(name)
            if existing is None:
                raise
            by_name[name] = existing
    return by_name[name]  # type: ignore[return-value]


@dataclass
class SemanticCacheMetrics:
    requests_total: Counter
    similarity_score: Histogram
    operation_duration: Histogram
    embedding_duration: Histogram
    cost_saved_total: Counter
    embedding_cache_total: Counter
    stale_model_evictions: Counter


@dataclass
class Telemetry:
    tracer: Tracer
    metrics: SemanticCacheMetrics


def create_telemetry(
    prefix: str,
    tracer_name: str,
    registry: CollectorRegistry | None = None,
) -> Telemetry:
    reg = registry or _DEFAULT_REGISTRY
    tracer = trace.get_tracer(tracer_name)

    metrics = SemanticCacheMetrics(
        requests_total=_get_or_create_counter(
            reg,
            f"{prefix}_requests_total",
            "Total number of semantic cache requests",
            ["cache_name", "result", "category"],
        ),
        similarity_score=_get_or_create_histogram(
            reg,
            f"{prefix}_similarity_score",
            "Cosine distance similarity scores for cache lookups",
            ["cache_name", "category"],
            _SIMILARITY_BUCKETS,
        ),
        operation_duration=_get_or_create_histogram(
            reg,
            f"{prefix}_operation_duration_seconds",
            "Duration of semantic cache operations in seconds",
            ["cache_name", "operation"],
            _OPERATION_BUCKETS,
        ),
        embedding_duration=_get_or_create_histogram(
            reg,
            f"{prefix}_embedding_duration_seconds",
            "Duration of embedding function calls in seconds",
            ["cache_name"],
            _OPERATION_BUCKETS,
        ),
        cost_saved_total=_get_or_create_counter(
            reg,
            f"{prefix}_cost_saved_total",
            "Estimated cost saved in dollars from semantic cache hits",
            ["cache_name", "category"],
        ),
        embedding_cache_total=_get_or_create_counter(
            reg,
            f"{prefix}_embedding_cache_total",
            "Total embedding cache lookups (hit or miss)",
            ["cache_name", "result"],
        ),
        stale_model_evictions=_get_or_create_counter(
            reg,
            f"{prefix}_stale_model_evictions_total",
            "Entries evicted due to stale_after_model_change detection",
            ["cache_name"],
        ),
    )

    return Telemetry(tracer=tracer, metrics=metrics)
