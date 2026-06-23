from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Optional, Protocol, runtime_checkable

from betterdb_valkey_search_kit import (
    FtSearchHit,
    encode_float32,
    is_index_not_found_error,
    parse_dimension_from_info,
    parse_ft_info_stats,
    parse_ft_search_response,
)

from .discovery import (
    RETRIEVAL_CACHE_TYPE,
    RETRIEVAL_VERSION,
    REGISTRY_KEY,
    build_retrieval_marker,
)
from .fields import RESERVED_FIELD_NAMES, SCORE_FIELD, TEXT_FIELD
from .ft_create import (
    build_ft_create_args,
    index_name,
    key_prefix,
    resolve_vector_field_name,
)
from .ft_search import QueryFilter, build_ft_search_query
from .health import IndexHealthSnapshot, RecallEstimator, parse_percent_indexed
from .schema import FtCapabilities, RetrievalSchema
from .telemetry import RetrievalMetrics, RetrievalOperation, RetrievalTracer

_logger = logging.getLogger(__name__)

EmbedFn = Callable[[str], Awaitable[list[float]]]


@dataclass
class QueryHit:
    id: str
    # Raw KNN ``__score`` from valkey-search: a vector **distance**, not a
    # similarity. Lower means closer (a perfect match approaches 0), so rank
    # ascending. Do not assume higher is better.
    score: float
    text: str
    fields: dict[str, str]


RerankFn = Callable[[str, list[QueryHit]], Awaitable[list[QueryHit]]]


@dataclass
class IndexDescription:
    name: str
    dims: int
    num_docs: int
    indexing_state: str


@dataclass
class UpsertEntry:
    id: str
    text: str
    fields: dict[str, "str | int | float"] = field(default_factory=dict)


@runtime_checkable
class RetrieverClient(Protocol):
    """A minimal async Valkey client surface (valkey-py is a drop-in)."""

    async def execute_command(self, *args: Any) -> Any: ...


def _is_positive_int(value: object) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return value > 0
    if isinstance(value, float):
        return value.is_integer() and value > 0
    return False


class Retriever:
    def __init__(
        self,
        client: RetrieverClient,
        name: str,
        schema: RetrievalSchema,
        *,
        capabilities: FtCapabilities | None = None,
        embed_fn: EmbedFn | None = None,
        rerank_fn: RerankFn | None = None,
        recall_estimator: RecallEstimator | None = None,
        metrics: RetrievalMetrics | None = None,
        tracer: RetrievalTracer | None = None,
    ) -> None:
        self._client = client
        self._name = name
        self._schema = schema
        self._capabilities = capabilities
        self._embed_fn = embed_fn
        self._rerank_fn = rerank_fn
        self._recall_estimator = recall_estimator
        self._metrics = metrics
        self._tracer = tracer
        self._resolved_dims: Optional[int] = None

    async def _instrument(
        self, operation: RetrievalOperation, fn: Callable[[], Awaitable[Any]]
    ) -> Any:
        span = self._tracer.start_span(f"retrieval.{operation}") if self._tracer else None
        start = time.perf_counter()
        try:
            return await fn()
        finally:
            if self._metrics is not None:
                self._metrics.observe_operation(operation, time.perf_counter() - start)
            if span is not None:
                span.end()

    async def _resolve_dims(self) -> int:
        declared = self._schema["vector"].get("dims")
        if declared is not None:
            if not _is_positive_int(declared):
                raise ValueError(f"schema.vector.dims must be a positive integer, got: {declared}")
            return int(declared)
        if self._resolved_dims is not None:
            return self._resolved_dims
        if self._embed_fn is None:
            raise ValueError(
                "Cannot resolve vector dimension: provide schema.vector.dims or an embedFn"
            )
        probe = await self._embed_fn("probe")
        if self._metrics is not None:
            self._metrics.record_embedding_call()
        if len(probe) == 0:
            raise ValueError(
                "Cannot resolve vector dimension: embedFn returned a zero-length probe embedding"
            )
        self._resolved_dims = len(probe)
        return self._resolved_dims

    async def create_index(self) -> None:
        try:
            await self._client.execute_command("FT.INFO", index_name(self._name))
            return
        except Exception as err:
            if not is_index_not_found_error(err):
                raise
        dims = await self._resolve_dims()
        schema: RetrievalSchema = {
            "fields": self._schema["fields"],
            "vector": {**self._schema["vector"], "dims": dims},
        }
        await self._client.execute_command(
            "FT.CREATE", *build_ft_create_args(self._name, schema, self._capabilities)
        )

    def _assert_no_reserved_fields(self, entry: UpsertEntry, vector_field: str) -> None:
        for field_name in entry.fields:
            if field_name in RESERVED_FIELD_NAMES or field_name == vector_field:
                raise ValueError(
                    f"Entry '{entry.id}' uses reserved field name '{field_name}'; "
                    "choose a different field name"
                )

    async def _embed(self, text: str) -> list[float]:
        if self._embed_fn is None:
            raise ValueError("Cannot embed text: provide an embedFn")
        dims = await self._resolve_dims()
        vector = await self._embed_fn(text)
        if self._metrics is not None:
            self._metrics.record_embedding_call()
        if len(vector) != dims:
            raise ValueError(
                f"Embedding dimension mismatch: index expects {dims}, embedFn returned {len(vector)}"
            )
        return vector

    async def upsert(self, entries: list[UpsertEntry]) -> None:
        await self._instrument("upsert", lambda: self._upsert_entries(entries))

    async def _upsert_entries(self, entries: list[UpsertEntry]) -> None:
        vector_field = resolve_vector_field_name(self._schema["vector"])
        writes: list[tuple[str, list[Any]]] = []
        for entry in entries:
            self._assert_no_reserved_fields(entry, vector_field)
            vector = await self._embed(entry.text)
            args: list[Any] = []
            for field_name, value in entry.fields.items():
                args.extend([field_name, str(value)])
            args.extend([vector_field, encode_float32(vector)])
            args.extend([TEXT_FIELD, entry.text])
            writes.append((f"{key_prefix(self._name)}{entry.id}", args))
        for key, args in writes:
            await self._client.execute_command("HSET", key, *args)

    async def delete(self, ids: list[str]) -> None:
        if len(ids) == 0:
            return
        keys = [f"{key_prefix(self._name)}{entry_id}" for entry_id in ids]
        await self._client.execute_command("DEL", *keys)

    async def drop_index(self) -> None:
        try:
            await self._client.execute_command("FT.DROPINDEX", index_name(self._name))
        except Exception as err:
            if not is_index_not_found_error(err):
                raise

    async def describe_index(self) -> IndexDescription:
        info = await self._client.execute_command("FT.INFO", index_name(self._name))
        stats = parse_ft_info_stats(info)
        return IndexDescription(
            name=self._name,
            dims=parse_dimension_from_info(info),
            num_docs=stats.num_docs,
            indexing_state=stats.indexing_state,
        )

    def _known_dims(self) -> Optional[int]:
        declared = self._schema["vector"].get("dims")
        if declared is not None and _is_positive_int(declared):
            return int(declared)
        return self._resolved_dims

    async def _query_vector_dims(self) -> Optional[int]:
        known = self._known_dims()
        if known is not None:
            return known
        if self._embed_fn is None:
            return None
        return await self._resolve_dims()

    async def _resolve_query_vector(
        self, text: Optional[str], vector: Optional[list[float]]
    ) -> list[float]:
        if vector is not None and text is not None:
            raise ValueError("query accepts either text or a precomputed vector, not both")
        if vector is not None:
            dims = await self._query_vector_dims()
            if dims is not None and len(vector) != dims:
                raise ValueError(
                    f"Query vector dimension mismatch: index expects {dims}, got {len(vector)}"
                )
            return vector
        if text is not None:
            return await self._embed(text)
        raise ValueError("query requires either text or a precomputed vector")

    def _map_hit(self, hit: FtSearchHit) -> QueryHit:
        prefix = key_prefix(self._name)
        entry_id = hit["key"]
        if entry_id.startswith(prefix):
            entry_id = entry_id[len(prefix) :]
        vector_field = resolve_vector_field_name(self._schema["vector"])
        fields: dict[str, str] = {}
        for field_name, value in hit["fields"].items():
            if field_name in (TEXT_FIELD, SCORE_FIELD, vector_field):
                continue
            fields[field_name] = value
        return QueryHit(
            id=entry_id,
            score=float(hit["fields"][SCORE_FIELD]),
            text=hit["fields"].get(TEXT_FIELD, ""),
            fields=fields,
        )

    def _resolve_rerank(
        self, hybrid: Optional[str], text: Optional[str]
    ) -> Optional[tuple[RerankFn, str]]:
        if hybrid != "rerank":
            return None
        if self._rerank_fn is None:
            raise ValueError("query(hybrid='rerank') requires a rerankFn")
        if text is None:
            raise ValueError("query(hybrid='rerank') requires text to rerank against")
        return (self._rerank_fn, text)

    async def query(
        self,
        *,
        k: int,
        text: Optional[str] = None,
        vector: Optional[list[float]] = None,
        filter: Optional[QueryFilter] = None,
        hybrid: Optional[str] = None,
    ) -> list[QueryHit]:
        if not _is_positive_int(k):
            raise ValueError(f"query k must be a positive integer, got: {k}")
        rerank = self._resolve_rerank(hybrid, text)
        return await self._instrument(
            "query", lambda: self._run_query(text, vector, k, filter, rerank)
        )

    async def _run_query(
        self,
        text: Optional[str],
        vector: Optional[list[float]],
        k: int,
        filter: Optional[QueryFilter],
        rerank: Optional[tuple[RerankFn, str]],
    ) -> list[QueryHit]:
        resolved_vector = await self._resolve_query_vector(text, vector)
        query_string = build_ft_search_query(self._schema, k, filter)
        raw = await self._client.execute_command(
            "FT.SEARCH",
            index_name(self._name),
            query_string,
            "PARAMS",
            "2",
            "vec",
            encode_float32(resolved_vector),
            "LIMIT",
            "0",
            str(k),
            "DIALECT",
            "2",
        )
        hits = [self._map_hit(hit) for hit in parse_ft_search_response(raw)]
        result = hits
        if rerank is not None:
            rerank_fn, rerank_text = rerank
            result = await rerank_fn(rerank_text, hits)
        if self._metrics is not None:
            self._metrics.record_query_results(len(result))
        return result

    async def _read_registry_marker(self) -> Optional[dict[str, Any]]:
        raw = await self._client.execute_command("HGET", REGISTRY_KEY, self._name)
        if raw is None:
            return None
        try:
            if isinstance(raw, bytes):
                raw = raw.decode()
            parsed = json.loads(str(raw))
            return parsed if isinstance(parsed, dict) else None
        except (ValueError, TypeError):
            return None

    async def register(self) -> None:
        # The registry field is keyed by name and shared with agent-cache, so
        # guard against clobbering a marker we don't own.
        existing = await self._read_registry_marker()
        existing_type = existing.get("type") if existing else None
        if existing_type and existing_type != RETRIEVAL_CACHE_TYPE:
            _logger.warning(
                "retrieval discovery: registry field '%s' already holds a '%s' marker; "
                "skipping registration",
                self._name,
                existing_type,
            )
            return
        marker = build_retrieval_marker(
            name=self._name,
            version=RETRIEVAL_VERSION,
            started_at=datetime.now(timezone.utc).isoformat(),
        )
        await self._client.execute_command("HSET", REGISTRY_KEY, self._name, json.dumps(marker))

    async def unregister(self) -> None:
        # Only delete a marker we own — never HDEL a foreign cache type's field.
        existing = await self._read_registry_marker()
        if existing and existing.get("type") == RETRIEVAL_CACHE_TYPE:
            await self._client.execute_command("HDEL", REGISTRY_KEY, self._name)

    async def health(self) -> IndexHealthSnapshot:
        info = await self._client.execute_command("FT.INFO", index_name(self._name))
        stats = parse_ft_info_stats(info)
        snapshot = IndexHealthSnapshot(
            name=self._name,
            num_docs=stats.num_docs,
            indexing_state=stats.indexing_state,
            dims=parse_dimension_from_info(info),
            percent_indexed=parse_percent_indexed(info),
            estimated_recall=None,
        )
        if self._recall_estimator is not None:
            snapshot.estimated_recall = self._recall_estimator(snapshot)
        return snapshot
