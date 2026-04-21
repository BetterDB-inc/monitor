from __future__ import annotations

import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from ..cluster import cluster_scan
from ..errors import ValkeyCommandError
from ..utils import escape_glob_pattern

if TYPE_CHECKING:
    from ..telemetry import Telemetry


class SessionTracker:
    """Bounded LRU tracker for active sessions.

    Tracks thread IDs seen since the last flush, capped at max_size to prevent
    unbounded memory growth. Eviction is O(n) but n is bounded — acceptable for
    typical agent workloads.
    """

    def __init__(self, max_size: int = 10_000) -> None:
        self._max_size = max_size
        self._seen: dict[str, float] = {}

    def add(self, thread_id: str) -> tuple[bool, str | None]:
        """Track a thread. Returns (is_new, evicted_thread_id)."""
        if thread_id in self._seen:
            self._seen[thread_id] = time.monotonic()
            return False, None

        evicted: str | None = None
        if len(self._seen) >= self._max_size:
            oldest = min(self._seen, key=self._seen.__getitem__)
            del self._seen[oldest]
            evicted = oldest

        self._seen[thread_id] = time.monotonic()
        return True, evicted

    def remove(self, thread_id: str) -> bool:
        return self._seen.pop(thread_id, None) is not None

    def reset(self) -> int:
        count = len(self._seen)
        self._seen.clear()
        return count


@dataclass
class SessionStoreConfig:
    client: Any
    name: str
    default_ttl: int | None
    tier_ttl: int | None
    telemetry: Telemetry
    stats_key: str


class SessionStore:
    def __init__(self, config: SessionStoreConfig) -> None:
        self._client = config.client
        self._name = config.name
        self._default_ttl = config.default_ttl
        self._tier_ttl = config.tier_ttl
        self._telemetry = config.telemetry
        self._stats_key = config.stats_key
        self._tracker = SessionTracker()

    def _build_key(self, thread_id: str, field: str) -> str:
        return f"{self._name}:session:{thread_id}:{field}"

    async def get(self, thread_id: str, field: str) -> str | None:
        start = time.monotonic()
        with self._telemetry.tracer.start_as_current_span("agent_cache.session.get") as span:
            try:
                key = self._build_key(thread_id, field)
                span.set_attribute("cache.key", key)
                span.set_attribute("cache.thread_id", thread_id)
                span.set_attribute("cache.field", field)

                try:
                    raw = await self._client.get(key)
                except Exception as exc:
                    raise ValkeyCommandError("GET", exc) from exc

                self._telemetry.metrics.operation_duration.labels(
                    self._name, "session", "get"
                ).observe(time.monotonic() - start)

                try:
                    await self._client.hincrby(self._stats_key, "session:reads", 1)
                except Exception:
                    pass

                value: str | None = None
                if raw is not None:
                    value = raw.decode() if isinstance(raw, bytes) else raw
                    ttl = self._tier_ttl or self._default_ttl
                    if ttl is not None:
                        try:
                            await self._client.expire(key, ttl)
                        except Exception:
                            pass

                span.set_attribute("cache.hit", value is not None)
                return value

            except Exception as exc:
                span.record_exception(exc)
                raise

    async def set(self, thread_id: str, field: str, value: str, ttl: int | None = None) -> None:
        start = time.monotonic()
        with self._telemetry.tracer.start_as_current_span("agent_cache.session.set") as span:
            try:
                key = self._build_key(thread_id, field)
                span.set_attribute("cache.key", key)
                span.set_attribute("cache.thread_id", thread_id)
                span.set_attribute("cache.field", field)

                effective_ttl = ttl or self._tier_ttl or self._default_ttl
                try:
                    if effective_ttl is not None:
                        await self._client.set(key, value, ex=effective_ttl)
                    else:
                        await self._client.set(key, value)
                except Exception as exc:
                    raise ValkeyCommandError("SET", exc) from exc

                try:
                    await self._client.hincrby(self._stats_key, "session:writes", 1)
                except Exception:
                    pass

                is_new, evicted = self._tracker.add(thread_id)
                if is_new:
                    self._telemetry.metrics.active_sessions.labels(self._name).inc()
                if evicted is not None:
                    self._telemetry.metrics.active_sessions.labels(self._name).dec()

                byte_len = len(value.encode())
                self._telemetry.metrics.stored_bytes.labels(self._name, "session").inc(byte_len)
                self._telemetry.metrics.operation_duration.labels(
                    self._name, "session", "set"
                ).observe(time.monotonic() - start)

                span.set_attribute("cache.ttl", effective_ttl if effective_ttl is not None else -1)
                span.set_attribute("cache.bytes", byte_len)

            except Exception as exc:
                span.record_exception(exc)
                raise

    async def get_all(self, thread_id: str) -> dict[str, str]:
        with self._telemetry.tracer.start_as_current_span("agent_cache.session.get_all") as span:
            try:
                span.set_attribute("cache.thread_id", thread_id)
                pattern = (
                    f"{escape_glob_pattern(self._name)}"
                    f":session:{escape_glob_pattern(thread_id)}:*"
                )
                prefix = f"{self._name}:session:{thread_id}:"
                ttl = self._tier_ttl or self._default_ttl
                result: dict[str, str] = {}

                async def on_keys(keys: list[str], client: Any) -> None:
                    pipe = client.pipeline(transaction=False)
                    for k in keys:
                        pipe.get(k)
                    try:
                        values = await pipe.execute()
                    except Exception as exc:
                        raise ValkeyCommandError("GET (pipeline)", exc) from exc

                    keys_to_refresh = []
                    for k, raw in zip(keys, values):
                        if raw is None:
                            continue
                        result[k[len(prefix):]] = (
                            raw.decode() if isinstance(raw, bytes) else raw
                        )
                        keys_to_refresh.append(k)

                    if ttl is not None and keys_to_refresh:
                        exp_pipe = client.pipeline(transaction=False)
                        for k in keys_to_refresh:
                            exp_pipe.expire(k, ttl)
                        try:
                            await exp_pipe.execute()
                        except Exception:
                            pass

                await cluster_scan(self._client, pattern, on_keys)
                span.set_attribute("cache.field_count", len(result))
                return result

            except Exception as exc:
                span.record_exception(exc)
                raise

    async def scan_fields_by_prefix(
        self, thread_id: str, field_prefix: str
    ) -> dict[str, str]:
        """Scan fields matching a prefix without refreshing TTL."""
        pattern = (
            f"{escape_glob_pattern(self._name)}"
            f":session:{escape_glob_pattern(thread_id)}"
            f":{escape_glob_pattern(field_prefix)}*"
        )
        key_prefix = f"{self._name}:session:{thread_id}:"
        result: dict[str, str] = {}

        async def on_keys(keys: list[str], client: Any) -> None:
            pipe = client.pipeline(transaction=False)
            for k in keys:
                pipe.get(k)
            try:
                values = await pipe.execute()
            except Exception as exc:
                raise ValkeyCommandError("GET (pipeline)", exc) from exc
            for k, raw in zip(keys, values):
                if raw is None:
                    continue
                result[k[len(key_prefix):]] = (
                    raw.decode() if isinstance(raw, bytes) else raw
                )

        await cluster_scan(self._client, pattern, on_keys)
        return result

    async def delete(self, thread_id: str, field: str) -> bool:
        key = self._build_key(thread_id, field)
        try:
            deleted = await self._client.delete(key)
            return deleted > 0
        except Exception as exc:
            raise ValkeyCommandError("DEL", exc) from exc

    async def destroy_thread(self, thread_id: str) -> int:
        with self._telemetry.tracer.start_as_current_span(
            "agent_cache.session.destroy_thread"
        ) as span:
            try:
                span.set_attribute("cache.thread_id", thread_id)
                pattern = (
                    f"{escape_glob_pattern(self._name)}"
                    f":session:{escape_glob_pattern(thread_id)}:*"
                )
                deleted_count = 0

                async def on_keys(keys: list[str], client: Any) -> None:
                    nonlocal deleted_count
                    pipe = client.pipeline(transaction=False)
                    for k in keys:
                        pipe.delete(k)
                    try:
                        results = await pipe.execute()
                    except Exception as exc:
                        raise ValkeyCommandError("DEL", exc) from exc
                    for count in results:
                        deleted_count += count or 0

                await cluster_scan(self._client, pattern, on_keys)

                if self._tracker.remove(thread_id):
                    self._telemetry.metrics.active_sessions.labels(self._name).dec()

                span.set_attribute("cache.deleted_count", deleted_count)
                return deleted_count

            except Exception as exc:
                span.record_exception(exc)
                raise

    async def touch(self, thread_id: str) -> None:
        with self._telemetry.tracer.start_as_current_span("agent_cache.session.touch") as span:
            try:
                span.set_attribute("cache.thread_id", thread_id)
                ttl = self._tier_ttl or self._default_ttl
                if ttl is None:
                    return

                pattern = (
                    f"{escape_glob_pattern(self._name)}"
                    f":session:{escape_glob_pattern(thread_id)}:*"
                )
                touched_count = 0

                async def on_keys(keys: list[str], client: Any) -> None:
                    nonlocal touched_count
                    pipe = client.pipeline(transaction=False)
                    for k in keys:
                        pipe.expire(k, ttl)
                    try:
                        await pipe.execute()
                        touched_count += len(keys)
                    except Exception as exc:
                        raise ValkeyCommandError("EXPIRE", exc) from exc

                await cluster_scan(self._client, pattern, on_keys)
                span.set_attribute("cache.touched_count_approx", touched_count)

            except Exception as exc:
                span.record_exception(exc)
                raise

    def reset_tracker(self) -> None:
        """Reset the in-memory session tracker. Called by AgentCache.flush()."""
        self._tracker.reset()
        self._telemetry.metrics.active_sessions.labels(self._name).set(0)
