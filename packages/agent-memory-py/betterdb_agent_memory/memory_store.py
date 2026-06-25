from __future__ import annotations

import asyncio
import math
import time
import uuid
import warnings
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from betterdb_valkey_search_kit import (
    encode_float32,
    is_index_not_found_error,
    parse_ft_search_response,
)
from opentelemetry.trace import Span, Status, StatusCode

from ._num import js_number
from .build_memory_index import build_memory_index_args, memory_index_name
from .build_memory_record import build_memory_record
from .build_recall_query import (
    SCORE_FIELD,
    ConsolidateFilterOptions,
    build_consolidate_filter,
    build_recall_query,
    build_scope_filter,
)
from .composite_score import composite_score, similarity_from_distance
from .discovery import MemoryDiscovery
from .parse_memory_item import parse_memory_item
from .select_evictions import EvictionCandidate, SelectEvictionsOptions, select_evictions
from .telemetry import MemoryTelemetryOptions, create_memory_telemetry
from .types import (
    ConsolidateResult,
    EmbedFn,
    MemoryConfigRefreshConfig,
    MemoryConfigSnapshot,
    MemoryDiscoveryConfig,
    MemoryHit,
    MemoryScope,
    MemoryStoreClient,
    RecallWeights,
    SummarizeFn,
)

DEFAULT_THRESHOLD = 0.25
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
DEFAULT_IMPORTANCE = 0.5
DEFAULT_CONFIG_REFRESH_MS = 30000
MIN_CONFIG_REFRESH_MS = 1000
MAX_DISTANCE = 2


def _package_version() -> str:
    try:
        from importlib.metadata import version

        return version("betterdb-agent-memory")
    except Exception:
        return "0.0.0"


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
        embed_fn: EmbedFn,
        default_threshold: float | None = None,
        weights: RecallWeights | None = None,
        half_life_seconds: float | None = None,
        max_items_per_scope: int | None = None,
        discovery: bool | MemoryDiscoveryConfig = False,
        config_refresh: bool | MemoryConfigRefreshConfig | None = None,
        telemetry: MemoryTelemetryOptions | None = None,
    ) -> None:
        self._client = client
        self._name = name
        self._embed_fn = embed_fn
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

    # -- index ------------------------------------------------------------

    async def ensure_index(self) -> None:
        """Create the ``{name}:mem:idx`` vector index if it does not already exist.

        Idempotent — an existing index is left untouched. Resolves the vector
        dimension from ``embed_fn`` when it has not been observed yet.
        """
        try:
            await self._client.execute_command("FT.INFO", memory_index_name(self._name))
            return
        except Exception as err:
            if not is_index_not_found_error(err):
                raise
        dims = await self._resolve_dims()
        await self._client.execute_command("FT.CREATE", *build_memory_index_args(self._name, dims))

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
        with self._span("recall") as span:
            started_at = time.monotonic()
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

            vector = await self._embed(query)
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
            for hit in parse_ft_search_response(raw):
                raw_score = hit["fields"].get(SCORE_FIELD)
                if raw_score is None or raw_score.strip() == "":
                    continue
                distance = js_number(raw_score)
                if not math.isfinite(distance) or distance > threshold_value:
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
            self._record_recall(len(result), time.monotonic() - started_at)

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
        removed = int(await self._client.execute_command("DEL", f"{self._name}:mem:{id}"))
        if removed > 0:
            self._telemetry.metrics.items.labels(**self._store_labels).dec(removed)
        return removed > 0

    async def forget_by_scope(
        self,
        *,
        thread_id: str | None = None,
        agent_id: str | None = None,
        namespace: str | None = None,
        tags: list[str] | None = None,
    ) -> int:
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
        return deleted

    # -- write ------------------------------------------------------------

    async def _write_memory(
        self,
        content: str,
        *,
        importance: float | None,
        tags: list[str] | None,
        source: str | None,
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
                "LIMIT",
                "0",
                str(CONSOLIDATE_SCAN_LIMIT),
                "DIALECT",
                "2",
            )
            candidates = [
                parse_memory_item(self._name, hit) for hit in parse_ft_search_response(raw)
            ]
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
            span.set_attribute("consolidate.created", 1)
            span.set_attribute("consolidate.deleted", deleted)
            return ConsolidateResult(
                consolidated=len(candidates), created=[summary_id], deleted=deleted
            )

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
        if filter_query == "*":
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

    # -- embedding --------------------------------------------------------

    async def _resolve_dims(self) -> int:
        if self._dims is not None:
            return self._dims
        probe = await self._embed_fn("probe")
        if len(probe) == 0:
            raise ValueError(
                "Cannot resolve memory vector dimension: embed_fn returned a zero-length embedding"
            )
        self._dims = len(probe)
        return self._dims

    async def _embed(self, content: str) -> list[float]:
        self._telemetry.metrics.embedding_calls.labels(**self._store_labels).inc()
        vector = await self._embed_fn(content)
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
