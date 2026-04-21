from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from opentelemetry import trace
from opentelemetry.trace import Tracer
from prometheus_client import REGISTRY as _DEFAULT_REGISTRY
from prometheus_client import CollectorRegistry, Counter, Gauge, Histogram

_OPERATION_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0]

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
            _metric_cache[key] = Counter(
                name, documentation, labelnames, registry=registry
            )
        except ValueError:
            existing = registry._names_to_collectors.get(name)
            if existing is None:
                raise
            _metric_cache[key] = existing
    return _metric_cache[key]  # type: ignore[return-value]


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
    return _metric_cache[key]  # type: ignore[return-value]


def _get_or_create_gauge(
    registry: CollectorRegistry,
    name: str,
    documentation: str,
    labelnames: list[str],
) -> Gauge:
    key = (id(registry), name)
    if key not in _metric_cache:
        try:
            _metric_cache[key] = Gauge(
                name, documentation, labelnames, registry=registry
            )
        except ValueError:
            existing = registry._names_to_collectors.get(name)
            if existing is None:
                raise
            _metric_cache[key] = existing
    return _metric_cache[key]  # type: ignore[return-value]


@dataclass
class AgentCacheMetrics:
    requests_total: Counter
    operation_duration: Histogram
    cost_saved: Counter
    stored_bytes: Counter
    active_sessions: Gauge


@dataclass
class Telemetry:
    tracer: Tracer
    metrics: AgentCacheMetrics


def create_telemetry(
    prefix: str,
    tracer_name: str,
    registry: CollectorRegistry | None = None,
) -> Telemetry:
    reg = registry or _DEFAULT_REGISTRY
    tracer = trace.get_tracer(tracer_name)

    metrics = AgentCacheMetrics(
        requests_total=_get_or_create_counter(
            reg,
            f"{prefix}_requests_total",
            "Total agent cache requests",
            ["cache_name", "tier", "result", "tool_name"],
        ),
        operation_duration=_get_or_create_histogram(
            reg,
            f"{prefix}_operation_duration_seconds",
            "Duration of agent cache operations in seconds",
            ["cache_name", "tier", "operation"],
            _OPERATION_BUCKETS,
        ),
        cost_saved=_get_or_create_counter(
            reg,
            f"{prefix}_cost_saved_total",
            "Estimated cost saved in dollars from cache hits",
            ["cache_name", "tier", "model", "tool_name"],
        ),
        stored_bytes=_get_or_create_counter(
            reg,
            f"{prefix}_stored_bytes_total",
            "Total bytes stored in cache",
            ["cache_name", "tier"],
        ),
        active_sessions=_get_or_create_gauge(
            reg,
            f"{prefix}_active_sessions",
            "Approximate number of active session threads",
            ["cache_name"],
        ),
    )

    return Telemetry(tracer=tracer, metrics=metrics)
