from betterdb_semantic_cache.types import TelemetryOptions


def test_default_tracer_scope_is_kept_by_monitor_ingest() -> None:
    # apps/api/src/ai-observability/otel-ingest.service.ts keeps only spans whose
    # instrumentation scope starts with "@betterdb/" (plus root spans).
    assert TelemetryOptions().tracer_name.startswith("@betterdb/")


def test_default_tracer_matches_typescript_package() -> None:
    # packages/semantic-cache/src/SemanticCache.ts defaults to the same scope.
    assert TelemetryOptions().tracer_name == "@betterdb/semantic-cache"
