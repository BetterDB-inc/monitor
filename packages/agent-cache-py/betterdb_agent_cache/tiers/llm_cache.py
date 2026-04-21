from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from ..cluster import cluster_scan
from ..errors import ValkeyCommandError
from ..types import (
    ContentBlock,
    LlmCacheParams,
    LlmCacheResult,
    LlmStoreOptions,
    ModelCost,
)
from ..utils import escape_glob_pattern, llm_cache_hash

if TYPE_CHECKING:
    from ..telemetry import Telemetry


@dataclass
class LlmCacheConfig:
    client: Any
    name: str
    default_ttl: int | None
    tier_ttl: int | None
    cost_table: dict[str, ModelCost] | None
    telemetry: Telemetry
    stats_key: str


class LlmCache:
    def __init__(self, config: LlmCacheConfig) -> None:
        self._client = config.client
        self._name = config.name
        self._default_ttl = config.default_ttl
        self._tier_ttl = config.tier_ttl
        self._cost_table = config.cost_table
        self._telemetry = config.telemetry
        self._stats_key = config.stats_key

    def _build_key(self, hash_: str) -> str:
        return f"{self._name}:llm:{hash_}"

    def _compute_cost(self, model: str, tokens: dict[str, int]) -> float | None:
        if not self._cost_table:
            return None
        model_cost = self._cost_table.get(model)
        if not model_cost:
            return None
        return (
            (tokens["input"] / 1000) * model_cost.input_per_1k
            + (tokens["output"] / 1000) * model_cost.output_per_1k
        )

    async def check(self, params: LlmCacheParams) -> LlmCacheResult:
        start = time.monotonic()
        with self._telemetry.tracer.start_as_current_span("agent_cache.llm.check") as span:
            try:
                hash_ = llm_cache_hash(params)
                key = self._build_key(hash_)
                span.set_attribute("cache.key", key)
                span.set_attribute("cache.model", params["model"])

                try:
                    raw = await self._client.get(key)
                except Exception as exc:
                    raise ValkeyCommandError("GET", exc) from exc

                duration = time.monotonic() - start
                self._telemetry.metrics.operation_duration.labels(
                    self._name, "llm", "check"
                ).observe(duration)

                if raw:
                    raw_str = raw.decode() if isinstance(raw, bytes) else raw
                    try:
                        entry: dict[str, Any] = json.loads(raw_str)
                    except (json.JSONDecodeError, ValueError):
                        try:
                            await self._client.delete(key)
                        except Exception:
                            pass
                        await self._inc_stats({"llm:misses": 1})
                        self._telemetry.metrics.requests_total.labels(
                            self._name, "llm", "miss", ""
                        ).inc()
                        span.set_attribute("cache.hit", False)
                        span.set_attribute("cache.corrupt", True)
                        return LlmCacheResult(hit=False)

                    stat_updates: dict[str, int] = {"llm:hits": 1}
                    cost: float | None = entry.get("cost")
                    if cost is not None:
                        stat_updates["cost_saved_micros"] = round(cost * 1_000_000)
                    await self._inc_stats(stat_updates)

                    if cost is not None:
                        self._telemetry.metrics.cost_saved.labels(
                            self._name, "llm", entry.get("model", ""), ""
                        ).inc(cost)

                    self._telemetry.metrics.requests_total.labels(
                        self._name, "llm", "hit", ""
                    ).inc()
                    span.set_attribute("cache.hit", True)

                    return LlmCacheResult(
                        hit=True,
                        response=entry.get("response"),
                        content_blocks=entry.get("contentBlocks"),
                        key=key,
                    )

                await self._inc_stats({"llm:misses": 1})
                self._telemetry.metrics.requests_total.labels(
                    self._name, "llm", "miss", ""
                ).inc()
                span.set_attribute("cache.hit", False)
                return LlmCacheResult(hit=False)

            except Exception as exc:
                span.record_exception(exc)
                raise

    async def store(
        self,
        params: LlmCacheParams,
        response: str,
        options: LlmStoreOptions | None = None,
    ) -> str:
        start = time.monotonic()
        with self._telemetry.tracer.start_as_current_span("agent_cache.llm.store") as span:
            try:
                hash_ = llm_cache_hash(params)
                key = self._build_key(hash_)
                span.set_attribute("cache.key", key)
                span.set_attribute("cache.model", params["model"])

                entry: dict[str, Any] = {
                    "response": response,
                    "model": params["model"],
                    "storedAt": int(time.time() * 1000),
                }
                if options and options.tokens:
                    entry["tokens"] = options.tokens
                    cost = self._compute_cost(params["model"], options.tokens)
                    if cost is not None:
                        entry["cost"] = cost

                value_json = json.dumps(entry, separators=(",", ":"), ensure_ascii=False)
                _per_call_ttl = options.ttl if options else None
                ttl = _per_call_ttl if _per_call_ttl is not None else (self._tier_ttl if self._tier_ttl is not None else self._default_ttl)
                await self._set(key, value_json, ttl)

                byte_len = len(value_json.encode())
                self._telemetry.metrics.stored_bytes.labels(self._name, "llm").inc(byte_len)
                self._telemetry.metrics.operation_duration.labels(
                    self._name, "llm", "store"
                ).observe(time.monotonic() - start)

                span.set_attribute("cache.ttl", ttl if ttl is not None else -1)
                span.set_attribute("cache.bytes", byte_len)
                return key

            except Exception as exc:
                span.record_exception(exc)
                raise

    async def store_multipart(
        self,
        params: LlmCacheParams,
        blocks: list[ContentBlock],
        options: LlmStoreOptions | None = None,
    ) -> str:
        start = time.monotonic()
        flattened = "".join(b.get("text", "") for b in blocks if b.get("type") == "text")  # type: ignore[typeddict-item]
        with self._telemetry.tracer.start_as_current_span("agent_cache.llm.store_multipart") as span:
            try:
                hash_ = llm_cache_hash(params)
                key = self._build_key(hash_)

                entry: dict[str, Any] = {
                    "response": flattened,
                    "contentBlocks": blocks,
                    "model": params["model"],
                    "storedAt": int(time.time() * 1000),
                }
                if options and options.tokens:
                    entry["tokens"] = options.tokens
                    cost = self._compute_cost(params["model"], options.tokens)
                    if cost is not None:
                        entry["cost"] = cost

                value_json = json.dumps(entry, separators=(",", ":"), ensure_ascii=False)
                _per_call_ttl = options.ttl if options else None
                ttl = _per_call_ttl if _per_call_ttl is not None else (self._tier_ttl if self._tier_ttl is not None else self._default_ttl)
                await self._set(key, value_json, ttl)

                byte_len = len(value_json.encode())
                self._telemetry.metrics.stored_bytes.labels(self._name, "llm").inc(byte_len)
                self._telemetry.metrics.operation_duration.labels(
                    self._name, "llm", "store"
                ).observe(time.monotonic() - start)

                span.set_attribute("cache.key", key)
                span.set_attribute("cache.ttl", ttl if ttl is not None else 0)
                span.set_attribute("cache.blocks", len(blocks))
                span.set_attribute("cache.bytes", byte_len)
                return key

            except Exception as exc:
                span.record_exception(exc)
                raise

    async def invalidate_by_model(self, model: str) -> int:
        with self._telemetry.tracer.start_as_current_span(
            "agent_cache.llm.invalidate_by_model"
        ) as span:
            try:
                span.set_attribute("cache.model", model)
                pattern = f"{escape_glob_pattern(self._name)}:llm:*"
                deleted_count = 0

                async def on_keys(keys: list[str], client: Any) -> None:
                    nonlocal deleted_count
                    pipe = client.pipeline(transaction=False)
                    for k in keys:
                        pipe.get(k)
                    try:
                        results = await pipe.execute()
                    except Exception as exc:
                        raise ValkeyCommandError("GET (pipeline)", exc) from exc

                    to_delete = []
                    for k, raw in zip(keys, results):
                        if not raw:
                            continue
                        raw_str = raw.decode() if isinstance(raw, bytes) else raw
                        try:
                            if json.loads(raw_str).get("model") == model:
                                to_delete.append(k)
                        except (json.JSONDecodeError, AttributeError):
                            pass

                    if to_delete:
                        del_pipe = client.pipeline(transaction=False)
                        for k in to_delete:
                            del_pipe.delete(k)
                        try:
                            del_results = await del_pipe.execute()
                        except Exception as exc:
                            raise ValkeyCommandError("DEL", exc) from exc
                        for count in del_results:
                            deleted_count += count or 0

                await cluster_scan(self._client, pattern, on_keys)
                span.set_attribute("cache.deleted_count", deleted_count)
                return deleted_count

            except Exception as exc:
                span.record_exception(exc)
                raise

    async def _set(self, key: str, value: str, ttl: int | None) -> None:
        try:
            if ttl is not None:
                await self._client.set(key, value, ex=ttl)
            else:
                await self._client.set(key, value)
        except Exception as exc:
            raise ValkeyCommandError("SET", exc) from exc

    async def _inc_stats(self, updates: dict[str, int]) -> None:
        try:
            pipe = self._client.pipeline(transaction=False)
            for field, amount in updates.items():
                pipe.hincrby(self._stats_key, field, amount)
            await pipe.execute()
        except Exception:
            pass  # Stats failures must not break cache operations
