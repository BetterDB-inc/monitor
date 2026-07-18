from __future__ import annotations

import asyncio
import atexit
import math
import time
import uuid
import warnings
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any, Literal

from betterdb_valkey_search_kit import (
    encode_float32,
    is_index_not_found_error,
    parse_ft_info_stats,
    parse_ft_search_response,
)
from opentelemetry.trace import Span, Status, StatusCode

from ._num import js_number
from .analytics import NOOP_ANALYTICS, Analytics, create_analytics
from .build_memory_index import build_memory_index_args, memory_index_name
from .build_memory_record import build_memory_record
from .build_recall_query import (
    MATCH_ALL_MEMORY_QUERY,
    SCORE_FIELD,
    ConsolidateFilterOptions,
    build_consolidate_filter,
    build_recall_query,
    build_scope_filter,
)
from .composite_score import composite_score, similarity_from_distance
from .discovery import MemoryDiscovery
from .parse_memory_item import parse_memory_item
from .reconcile_facts import (
    UnmatchedTombstoneOp,
    apply_ops,
    fact_content,
    reconcile,
    stored_fact_to_fact,
    subject_key,
)
from .select_evictions import EvictionCandidate, SelectEvictionsOptions, select_evictions
from .telemetry import MemoryTelemetryOptions, create_memory_telemetry
from .types import (
    ConsolidateFactsResult,
    ConsolidateResult,
    ConsolidationConfig,
    EmbedFn,
    FactExtractor,
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

# Cosine-distance ceiling for recall (lower = closer). Sized so mainstream
# embedding models -- whose correct matches can land near ~0.3 -- aren't silently
# filtered out; a tighter gate is available per call or via config.
DEFAULT_THRESHOLD = 0.33
# When recall returns nothing but the nearest candidate's distance was within this
# multiple of the threshold, it's flagged as a near-miss (the threshold, not the
# data, likely dropped a good hit).
RECALL_NEAR_MISS_FACTOR = 2
DEFAULT_WEIGHTS = RecallWeights(similarity=0.6, recency=0.25, importance=0.15)
DEFAULT_HALF_LIFE_SECONDS = 604800  # 7 days
DEFAULT_RECALL_K = 8
RECALL_OVERFETCH = 4
FORGET_BATCH_SIZE = 500
FORGET_MAX_BATCHES = 10000
EVICTION_SCAN_LIMIT = 10000
CONSOLIDATE_SCAN_LIMIT = 10000
DEFAULT_SUMMARY_IMPORTANCE = 0.7
SUMMARY_SOURCE = "summary"
FACT_SOURCE = "fact"
DEFAULT_FACT_IMPORTANCE = 0.7
DEFAULT_IMPORTANCE = 0.5
DEFAULT_CONFIG_REFRESH_MS = 30000
MIN_CONFIG_REFRESH_MS = 1000
MAX_DISTANCE = 2
DEFAULT_LIST_LIMIT = 20


def _package_version() -> str:
    try:
        from importlib.metadata import version

        return version("betterdb-agent-memory")
    except Exception:
        return "0.0.0"


def _resolve_consolidation(
    config: bool | ConsolidationConfig | None,
) -> tuple[str, float]:
    # Fact consolidation is always available (the old enable-gate was dropped); this
    # only resolves the customizable fact source tag and default fact importance.
    obj = config if isinstance(config, ConsolidationConfig) else None
    fact_source = (
        obj.fact_source if obj is not None and obj.fact_source is not None else FACT_SOURCE
    )
    fact_importance = (
        obj.fact_importance
        if obj is not None and obj.fact_importance is not None
        else DEFAULT_FACT_IMPORTANCE
    )
    return fact_source, fact_importance


def _copy_weights(weights: RecallWeights) -> RecallWeights:
    return RecallWeights(
        similarity=weights.similarity,
        recency=weights.recency,
        importance=weights.importance,
    )


def _ft_search_total(raw: Any) -> int:
    if not isinstance(raw, (list, tuple)) or len(raw) < 1:
        return 0
    total = js_number(raw[0])
    if math.isfinite(total) and total > 0:
        return int(total)
    return 0


def _parse_hash_reply(raw: Any) -> dict[str, str]:
    out: dict[str, str] = {}
    if isinstance(raw, (list, tuple)):
        i = 0
        while i + 1 < len(raw):
            out[_to_text(raw[i])] = _to_text(raw[i + 1])
            i += 2
    elif isinstance(raw, dict):
        for field, value in raw.items():
            out[_to_text(field)] = _to_text(value)
    return out


def _to_text(value: Any) -> str:
    if isinstance(value, bytes):
        return value.decode()
    return str(value)


class MemoryStore:
    """Long-term memory tier: vector recall, reinforcement, capacity, consolidation."""

    def __init__(
        self,
        *,
        client: MemoryStoreClient,
        name: str,
        embed_fn: EmbedFn | None = None,
        default_threshold: float | None = None,
        weights: RecallWeights | None = None,
        half_life_seconds: float | None = None,
        max_items_per_scope: int | None = None,
        discovery: bool | MemoryDiscoveryConfig = False,
        config_refresh: bool | MemoryConfigRefreshConfig | None = None,
        consolidation: bool | ConsolidationConfig | None = None,
        telemetry: MemoryTelemetryOptions | None = None,
        analytics: bool = True,
    ) -> None:
        self._client = client
        self._name = name
        self._embed_fn = embed_fn
        (
            self._fact_source,
            self._default_fact_importance,
        ) = _resolve_consolidation(consolidation)
        # Fire the recall near-miss warning at most once per store instance.
        self._near_miss_warned = False
        self._analytics_disabled = not analytics
        self._analytics: Analytics = NOOP_ANALYTICS
        self._analytics_started = False
        # In-process aggregate usage counters emitted as a single low-volume
        # `memory_session` event at exit. Content is never captured — only
        # integer counts — so this stays privacy-safe. The session event and
        # analytics flush are wired to atexit in _ensure_analytics_started so
        # short-lived consumers that never call close() still report usage.
        self._session_counts = {
            "remembered": 0,
            "recalled": 0,
            "recall_hits": 0,
            "forgotten": 0,
            "consolidated": 0,
            "evicted": 0,
        }
        self._session_flushed = False
        self._session_atexit_registered = False
        self._telemetry = create_memory_telemetry(telemetry)
        self._store_labels = {"store_name": name}
        self._initial_threshold = (
            default_threshold if default_threshold is not None else DEFAULT_THRESHOLD
        )
        self._initial_weights = _copy_weights(weights if weights is not None else DEFAULT_WEIGHTS)
        self._initial_half_life_seconds = (
            half_life_seconds if half_life_seconds is not None else DEFAULT_HALF_LIFE_SECONDS
        )
        self._initial_max_items_per_scope = max_items_per_scope
        self._default_threshold = self._initial_threshold
        self._weights = _copy_weights(self._initial_weights)
        self._half_life_seconds = self._initial_half_life_seconds
        self._max_items_per_scope = self._initial_max_items_per_scope
        self._config_key = f"{name}:__mem_config"
        self._dims: int | None = None

        self._discovery = self._create_discovery(discovery)
        self._discovery_task: asyncio.Task[None] | None = None
        if self._discovery is not None:
            self._schedule_discovery()

        self._config_refresh_task: asyncio.Task[None] | None = None
        self._config_refresh_interval_s = DEFAULT_CONFIG_REFRESH_MS / 1000
        self._config_refresh_enabled = self._resolve_config_refresh(config_refresh)
        self._schedule_config_refresh()

    # -- config -----------------------------------------------------------

    def current_config(self) -> MemoryConfigSnapshot:
        return MemoryConfigSnapshot(
            threshold=self._default_threshold,
            weights=_copy_weights(self._weights),
            half_life_seconds=self._half_life_seconds,
            max_items_per_scope=self._max_items_per_scope,
        )

    # -- read methods -----------------------------------------------------

    async def get(self, id: str) -> MemoryItem | None:
        await self._ensure_analytics_started()
        key = f"{self._name}:mem:{id}"
        fields = _parse_hash_reply(await self._client.execute_command("HGETALL", key))
        if len(fields) == 0:
            return None
        return parse_memory_item(self._name, {"key": key, "fields": fields})

    async def list(self, options: MemoryListOptions | None = None) -> MemoryListResult:
        await self._ensure_analytics_started()
        opts = options if options is not None else MemoryListOptions()
        tags = opts.tags if opts.tags is not None else []
        scope = MemoryScope(
            thread_id=opts.thread_id,
            agent_id=opts.agent_id,
            namespace=opts.namespace,
        )
        limit = opts.limit if opts.limit is not None else DEFAULT_LIST_LIMIT
        offset = opts.offset if opts.offset is not None else 0
        raw = await self._client.execute_command(
            "FT.SEARCH",
            f"{self._name}:mem:idx",
            build_scope_filter(scope, tags),
            "RETURN",
            "10",
            "content",
            "importance",
            "tags",
            "created_at",
            "last_accessed_at",
            "access_count",
            "source",
            "threadId",
            "agentId",
            "namespace",
            "SORTBY",
            "created_at",
            "DESC",
            "LIMIT",
            str(offset),
            str(limit),
            "DIALECT",
            "2",
        )
        total = _ft_search_total(raw)
        items = [parse_memory_item(self._name, hit) for hit in parse_ft_search_response(raw)]
        return MemoryListResult(items=items, total=total)

    async def stats(self) -> MemoryStats:
        await self._ensure_analytics_started()
        info_raw = await self._client.execute_command("FT.INFO", memory_index_name(self._name))
        index_stats = parse_ft_info_stats(info_raw)
        stats_fields = _parse_hash_reply(
            await self._client.execute_command("HGETALL", f"{self._name}:__mem_stats")
        )
        evictions = js_number(stats_fields.get("evictions", "0"))
        return MemoryStats(
            item_count=index_stats.num_docs,
            evictions=int(evictions) if math.isfinite(evictions) else 0,
            config=self.current_config(),
        )

    async def refresh_config(self) -> None:
        try:
            raw = await self._client.execute_command("HGETALL", self._config_key)
            self._apply_config(_parse_hash_reply(raw))
        except Exception:
            # Best-effort: a failed refresh keeps the last-known config in place.
            pass

    def _resolve_config_refresh(self, config: bool | MemoryConfigRefreshConfig | None) -> bool:
        if not config:
            return False
        settings = MemoryConfigRefreshConfig() if config is True else config
        if settings.enabled is False:
            return False
        interval_ms = settings.interval_ms
        if interval_ms is None:
            interval_ms = DEFAULT_CONFIG_REFRESH_MS
        interval_ms = max(MIN_CONFIG_REFRESH_MS, interval_ms)
        self._config_refresh_interval_s = interval_ms / 1000
        return True

    def _schedule_config_refresh(self) -> None:
        # Mirror of _schedule_discovery: creating the polling task needs a running
        # event loop, which the typical sync constructor (before AgentMemory.initialize)
        # does not have. When there is no loop yet, defer until
        # ensure_config_refresh_started() runs under one. Idempotent.
        if not self._config_refresh_enabled or self._config_refresh_task is not None:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._config_refresh_task = loop.create_task(self._config_refresh_loop())

    async def ensure_config_refresh_started(self) -> None:
        # Re-attempt the deferred start once a running loop exists. TS starts the
        # refresh via setInterval in the constructor (no running-loop precondition);
        # asyncio needs this retry to reach parity. No-op when disabled or already
        # running. AgentMemory.initialize() drives this for the common sync-ctor path.
        self._schedule_config_refresh()

    async def _config_refresh_loop(self) -> None:
        try:
            await self.refresh_config()
            while True:
                await asyncio.sleep(self._config_refresh_interval_s)
                await self.refresh_config()
        except asyncio.CancelledError:
            pass

    def _apply_config(self, raw: dict[str, str]) -> None:
        threshold = self._initial_threshold
        # Weights are a partial update: if any component is in the config, start
        # from the LIVE weights and overlay only what's present, so tuning one
        # knob doesn't reset the others. With no weight field, fall back to the
        # constructor values like the rest.
        weight_field_present = any(
            field in raw
            for field in (
                "recall.weights.similarity",
                "recall.weights.recency",
                "recall.weights.importance",
            )
        )
        weights = _copy_weights(self._weights if weight_field_present else self._initial_weights)
        half_life_seconds = self._initial_half_life_seconds
        max_items_per_scope = self._initial_max_items_per_scope

        for field, value in raw.items():
            num = js_number(value)
            if not math.isfinite(num):
                continue
            if field == "recall.threshold":
                if 0 <= num <= MAX_DISTANCE:
                    threshold = num
            elif field == "recall.weights.similarity":
                if num >= 0:
                    weights.similarity = num
            elif field == "recall.weights.recency":
                if num >= 0:
                    weights.recency = num
            elif field == "recall.weights.importance":
                if num >= 0:
                    weights.importance = num
            elif field == "recall.halfLifeSeconds":
                if num > 0:
                    half_life_seconds = num
            elif field == "maxItemsPerScope":
                if num >= 1:
                    max_items_per_scope = math.floor(num)

        self._default_threshold = threshold
        # An all-zero weight vector would make every composite score 0 and leave
        # recall ordering undefined, so reject it and keep the configured weights.
        weight_sum = weights.similarity + weights.recency + weights.importance
        self._weights = weights if weight_sum > 0 else _copy_weights(self._initial_weights)
        self._half_life_seconds = half_life_seconds
        self._max_items_per_scope = max_items_per_scope

    # -- discovery --------------------------------------------------------

    def _create_discovery(self, config: bool | MemoryDiscoveryConfig) -> MemoryDiscovery | None:
        if not config:
            return None
        settings = MemoryDiscoveryConfig() if config is True else config
        heartbeat_s: float | None = None
        if settings.heartbeat_interval_ms is not None:
            heartbeat_s = settings.heartbeat_interval_ms / 1000
        return MemoryDiscovery(
            client=self._client,
            name=self._name,
            version=settings.version or _package_version(),
            stats_key=f"{self._name}:__mem_stats",
            heartbeat_interval_s=heartbeat_s,
        )

    def _schedule_discovery(self) -> None:
        if self._discovery is None or self._discovery_task is not None:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._discovery_task = loop.create_task(self._run_discovery())

    async def _run_discovery(self) -> None:
        # Registration is best-effort; a failed register must not surface as an
        # unhandled task exception. close() still tears the marker down.
        try:
            assert self._discovery is not None
            await self._discovery.register()
        except Exception:
            pass

    async def ensure_discovery_ready(self) -> None:
        if self._discovery is None:
            return
        self._schedule_discovery()
        if self._discovery_task is not None:
            await self._discovery_task

    async def _ensure_analytics_started(self) -> None:
        # Fire-once, fire-and-forget: product analytics has no running event loop
        # in __init__, so defer initialization until the first async lifecycle call.
        if self._analytics_started:
            return
        self._analytics_started = True
        try:
            analytics = await create_analytics(disabled=self._analytics_disabled)
            self._analytics = analytics
            await analytics.init(
                self._client,
                self._name,
                {
                    "hasEmbedFn": self._embed_fn is not None,
                    "maxItemsPerScope": self._max_items_per_scope,
                    "discovery": self._discovery is not None,
                },
            )
            if not self._session_atexit_registered:
                atexit.register(self._session_atexit)
                self._session_atexit_registered = True
        except Exception:
            # never let analytics break the memory store
            self._analytics = NOOP_ANALYTICS

    def _capture_session(self) -> None:
        # Emit the aggregate usage summary exactly once, only if there was
        # activity worth reporting. Safe to call from both close() and atexit.
        if self._session_flushed:
            return
        if not any(self._session_counts.values()):
            # Nothing worth reporting yet — leave the one-shot armed so a later
            # close() (after real activity) can still emit the summary.
            return
        self._session_flushed = True
        self._analytics.capture("memory_session", dict(self._session_counts))

    def _session_atexit(self) -> None:
        # Backstop for consumers that never call close(): summarize the session
        # and drain the analytics queue before the interpreter exits.
        self._capture_session()
        self._analytics.flush()

    async def close(self) -> None:
        if self._config_refresh_task is not None:
            self._config_refresh_task.cancel()
            try:
                await self._config_refresh_task
            except asyncio.CancelledError:
                pass
            self._config_refresh_task = None
        if self._discovery is not None:
            self._schedule_discovery()
            if self._discovery_task is not None:
                await self._discovery_task
            await self._discovery.stop(delete_heartbeat=True)
        self._capture_session()
        # Drain the queue before shutdown so the session summary lands even if
        # shutdown()'s posthog close swallows an error, matching the atexit path.
        self._analytics.flush()
        try:
            atexit.unregister(self._session_atexit)
        except Exception:
            pass
        await self._analytics.shutdown()

    # -- index ------------------------------------------------------------

    async def ensure_index(self) -> None:
        """Create the ``{name}:mem:idx`` vector index if it does not already exist.

        Idempotent — an existing index is left untouched. Resolves the vector
        dimension from ``embed_fn`` when it has not been observed yet.
        """
        await self._ensure_analytics_started()
        try:
            await self._client.execute_command("FT.INFO", memory_index_name(self._name))
            return
        except Exception as err:
            if not is_index_not_found_error(err):
                raise
        dims = await self._resolve_dims()
        await self._client.execute_command("FT.CREATE", *build_memory_index_args(self._name, dims))
        self._analytics.capture("index_created", {"dims": dims})

    # -- recall -----------------------------------------------------------

    async def recall(
        self,
        query: str,
        *,
        k: int | None = None,
        threshold: float | None = None,
        tags: list[str] | None = None,
        weights: RecallWeights | None = None,
        reinforce: bool | None = None,
        thread_id: str | None = None,
        agent_id: str | None = None,
        namespace: str | None = None,
    ) -> list[MemoryHit]:
        await self._ensure_analytics_started()
        with self._span("recall") as span:
            started_at = time.monotonic()
            vector = await self._embed(query)
            return await self._run_recall(
                vector,
                span=span,
                started_at=started_at,
                k=k,
                threshold=threshold,
                tags=tags,
                weights=weights,
                reinforce=reinforce,
                thread_id=thread_id,
                agent_id=agent_id,
                namespace=namespace,
            )

    async def recall_by_vector(
        self,
        vector: list[float],
        *,
        k: int | None = None,
        threshold: float | None = None,
        tags: list[str] | None = None,
        weights: RecallWeights | None = None,
        reinforce: bool | None = None,
        thread_id: str | None = None,
        agent_id: str | None = None,
        namespace: str | None = None,
    ) -> list[MemoryHit]:
        await self._ensure_analytics_started()
        with self._span("recall") as span:
            return await self._run_recall(
                vector,
                span=span,
                started_at=time.monotonic(),
                k=k,
                threshold=threshold,
                tags=tags,
                weights=weights,
                reinforce=reinforce,
                thread_id=thread_id,
                agent_id=agent_id,
                namespace=namespace,
            )

    async def _run_recall(
        self,
        vector: list[float],
        *,
        span: Span,
        started_at: float,
        k: int | None,
        threshold: float | None,
        tags: list[str] | None,
        weights: RecallWeights | None,
        reinforce: bool | None,
        thread_id: str | None,
        agent_id: str | None,
        namespace: str | None,
    ) -> list[MemoryHit]:
        k_value = k if k is not None else DEFAULT_RECALL_K
        threshold_value = threshold if threshold is not None else self._default_threshold
        weights_value = weights if weights is not None else self._weights
        # Snapshot the half-life alongside threshold/weights so a concurrent
        # configRefresh can't score one recall with a mix of config versions.
        half_life_seconds = self._half_life_seconds
        fetch_k = k_value * RECALL_OVERFETCH
        tag_list = tags if tags is not None else []
        scope = MemoryScope(thread_id=thread_id, agent_id=agent_id, namespace=namespace)
        span.set_attribute("recall.k", k_value)

        query_string = build_recall_query(fetch_k, scope, tag_list)
        raw = await self._client.execute_command(
            "FT.SEARCH",
            f"{self._name}:mem:idx",
            query_string,
            "PARAMS",
            "2",
            "vec",
            encode_float32(vector),
            "LIMIT",
            "0",
            str(fetch_k),
            "DIALECT",
            "2",
        )

        now = self._now_ms()
        hits: list[MemoryHit] = []
        # Track the closest candidate seen regardless of the threshold, so a recall
        # that returns nothing can tell whether a good hit was dropped just outside.
        nearest_distance = math.inf
        for hit in parse_ft_search_response(raw):
            raw_score = hit["fields"].get(SCORE_FIELD)
            if raw_score is None or raw_score.strip() == "":
                continue
            distance = js_number(raw_score)
            if not math.isfinite(distance):
                continue
            if distance < nearest_distance:
                nearest_distance = distance
            if distance > threshold_value:
                continue
            item = parse_memory_item(self._name, hit)
            # Recency decays from the last access, not creation, so
            # reinforcement (which bumps last_accessed_at) makes a memory
            # more recallable. max() guards a clock-skewed last_accessed_at.
            last_touched = max(item.created_at, item.last_accessed_at)
            age_seconds = (now - last_touched) / 1000
            score = composite_score(
                similarity=similarity_from_distance(distance),
                age_seconds=age_seconds,
                importance=item.importance,
                weights=weights_value,
                half_life_seconds=half_life_seconds,
            )
            if not math.isfinite(score):
                continue
            hits.append(MemoryHit(item=item, similarity=distance, score=score))

        hits.sort(key=lambda h: h.score, reverse=True)
        result = hits[:k_value]
        span.set_attribute("recall.candidate_count", len(hits))
        span.set_attribute("recall.result_count", len(result))

        # Near-miss diagnostic: zero hits, but the closest candidate sat just past
        # the threshold -- the gate, not the corpus, likely dropped a relevant
        # memory. Surface it (span + metric + a one-time warn) instead of failing
        # silently.
        if (
            len(result) == 0
            and math.isfinite(nearest_distance)
            # Strictly OUTSIDE the threshold: a candidate at or within the threshold
            # was admitted by the vector gate, so an empty result there is
            # score-filtering, not a too-tight threshold -- don't advise raising it.
            and threshold_value < nearest_distance <= threshold_value * RECALL_NEAR_MISS_FACTOR
        ):
            span.set_attribute("recall.zero_hits_near_threshold", True)
            span.set_attribute("recall.nearest_distance", nearest_distance)
            self._telemetry.metrics.recall_near_miss.labels(**self._store_labels).inc()
            if not self._near_miss_warned:
                self._near_miss_warned = True
                warnings.warn(
                    f"recall on '{self._name}' returned 0 hits, but the nearest candidate was "
                    f"at cosine distance {nearest_distance:.3f} -- just past the threshold "
                    f"{threshold_value}. If your embedding model returns correct matches at "
                    f"this range, raise it via recall(threshold=...) or the store's "
                    f"default_threshold. (Warns once per store.)",
                    stacklevel=2,
                )

        self._record_recall(len(result), time.monotonic() - started_at)
        self._session_counts["recalled"] += 1
        if len(result) > 0:
            self._session_counts["recall_hits"] += 1

        if reinforce is not False:
            # Reinforcement is best-effort and must never break the read path.
            try:
                await self._reinforce(result, now)
            except Exception:
                pass
        return result

    def _record_recall(self, result_count: int, latency_seconds: float) -> None:
        metrics = self._telemetry.metrics
        metrics.recall_total.labels(**self._store_labels).inc()
        if result_count > 0:
            metrics.recall_hits.labels(**self._store_labels).inc()
        else:
            metrics.recall_empty.labels(**self._store_labels).inc()
        metrics.recall_latency.labels(**self._store_labels).observe(latency_seconds)

    async def _reinforce(self, hits: list[MemoryHit], now: int) -> None:
        for hit in hits:
            key = f"{self._name}:mem:{hit.item.id}"
            # Only touch live hashes: a recalled key may already be deleted (stale
            # index) and HSET/HINCRBY would otherwise resurrect a partial record.
            exists = int(await self._client.execute_command("EXISTS", key))
            if exists == 0:
                continue
            await self._client.execute_command("HSET", key, "last_accessed_at", str(now))
            await self._client.execute_command("HINCRBY", key, "access_count", "1")

    # -- forget -----------------------------------------------------------

    async def forget(self, id: str) -> bool:
        await self._ensure_analytics_started()
        removed = int(await self._client.execute_command("DEL", f"{self._name}:mem:{id}"))
        if removed > 0:
            self._telemetry.metrics.items.labels(**self._store_labels).dec(removed)
            self._session_counts["forgotten"] += removed
        return removed > 0

    async def forget_by_scope(
        self,
        *,
        thread_id: str | None = None,
        agent_id: str | None = None,
        namespace: str | None = None,
        tags: list[str] | None = None,
    ) -> int:
        await self._ensure_analytics_started()
        tag_list = tags if tags is not None else []
        has_filter = (
            thread_id is not None
            or agent_id is not None
            or namespace is not None
            or len(tag_list) > 0
        )
        if not has_filter:
            raise ValueError("forget_by_scope requires at least one scope field or tag")

        scope = MemoryScope(thread_id=thread_id, agent_id=agent_id, namespace=namespace)
        filter_query = build_scope_filter(scope, tag_list)
        deleted = 0
        batch = 0

        while batch < FORGET_MAX_BATCHES:
            raw = await self._client.execute_command(
                "FT.SEARCH",
                f"{self._name}:mem:idx",
                filter_query,
                "LIMIT",
                "0",
                str(FORGET_BATCH_SIZE),
                "DIALECT",
                "2",
            )
            keys = [hit["key"] for hit in parse_ft_search_response(raw)]
            if len(keys) == 0:
                break
            removed = int(await self._client.execute_command("DEL", *keys))
            deleted += removed
            # Stop when a batch makes no progress (every match was already gone),
            # so a lagging index that re-lists deleted keys can't loop forever.
            if removed == 0:
                break
            batch += 1

        # Reaching the batch cap with work still flowing means matches may remain;
        # surface it rather than returning a partial count that reads as complete.
        if batch == FORGET_MAX_BATCHES:
            warnings.warn(
                f"forget_by_scope hit the {FORGET_MAX_BATCHES}-batch safety cap for "
                f"'{self._name}'; {deleted} memories deleted, but some matches may "
                f"remain — re-run to continue.",
                stacklevel=2,
            )

        if deleted > 0:
            self._telemetry.metrics.items.labels(**self._store_labels).dec(deleted)
            self._session_counts["forgotten"] += deleted
        return deleted

    # -- write ------------------------------------------------------------

    async def _write_memory(
        self,
        content: str,
        *,
        importance: float | None,
        tags: list[str] | None,
        source: str | None,
        subject: str | None = None,
        date: str | None = None,
        thread_id: str | None,
        agent_id: str | None,
        namespace: str | None,
        ttl: int | None,
        now: int,
    ) -> str:
        vector = await self._embed(content)
        id = str(uuid.uuid4())
        record = build_memory_record(
            self._name,
            id,
            content,
            vector,
            importance=importance,
            tags=tags,
            source=source,
            subject=subject,
            date=date,
            thread_id=thread_id,
            agent_id=agent_id,
            namespace=namespace,
            now=now,
        )
        await self._write_record(record.key, record.fields, ttl)
        self._telemetry.metrics.items.labels(**self._store_labels).inc()
        return id

    async def remember(
        self,
        content: str,
        *,
        importance: float | None = None,
        tags: list[str] | None = None,
        source: str | None = None,
        ttl: int | None = None,
        thread_id: str | None = None,
        agent_id: str | None = None,
        namespace: str | None = None,
    ) -> str:
        await self._ensure_analytics_started()
        with self._span("remember") as span:
            span.set_attribute(
                "memory.importance",
                importance if importance is not None else DEFAULT_IMPORTANCE,
            )
            if ttl is not None:
                span.set_attribute("memory.ttl", ttl)
            now = self._now_ms()
            id = await self._write_memory(
                content,
                importance=importance,
                tags=tags,
                source=source,
                thread_id=thread_id,
                agent_id=agent_id,
                namespace=namespace,
                ttl=ttl,
                now=now,
            )
            self._session_counts["remembered"] += 1
            # Capacity enforcement is best-effort: the memory is already durably
            # stored, so a failed eviction pass must not reject the write.
            try:
                scope = MemoryScope(thread_id=thread_id, agent_id=agent_id, namespace=namespace)
                await self._enforce_capacity(scope, tags if tags is not None else [], now)
            except Exception:
                pass
            return id

    async def consolidate(
        self,
        *,
        mode: Literal["summary", "facts"],
        summarize: SummarizeFn | None = None,
        extract_facts: FactExtractor | None = None,
        older_than_seconds: float | None = None,
        max_importance: float | None = None,
        delete_sources: bool | None = None,
        summary_importance: float | None = None,
        fact_importance: float | None = None,
        tags: list[str] | None = None,
        thread_id: str | None = None,
        agent_id: str | None = None,
        namespace: str | None = None,
    ) -> ConsolidateResult | ConsolidateFactsResult:
        """Consolidate a scoped set of memories. The mode is explicit:

        - ``mode="summary"`` -- accumulation: ``summarize(items)`` folds the
          candidates into ONE new digest memory, optionally deleting the sources.
          Lossy; items arrive oldest->newest with their dates so the summarizer can
          respect recency.
        - ``mode="facts"`` -- updates: ``extract_facts(items)`` returns structured
          facts reconciled by subject (newest ``date`` wins, tombstones retract) and
          written additively (sources kept). Use it for an updating corpus so later
          statements supersede earlier ones instead of being conflated.
        """
        if mode == "facts":
            if extract_facts is None:
                raise ValueError("consolidate(mode='facts') requires extract_facts")
            return await self._consolidate_facts_impl(
                extract_facts=extract_facts,
                older_than_seconds=older_than_seconds,
                max_importance=max_importance,
                fact_importance=fact_importance,
                tags=tags,
                thread_id=thread_id,
                agent_id=agent_id,
                namespace=namespace,
            )
        if mode == "summary":
            if summarize is None:
                raise ValueError("consolidate(mode='summary') requires summarize")
            return await self._consolidate_summary(
                summarize=summarize,
                older_than_seconds=older_than_seconds,
                max_importance=max_importance,
                delete_sources=delete_sources,
                summary_importance=summary_importance,
                tags=tags,
                thread_id=thread_id,
                agent_id=agent_id,
                namespace=namespace,
            )
        raise ValueError(f"consolidate: unknown mode {mode!r} (expected 'summary' or 'facts')")

    async def consolidate_facts(
        self,
        *,
        extract_facts: FactExtractor,
        older_than_seconds: float | None = None,
        max_importance: float | None = None,
        fact_importance: float | None = None,
        tags: list[str] | None = None,
        thread_id: str | None = None,
        agent_id: str | None = None,
        namespace: str | None = None,
    ) -> ConsolidateFactsResult:
        """Deprecated: use ``consolidate(mode="facts", ...)``. Kept as a thin alias.

        .. deprecated::
            Prefer the merged ``consolidate(mode="facts", ...)``.
        """
        return await self._consolidate_facts_impl(
            extract_facts=extract_facts,
            older_than_seconds=older_than_seconds,
            max_importance=max_importance,
            fact_importance=fact_importance,
            tags=tags,
            thread_id=thread_id,
            agent_id=agent_id,
            namespace=namespace,
        )

    async def _consolidate_summary(
        self,
        *,
        summarize: SummarizeFn,
        older_than_seconds: float | None = None,
        max_importance: float | None = None,
        delete_sources: bool | None = None,
        summary_importance: float | None = None,
        tags: list[str] | None = None,
        thread_id: str | None = None,
        agent_id: str | None = None,
        namespace: str | None = None,
    ) -> ConsolidateResult:
        await self._ensure_analytics_started()
        with self._span("consolidate") as span:
            now = self._now_ms()
            tag_list = tags if tags is not None else []
            scope = MemoryScope(thread_id=thread_id, agent_id=agent_id, namespace=namespace)

            has_criteria = (
                thread_id is not None
                or agent_id is not None
                or namespace is not None
                or len(tag_list) > 0
                or older_than_seconds is not None
                or max_importance is not None
            )
            if not has_criteria:
                raise ValueError(
                    "consolidate requires a scope, tags, older_than_seconds, or "
                    "max_importance to select candidates"
                )

            # Push older_than_seconds/max_importance into the query (both NUMERIC
            # indexed) so the scan limit applies to actual matches. Prior summaries
            # are always excluded so consolidation never re-folds its own output.
            max_created_at = (
                now - int(older_than_seconds * 1000) if older_than_seconds is not None else None
            )
            filter_query = build_consolidate_filter(
                scope,
                tag_list,
                ConsolidateFilterOptions(
                    max_created_at=max_created_at,
                    max_importance=max_importance,
                    exclude_source=SUMMARY_SOURCE,
                ),
            )
            raw = await self._client.execute_command(
                "FT.SEARCH",
                f"{self._name}:mem:idx",
                filter_query,
                "RETURN",
                "11",
                "content",
                "importance",
                "tags",
                "created_at",
                "last_accessed_at",
                "access_count",
                "source",
                "threadId",
                "agentId",
                "namespace",
                # Give the summarizer each item's asserted date alongside the
                # recency order below, so a summary can't silently ignore which
                # statement is newer.
                "date",
                "LIMIT",
                "0",
                str(CONSOLIDATE_SCAN_LIMIT),
                "DIALECT",
                "2",
            )
            candidates = [
                parse_memory_item(self._name, hit) for hit in parse_ft_search_response(raw)
            ]
            # Order oldest->newest so the summarizer sees the evolution of state and
            # can respect recency; FT.SEARCH itself returns candidates unordered.
            candidates.sort(key=lambda item: item.created_at)
            span.set_attribute("consolidate.candidates", len(candidates))

            if len(candidates) == 0:
                span.set_attribute("consolidate.created", 0)
                span.set_attribute("consolidate.deleted", 0)
                return ConsolidateResult(consolidated=0, created=[], deleted=0)

            # Write the summary before deleting sources so a failure can never
            # destroy memories without leaving their consolidated replacement
            # behind. Use the capacity-free write path: consolidation is a net
            # reduction, and the sources still inflate the scope here, so an
            # enforceCapacity pass could evict the summary we just wrote.
            summary = await summarize(candidates)
            summary_id = await self._write_memory(
                summary,
                importance=(
                    summary_importance
                    if summary_importance is not None
                    else DEFAULT_SUMMARY_IMPORTANCE
                ),
                tags=tag_list,
                source=SUMMARY_SOURCE,
                thread_id=thread_id,
                agent_id=agent_id,
                namespace=namespace,
                ttl=None,
                now=now,
            )

            deleted = 0
            if delete_sources is not False:
                keys = [f"{self._name}:mem:{item.id}" for item in candidates]
                deleted = int(await self._client.execute_command("DEL", *keys))
                if deleted > 0:
                    self._telemetry.metrics.items.labels(**self._store_labels).dec(deleted)

            self._telemetry.metrics.consolidations.labels(**self._store_labels).inc()
            self._session_counts["consolidated"] += 1
            self._analytics.capture(
                "memory_consolidated",
                {"sources": len(candidates), "deleted": deleted},
            )
            span.set_attribute("consolidate.created", 1)
            span.set_attribute("consolidate.deleted", deleted)
            return ConsolidateResult(
                consolidated=len(candidates), created=[summary_id], deleted=deleted
            )

    async def _consolidate_facts_impl(
        self,
        *,
        extract_facts: FactExtractor,
        older_than_seconds: float | None = None,
        max_importance: float | None = None,
        fact_importance: float | None = None,
        tags: list[str] | None = None,
        thread_id: str | None = None,
        agent_id: str | None = None,
        namespace: str | None = None,
    ) -> ConsolidateFactsResult:
        await self._ensure_analytics_started()
        with self._span("consolidateFacts") as span:
            now = self._now_ms()
            tag_list = tags if tags is not None else []
            scope = MemoryScope(thread_id=thread_id, agent_id=agent_id, namespace=namespace)

            has_criteria = (
                thread_id is not None
                or agent_id is not None
                or namespace is not None
                or len(tag_list) > 0
                or older_than_seconds is not None
                or max_importance is not None
            )
            if not has_criteria:
                raise ValueError(
                    "consolidate_facts requires a scope, tags, older_than_seconds, or "
                    "max_importance to select source memories"
                )

            # Exclude prior fact memories so a re-run never re-distills its own output.
            max_created_at = (
                now - int(older_than_seconds * 1000) if older_than_seconds is not None else None
            )
            filter_query = build_consolidate_filter(
                scope,
                tag_list,
                ConsolidateFilterOptions(
                    max_created_at=max_created_at,
                    max_importance=max_importance,
                    exclude_source=self._fact_source,
                ),
            )
            raw = await self._client.execute_command(
                "FT.SEARCH",
                f"{self._name}:mem:idx",
                filter_query,
                "RETURN",
                "12",
                "content",
                "importance",
                "tags",
                "created_at",
                "last_accessed_at",
                "access_count",
                "source",
                "threadId",
                "agentId",
                "namespace",
                # Surface the reconcile keys to the extractor callback: ``date``
                # drives newest-wins and ``subject`` is the reconcile key.
                "subject",
                "date",
                # Deterministic oldest->newest ordering (created_at is NUMERIC
                # SORTABLE) so the extractor's rendered input is stable run-to-run;
                # FT.SEARCH is otherwise unordered.
                "SORTBY",
                "created_at",
                "ASC",
                "LIMIT",
                "0",
                str(CONSOLIDATE_SCAN_LIMIT),
                "DIALECT",
                "2",
            )
            candidates = [
                parse_memory_item(self._name, hit) for hit in parse_ft_search_response(raw)
            ]
            span.set_attribute("consolidate_facts.candidates", len(candidates))

            if len(candidates) == 0:
                span.set_attribute("consolidate_facts.facts", 0)
                span.set_attribute("consolidate_facts.created", 0)
                span.set_attribute("consolidate_facts.deleted", 0)
                return ConsolidateFactsResult(
                    candidates=0, facts=0, created=[], deleted=0, unmatched_tombstones=[]
                )

            # Load the fact memories already written for this scope so
            # reconciliation considers them (not just the current batch): a re-run
            # over the same sources is idempotent, a newer statement supersedes the
            # stored fact, and a tombstone retracts it. Only facts that carry a
            # persisted ``subject`` (the reconcile key) can participate.
            existing_facts = await self._load_existing_facts(scope, tag_list)
            existing_by_subject: dict[str, tuple[str, str]] = {}
            # Self-heal a concurrent-write race: two consolidate_facts runs that
            # each wrote a fact for the same subject leave a duplicate row. Keep
            # one canonical per subject and retract the extras on this run, so
            # tracking stays 1:1 and orphaned duplicates don't accumulate forever.
            duplicate_fact_ids: list[str] = []
            for item in existing_facts:
                if item.subject is None:
                    continue
                key = subject_key(item.subject)
                if key in existing_by_subject:
                    duplicate_fact_ids.append(item.id)
                else:
                    existing_by_subject[key] = (item.id, item.content)
            prior_facts = [
                stored_fact_to_fact(item) for item in existing_facts if item.subject is not None
            ]

            # Extract atomic facts, then reconcile against the stored facts so
            # subject collisions (within the batch AND against prior runs) resolve
            # to the newest dated statement and tombstones drop retracted subjects.
            extracted = await extract_facts(candidates)
            ops = reconcile(extracted, prior_facts)
            curated = apply_ops(prior_facts, ops)
            # A tombstone that matched no live fact is surfaced, not silently dropped.
            unmatched_tombstones = [
                op.subject for op in ops if isinstance(op, UnmatchedTombstoneOp)
            ]
            if len(unmatched_tombstones) > 0:
                self._telemetry.metrics.fact_tombstone_unmatched.labels(
                    **self._store_labels
                ).inc(len(unmatched_tombstones))
            curated_by_subject = {subject_key(fact.subject): fact for fact in curated}
            span.set_attribute("consolidate_facts.facts", len(curated))
            span.set_attribute(
                "consolidate_facts.unmatched_tombstones", len(unmatched_tombstones)
            )

            resolved_importance = (
                fact_importance if fact_importance is not None else self._default_fact_importance
            )
            # Diff the curated set against what is stored. Writing before deleting
            # keeps a crash between the two from losing a fact (recall-safe, at
            # worst a duplicate), mirroring consolidate()'s write-then-delete order.
            created: list[str] = []
            for fact in curated:
                content = fact_content(fact)
                existing = existing_by_subject.get(subject_key(fact.subject))
                # Unchanged subject already on disk: skip the write (idempotent).
                if existing is not None and existing[1] == content:
                    continue
                fact_id = await self._write_memory(
                    content,
                    importance=resolved_importance,
                    tags=tag_list,
                    source=self._fact_source,
                    subject=fact.subject,
                    date=fact.date,
                    thread_id=thread_id,
                    agent_id=agent_id,
                    namespace=namespace,
                    ttl=None,
                    now=now,
                )
                created.append(fact_id)

            # Delete the stored fact for any subject that was superseded (its
            # content changed) or retracted (no longer in the curated set), plus
            # any duplicate rows from a prior concurrent-write race.
            to_delete: list[str] = [f"{self._name}:mem:{dup_id}" for dup_id in duplicate_fact_ids]
            for subject, (existing_id, existing_content) in existing_by_subject.items():
                curated_fact = curated_by_subject.get(subject)
                if curated_fact is None or fact_content(curated_fact) != existing_content:
                    to_delete.append(f"{self._name}:mem:{existing_id}")
            deleted = 0
            if len(to_delete) > 0:
                deleted = int(await self._client.execute_command("DEL", *to_delete))
                if deleted > 0:
                    self._telemetry.metrics.items.labels(**self._store_labels).dec(deleted)

            self._telemetry.metrics.consolidations.labels(**self._store_labels).inc()
            span.set_attribute("consolidate_facts.created", len(created))
            span.set_attribute("consolidate_facts.deleted", deleted)
            return ConsolidateFactsResult(
                candidates=len(candidates),
                facts=len(curated),
                created=created,
                deleted=deleted,
                unmatched_tombstones=unmatched_tombstones,
            )

    async def _load_existing_facts(self, scope: MemoryScope, tags: list[str]) -> list[MemoryItem]:
        # Load the fact memories already written for this scope
        # (source == fact_source), so consolidate_facts can reconcile against them.
        filter_query = build_consolidate_filter(
            scope, tags, ConsolidateFilterOptions(include_source=self._fact_source)
        )
        raw = await self._client.execute_command(
            "FT.SEARCH",
            f"{self._name}:mem:idx",
            filter_query,
            "RETURN",
            "4",
            "content",
            "subject",
            "source",
            "date",
            "LIMIT",
            "0",
            str(CONSOLIDATE_SCAN_LIMIT),
            "DIALECT",
            "2",
        )
        return [parse_memory_item(self._name, hit) for hit in parse_ft_search_response(raw)]

    async def _write_record(self, key: str, fields: list[str | bytes], ttl: int | None) -> None:
        if ttl is None or ttl <= 0:
            await self._client.execute_command("HSET", key, *fields)
            return
        # Set the hash and its expiry in one transaction so a crash between the
        # two can't leave a memory that should expire living forever.
        await self._client.execute_command("MULTI")
        try:
            await self._client.execute_command("HSET", key, *fields)
            await self._client.execute_command("EXPIRE", key, str(ttl))
            await self._client.execute_command("EXEC")
        except Exception:
            # Clear the half-built transaction so the connection isn't mid-MULTI.
            try:
                await self._client.execute_command("DISCARD")
            except Exception:
                pass
            raise

    async def _enforce_capacity(self, scope: MemoryScope, tags: list[str], now: int) -> None:
        max_items = self._max_items_per_scope
        if max_items is None:
            return
        # Snapshot the eviction tunables alongside max so an opt-in configRefresh
        # landing mid-pass can't score victims with a different weight/half-life
        # set than the capacity check ran with.
        weights = _copy_weights(self._weights)
        half_life_seconds = self._half_life_seconds
        filter_query = build_scope_filter(scope, tags)
        if filter_query == MATCH_ALL_MEMORY_QUERY:
            # A fully-unscoped write has no scope to bound: enforcing here would
            # count and evict across the entire index, which maxItemsPerScope does
            # not promise. Skip — the write stays, uncapped.
            return
        count_raw = await self._client.execute_command(
            "FT.SEARCH",
            f"{self._name}:mem:idx",
            filter_query,
            "LIMIT",
            "0",
            "0",
            "DIALECT",
            "2",
        )
        total = _ft_search_total(count_raw)
        if total <= max_items:
            return

        raw = await self._client.execute_command(
            "FT.SEARCH",
            f"{self._name}:mem:idx",
            filter_query,
            "RETURN",
            "2",
            "importance",
            "last_accessed_at",
            "LIMIT",
            "0",
            str(EVICTION_SCAN_LIMIT),
            "DIALECT",
            "2",
        )
        candidates: list[EvictionCandidate] = []
        for hit in parse_ft_search_response(raw):
            importance = js_number(hit["fields"].get("importance"))
            last_accessed_at = js_number(hit["fields"].get("last_accessed_at"))
            candidates.append(
                EvictionCandidate(
                    key=hit["key"],
                    importance=importance if math.isfinite(importance) else 0.0,
                    last_accessed_at=(last_accessed_at if math.isfinite(last_accessed_at) else 0.0),
                )
            )
        drop_count = min(total - max_items, len(candidates))
        evict_keys = select_evictions(
            candidates,
            len(candidates) - drop_count,
            SelectEvictionsOptions(now=now, half_life_seconds=half_life_seconds, weights=weights),
        )
        if len(evict_keys) == 0:
            return
        # Count actual removals, not the keys we asked to drop: the index can list
        # already-deleted keys (stale), so DEL may remove fewer.
        removed = int(await self._client.execute_command("DEL", *evict_keys))
        if not removed > 0:
            return
        await self._client.execute_command(
            "HINCRBY", f"{self._name}:__mem_stats", "evictions", str(removed)
        )
        self._telemetry.metrics.evictions.labels(**self._store_labels).inc(removed)
        self._telemetry.metrics.items.labels(**self._store_labels).dec(removed)
        self._session_counts["evicted"] += removed

    # -- embedding --------------------------------------------------------

    def _require_embed_fn(self) -> EmbedFn:
        if self._embed_fn is None:
            raise ValueError(
                "MemoryStore was constructed without an embed_fn; remember(), recall(), "
                "and ensure_index() require one. Use get/list/stats/recall_by_vector for "
                "read-only access."
            )
        return self._embed_fn

    async def _resolve_dims(self) -> int:
        if self._dims is not None:
            return self._dims
        probe = await self._require_embed_fn()("probe")
        if len(probe) == 0:
            raise ValueError(
                "Cannot resolve memory vector dimension: embed_fn returned a zero-length embedding"
            )
        self._dims = len(probe)
        return self._dims

    async def _embed(self, content: str) -> list[float]:
        self._telemetry.metrics.embedding_calls.labels(**self._store_labels).inc()
        vector = await self._require_embed_fn()(content)
        if self._dims is None:
            self._dims = len(vector)
        elif len(vector) != self._dims:
            raise ValueError(
                f"Embedding dimension mismatch: expected {self._dims}, embed_fn "
                f"returned {len(vector)}"
            )
        return vector

    # -- internals --------------------------------------------------------

    def _now_ms(self) -> int:
        return int(time.time() * 1000)

    @contextmanager
    def _span(self, operation: str) -> Iterator[Span]:
        with self._telemetry.tracer.start_as_current_span(f"agent_memory.{operation}") as span:
            try:
                yield span
            except Exception as err:
                span.set_status(Status(StatusCode.ERROR, str(err)))
                raise
            else:
                span.set_status(Status(StatusCode.OK))
