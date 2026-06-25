"""Developer-facing retrieval SDK over Valkey Search.

Async Python port of the TypeScript ``@betterdb/retrieval`` package: index
lifecycle, upsert, and vector + filtered query backed by Valkey Search (FT.*).
"""

from __future__ import annotations

from .discovery import (
    REGISTRY_KEY,
    RETRIEVAL_CACHE_TYPE,
    RetrievalMarker,
    build_retrieval_marker,
)
from .fields import SCORE_FIELD, TEXT_FIELD
from .ft_create import (
    build_ft_create_args,
    index_name,
    key_prefix,
    resolve_vector_field_name,
)
from .ft_search import QueryFilter, build_ft_search_query
from .health import IndexHealthSnapshot, RecallEstimator, parse_percent_indexed
from .prometheus_metrics import (
    PrometheusRetrievalMetrics,
    create_prometheus_metrics,
)
from .retriever import (
    EmbedFn,
    IndexDescription,
    QueryHit,
    RerankFn,
    Retriever,
    RetrieverClient,
    UpsertEntry,
)
from .schema import (
    FieldSpec,
    FtCapabilities,
    RetrievalSchema,
    VectorAlgorithm,
    VectorMetric,
    VectorSpec,
)
from .telemetry import (
    RetrievalMetrics,
    RetrievalOperation,
    RetrievalSpan,
    RetrievalTracer,
)

__all__ = [
    # schema
    "FieldSpec",
    "VectorMetric",
    "VectorAlgorithm",
    "VectorSpec",
    "RetrievalSchema",
    "FtCapabilities",
    # ft-create
    "build_ft_create_args",
    "index_name",
    "key_prefix",
    "resolve_vector_field_name",
    # fields
    "TEXT_FIELD",
    "SCORE_FIELD",
    # ft-search
    "build_ft_search_query",
    "QueryFilter",
    # retriever
    "Retriever",
    "RetrieverClient",
    "IndexDescription",
    "EmbedFn",
    "UpsertEntry",
    "RerankFn",
    "QueryHit",
    # discovery
    "build_retrieval_marker",
    "REGISTRY_KEY",
    "RETRIEVAL_CACHE_TYPE",
    "RetrievalMarker",
    # health
    "parse_percent_indexed",
    "IndexHealthSnapshot",
    "RecallEstimator",
    # telemetry
    "RetrievalMetrics",
    "RetrievalTracer",
    "RetrievalSpan",
    "RetrievalOperation",
    # prometheus
    "create_prometheus_metrics",
    "PrometheusRetrievalMetrics",
]
