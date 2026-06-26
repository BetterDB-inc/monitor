from __future__ import annotations

import weakref
from typing import Any

from prometheus_client import CollectorRegistry, Counter, Histogram

from .telemetry import RetrievalOperation

_OPERATION_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0]
_QUERY_RESULT_BUCKETS = [0, 1, 5, 10, 25, 50, 100]

# WeakKeyDictionary keyed on the registry so cached metric instances are evicted
# when the registry is garbage-collected.
_metric_cache: weakref.WeakKeyDictionary[CollectorRegistry, dict[str, Any]] = (
    weakref.WeakKeyDictionary()
)


def _get_or_create_counter(registry: CollectorRegistry, name: str, documentation: str) -> Counter:
    by_name = _metric_cache.setdefault(registry, {})
    if name not in by_name:
        try:
            by_name[name] = Counter(name, documentation, registry=registry)
        except ValueError:
            existing = getattr(registry, "_names_to_collectors", {}).get(name)
            if existing is None:
                raise
            by_name[name] = existing
    return by_name[name]


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
            existing = getattr(registry, "_names_to_collectors", {}).get(name)
            if existing is None:
                raise
            by_name[name] = existing
    return by_name[name]


class PrometheusRetrievalMetrics:
    """A :class:`RetrievalMetrics` implementation backed by prometheus_client."""

    def __init__(self, registry: CollectorRegistry, prefix: str = "retrieval") -> None:
        self._operation_duration = _get_or_create_histogram(
            registry,
            f"{prefix}_operation_duration_seconds",
            "Duration of retrieval operations in seconds",
            ["operation"],
            _OPERATION_BUCKETS,
        )
        self._query_results = _get_or_create_histogram(
            registry,
            f"{prefix}_query_results",
            "Number of hits returned per query",
            [],
            _QUERY_RESULT_BUCKETS,
        )
        self._embedding_calls = _get_or_create_counter(
            registry,
            f"{prefix}_embedding_calls_total",
            "Total number of embedding function calls",
        )

    def observe_operation(self, operation: RetrievalOperation, seconds: float) -> None:
        self._operation_duration.labels(operation).observe(seconds)

    def record_query_results(self, count: int) -> None:
        self._query_results.observe(count)

    def record_embedding_call(self) -> None:
        self._embedding_calls.inc()


def create_prometheus_metrics(
    registry: CollectorRegistry, prefix: str = "retrieval"
) -> PrometheusRetrievalMetrics:
    return PrometheusRetrievalMetrics(registry, prefix)
