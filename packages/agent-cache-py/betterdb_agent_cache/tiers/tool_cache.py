from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from ..cluster import cluster_scan
from ..errors import AgentCacheUsageError, ValkeyCommandError
from ..types import ToolCacheResult, ToolPolicy, ToolStoreOptions
from ..utils import escape_glob_pattern, tool_cache_hash

if TYPE_CHECKING:
    from ..telemetry import Telemetry


def _validate_tool_name(tool_name: str) -> None:
    if ":" in tool_name:
        raise AgentCacheUsageError(
            f'Tool name "{tool_name}" contains colon (:). '
            "Colons are not allowed in tool names as they are used as key delimiters."
        )


@dataclass
class ToolCacheConfig:
    client: Any
    name: str
    default_ttl: int | None
    tier_ttl: int | None
    telemetry: Telemetry
    stats_key: str


class ToolCache:
    def __init__(self, config: ToolCacheConfig) -> None:
        self._client = config.client
        self._name = config.name
        self._default_ttl = config.default_ttl
        self._tier_ttl = config.tier_ttl
        self._telemetry = config.telemetry
        self._stats_key = config.stats_key
        self._policies: dict[str, ToolPolicy] = {}
        self._policies_key = f"{self._name}:__tool_policies"

    def _build_key(self, tool_name: str, hash_: str) -> str:
        return f"{self._name}:tool:{tool_name}:{hash_}"

    async def check(self, tool_name: str, args: Any) -> ToolCacheResult:
        _validate_tool_name(tool_name)
        start = time.monotonic()
        with self._telemetry.tracer.start_as_current_span("agent_cache.tool.check") as span:
            try:
                hash_ = tool_cache_hash(args)
                key = self._build_key(tool_name, hash_)
                span.set_attribute("cache.key", key)
                span.set_attribute("cache.tool_name", tool_name)

                try:
                    raw = await self._client.get(key)
                except Exception as exc:
                    raise ValkeyCommandError("GET", exc) from exc

                duration = time.monotonic() - start
                self._telemetry.metrics.operation_duration.labels(
                    self._name, "tool", "check"
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
                        await self._inc_stats({
                            "tool:misses": 1,
                            f"tool:{tool_name}:misses": 1,
                        })
                        self._telemetry.metrics.requests_total.labels(
                            self._name, "tool", "miss", tool_name
                        ).inc()
                        span.set_attribute("cache.hit", False)
                        span.set_attribute("cache.corrupt", True)
                        return ToolCacheResult(hit=False, tool_name=tool_name)

                    stat_updates: dict[str, int] = {
                        "tool:hits": 1,
                        f"tool:{tool_name}:hits": 1,
                    }
                    cost: float | None = entry.get("cost")
                    if cost is not None:
                        cost_micros = round(cost * 1_000_000)
                        stat_updates["cost_saved_micros"] = cost_micros
                        stat_updates[f"tool:{tool_name}:cost_saved_micros"] = cost_micros
                    await self._inc_stats(stat_updates)

                    if cost is not None:
                        self._telemetry.metrics.cost_saved.labels(
                            self._name, "tool", "", tool_name
                        ).inc(cost)

                    self._telemetry.metrics.requests_total.labels(
                        self._name, "tool", "hit", tool_name
                    ).inc()
                    span.set_attribute("cache.hit", True)
                    return ToolCacheResult(
                        hit=True,
                        tool_name=tool_name,
                        response=entry.get("response"),
                        key=key,
                    )

                await self._inc_stats({
                    "tool:misses": 1,
                    f"tool:{tool_name}:misses": 1,
                })
                self._telemetry.metrics.requests_total.labels(
                    self._name, "tool", "miss", tool_name
                ).inc()
                span.set_attribute("cache.hit", False)
                return ToolCacheResult(hit=False, tool_name=tool_name)

            except Exception as exc:
                span.record_exception(exc)
                raise

    async def store(
        self,
        tool_name: str,
        args: Any,
        response: str,
        options: ToolStoreOptions | None = None,
    ) -> str:
        _validate_tool_name(tool_name)
        start = time.monotonic()
        with self._telemetry.tracer.start_as_current_span("agent_cache.tool.store") as span:
            try:
                hash_ = tool_cache_hash(args)
                key = self._build_key(tool_name, hash_)
                span.set_attribute("cache.key", key)
                span.set_attribute("cache.tool_name", tool_name)

                entry: dict[str, Any] = {
                    "response": response,
                    "toolName": tool_name,
                    "args": args,
                    "storedAt": int(time.time() * 1000),
                }
                if options and options.cost is not None:
                    entry["cost"] = options.cost

                value_json = json.dumps(entry, separators=(",", ":"), ensure_ascii=False)

                # TTL resolution: per-call → policy → tier → default
                policy = self._policies.get(tool_name)
                _per_call_ttl = options.ttl if options else None
                _policy_ttl = policy.ttl if policy else None
                ttl = next(
                    (t for t in (_per_call_ttl, _policy_ttl, self._tier_ttl, self._default_ttl) if t is not None),
                    None,
                )
                await self._set(key, value_json, ttl)

                byte_len = len(value_json.encode())
                self._telemetry.metrics.stored_bytes.labels(self._name, "tool").inc(byte_len)
                self._telemetry.metrics.operation_duration.labels(
                    self._name, "tool", "store"
                ).observe(time.monotonic() - start)

                span.set_attribute("cache.ttl", ttl if ttl is not None else -1)
                span.set_attribute("cache.bytes", byte_len)
                return key

            except Exception as exc:
                span.record_exception(exc)
                raise

    async def set_policy(self, tool_name: str, policy: ToolPolicy) -> None:
        _validate_tool_name(tool_name)
        self._policies[tool_name] = policy
        try:
            await self._client.hset(
                self._policies_key, tool_name, json.dumps({"ttl": policy.ttl})
            )
        except Exception as exc:
            raise ValkeyCommandError("HSET", exc) from exc

    def get_policy(self, tool_name: str) -> ToolPolicy | None:
        return self._policies.get(tool_name)

    def list_policy_names(self) -> list[str]:
        return list(self._policies.keys())

    async def invalidate_by_tool(self, tool_name: str) -> int:
        with self._telemetry.tracer.start_as_current_span(
            "agent_cache.tool.invalidate_by_tool"
        ) as span:
            try:
                span.set_attribute("cache.tool_name", tool_name)
                pattern = (
                    f"{escape_glob_pattern(self._name)}"
                    f":tool:{escape_glob_pattern(tool_name)}:*"
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
                span.set_attribute("cache.deleted_count", deleted_count)
                return deleted_count

            except Exception as exc:
                span.record_exception(exc)
                raise

    async def invalidate(self, tool_name: str, args: Any) -> bool:
        hash_ = tool_cache_hash(args)
        key = self._build_key(tool_name, hash_)
        try:
            deleted = await self._client.delete(key)
            return deleted > 0
        except Exception as exc:
            raise ValkeyCommandError("DEL", exc) from exc

    async def refresh_policies(self) -> bool:
        """Refresh policies from Valkey with an atomic swap.

        Clears the in-memory map and repopulates it from HGETALL so that
        policies deleted externally (HDEL) are also removed locally.

        Returns ``True`` on a successful HGETALL, ``False`` if the call threw.
        Used by the periodic refresh loop to drive the
        ``config_refresh_failed`` counter.
        """
        try:
            raw = await self._client.hgetall(self._policies_key)
        except Exception:
            return False

        next_policies: dict[str, ToolPolicy] = {}
        if raw:
            for tool_name, policy_json in raw.items():
                tool_name_str = (
                    tool_name.decode() if isinstance(tool_name, bytes) else tool_name
                )
                policy_str = (
                    policy_json.decode() if isinstance(policy_json, bytes) else policy_json
                )
                try:
                    data = json.loads(policy_str)
                    next_policies[tool_name_str] = ToolPolicy(ttl=data["ttl"])
                except (json.JSONDecodeError, KeyError):
                    pass  # Skip corrupt entries

        self._policies.clear()
        self._policies.update(next_policies)
        return True

    async def load_policies(self) -> None:
        """Load policies from Valkey. Delegates to refresh_policies()."""
        await self.refresh_policies()

    def reset_policies(self) -> None:
        """Clear in-memory policies. Called by AgentCache.flush()."""
        self._policies.clear()

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
            pass
