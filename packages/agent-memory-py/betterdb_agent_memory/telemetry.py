from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from opentelemetry import trace
from opentelemetry.trace import Tracer
from prometheus_client import REGISTRY as _DEFAULT_REGISTRY
from prometheus_client import CollectorRegistry, Counter, Gauge, Histogram

DEFAULT_METRICS_PREFIX = "agent_memory"
DEFAULT_TRACER_NAME = "@betterdb/agent-memory"

_RECALL_LATENCY_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0]

# Module-level cache keyed by (id(registry), metric_name) to prevent
# duplicate-registration errors in multi-instance scenarios.
_metric_cache: dict[tuple[int, str], Any] = {}


def _get_or_create_counter(
    registry: CollectorRegistry,
    name: str,
    documentation: str,
    labelnames: list[str],
) -> Counter:
    key = (id(registry), name)
    if key not in _metric_cache:
        try:
            _metric_cache[key] = Counter(name, documentation, labelnames, registry=registry)
        except ValueError:
            existing = registry._names_to_collectors.get(name)
            if existing is None:
                raise
            _metric_cache[key] = existing
    return _metric_cache[key]


def _get_or_create_gauge(
    registry: CollectorRegistry,
    name: str,
    documentation: str,
    labelnames: list[str],
) -> Gauge:
    key = (id(registry), name)
    if key not in _metric_cache:
        try:
            _metric_cache[key] = Gauge(name, documentation, labelnames, registry=registry)
        except ValueError:
            existing = registry._names_to_collectors.get(name)
            if existing is None:
                raise
            _metric_cache[key] = existing
    return _metric_cache[key]


def _get_or_create_histogram(
    registry: CollectorRegistry,
    name: str,
    documentation: str,
    labelnames: list[str],
    buckets: list[float],
) -> Histogram:
    key = (id(registry), name)
    if key not in _metric_cache:
        try:
            _metric_cache[key] = Histogram(
                name, documentation, labelnames, buckets=buckets, registry=registry
            )
        except ValueError:
            existing = registry._names_to_collectors.get(name)
            if existing is None:
                raise
            _metric_cache[key] = existing
    return _metric_cache[key]


@dataclass
class MemoryTelemetryOptions:
    tracer_name: str | None = None
    metrics_prefix: str | None = None
    registry: CollectorRegistry | None = None


@dataclass
class MemoryMetrics:
    items: Gauge
    recall_total: Counter
    recall_hits: Counter
    recall_empty: Counter
    recall_near_miss: Counter
    recall_latency: Histogram
    embedding_calls: Counter
    evictions: Counter
    consolidations: Counter
    fact_tombstone_unmatched: Counter


@dataclass
class MemoryTelemetry:
    tracer: Tracer
    metrics: MemoryMetrics


def create_memory_telemetry(
    options: MemoryTelemetryOptions | None = None,
) -> MemoryTelemetry:
    opts = options or MemoryTelemetryOptions()
    registry = opts.registry or _DEFAULT_REGISTRY
    prefix = opts.metrics_prefix or DEFAULT_METRICS_PREFIX
    tracer = trace.get_tracer(opts.tracer_name or DEFAULT_TRACER_NAME)
    labelnames = ["store_name"]

    metrics = MemoryMetrics(
        items=_get_or_create_gauge(
            registry,
            f"{prefix}_items",
            "Approximate number of stored memories observed in-process",
            labelnames,
        ),
        recall_total=_get_or_create_counter(
            registry,
            f"{prefix}_recall_total",
            "Total recall queries",
            labelnames,
        ),
        recall_hits=_get_or_create_counter(
            registry,
            f"{prefix}_recall_hits_total",
            "Recall queries that returned at least one memory",
            labelnames,
        ),
        recall_empty=_get_or_create_counter(
            registry,
            f"{prefix}_recall_empty_total",
            "Recall queries that returned no memories",
            labelnames,
        ),
        recall_near_miss=_get_or_create_counter(
            registry,
            f"{prefix}_recall_near_miss_total",
            "Recall queries that returned nothing while the nearest candidate sat just past the threshold",
            labelnames,
        ),
        recall_latency=_get_or_create_histogram(
            registry,
            f"{prefix}_recall_latency_seconds",
            "Recall query latency in seconds",
            labelnames,
            _RECALL_LATENCY_BUCKETS,
        ),
        embedding_calls=_get_or_create_counter(
            registry,
            f"{prefix}_embedding_calls_total",
            "Total embedding function invocations",
            labelnames,
        ),
        evictions=_get_or_create_counter(
            registry,
            f"{prefix}_evictions_total",
            "Total memories evicted for capacity",
            labelnames,
        ),
        consolidations=_get_or_create_counter(
            registry,
            f"{prefix}_consolidations_total",
            "Total consolidation summaries created",
            labelnames,
        ),
        fact_tombstone_unmatched=_get_or_create_counter(
            registry,
            f"{prefix}_fact_tombstone_unmatched_total",
            "Fact tombstones that matched no live fact (surfaced, not silently dropped)",
            labelnames,
        ),
    )

    return MemoryTelemetry(tracer=tracer, metrics=metrics)
