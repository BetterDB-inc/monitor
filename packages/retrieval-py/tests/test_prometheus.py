from __future__ import annotations

from prometheus_client import CollectorRegistry

from betterdb_retrieval import create_prometheus_metrics


def test_records_operations_query_results_and_embedding_calls() -> None:
    registry = CollectorRegistry()
    metrics = create_prometheus_metrics(registry)

    metrics.observe_operation("query", 0.02)
    metrics.record_query_results(3)
    metrics.record_embedding_call()
    metrics.record_embedding_call()

    assert registry.get_sample_value("retrieval_embedding_calls_total") == 2
    assert (
        registry.get_sample_value(
            "retrieval_operation_duration_seconds_count", {"operation": "query"}
        )
        == 1
    )
    assert registry.get_sample_value("retrieval_query_results_count") == 1


def test_honors_custom_prefix() -> None:
    registry = CollectorRegistry()
    create_prometheus_metrics(registry, prefix="docs_idx")

    assert (
        registry.get_sample_value(
            "docs_idx_operation_duration_seconds_count", {"operation": "query"}
        )
        is None
    )
    # The histogram is registered even before any observation.
    names = {m.name for m in registry.collect()}
    assert "docs_idx_operation_duration_seconds" in names


def test_safe_to_construct_twice_against_same_registry() -> None:
    registry = CollectorRegistry()
    create_prometheus_metrics(registry)
    second = create_prometheus_metrics(registry)

    second.record_embedding_call()

    assert registry.get_sample_value("retrieval_embedding_calls_total") == 1
