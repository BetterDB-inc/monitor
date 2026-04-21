from __future__ import annotations

import asyncio
import re
from typing import Any

from .analytics import NOOP_ANALYTICS, Analytics, create_analytics
from .cluster import cluster_scan
from .errors import ValkeyCommandError
from .telemetry import create_telemetry
from .tiers.llm_cache import LlmCache, LlmCacheConfig
from .tiers.session_store import SessionStore, SessionStoreConfig
from .tiers.tool_cache import ToolCache, ToolCacheConfig
from .types import (
    AgentCacheOptions,
    AgentCacheStats,
    SessionStats,
    TierStats,
    ToolEffectivenessEntry,
    ToolStats,
)
from .utils import escape_glob_pattern


class AgentCache:
    """Multi-tier exact-match cache for AI agent workloads backed by Valkey.

    Tiers:
    - ``llm``     — LLM response cache (check / store / store_multipart)
    - ``tool``    — Tool call result cache (check / store / set_policy)
    - ``session`` — Session state store (get / set / get_all / destroy_thread)
    """

    def __init__(self, options: AgentCacheOptions) -> None:
        self._client = options.client
        self._name = options.name
        self._stats_key = f"{self._name}:__stats"
        self._default_ttl = options.default_ttl
        self._tool_tier_ttl = options.tier_defaults.get("tool", None)
        self._cost_table = options.cost_table
        self._analytics_opts = options.analytics
        self._analytics: Analytics = NOOP_ANALYTICS
        self._stats_task: asyncio.Task[None] | None = None
        self._shutdown = False

        telemetry = create_telemetry(
            prefix=options.telemetry.metrics_prefix,
            tracer_name=options.telemetry.tracer_name,
            registry=options.telemetry.registry,
        )

        self.llm = LlmCache(LlmCacheConfig(
            client=self._client,
            name=self._name,
            default_ttl=options.default_ttl,
            tier_ttl=options.tier_defaults.get("llm", None) and options.tier_defaults["llm"].ttl,
            cost_table=options.cost_table or None,
            telemetry=telemetry,
            stats_key=self._stats_key,
        ))

        self.tool = ToolCache(ToolCacheConfig(
            client=self._client,
            name=self._name,
            default_ttl=options.default_ttl,
            tier_ttl=options.tier_defaults.get("tool", None) and options.tier_defaults["tool"].ttl,
            telemetry=telemetry,
            stats_key=self._stats_key,
        ))

        self.session = SessionStore(SessionStoreConfig(
            client=self._client,
            name=self._name,
            default_ttl=options.default_ttl,
            tier_ttl=(
                options.tier_defaults.get("session", None)
                and options.tier_defaults["session"].ttl
            ),
            telemetry=telemetry,
            stats_key=self._stats_key,
        ))

        # Fire-and-forget: load persisted tool policies and initialise analytics.
        # Uses get_running_loop() so this is a no-op when AgentCache is created
        # outside an async context (policies will be empty until next load).
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(self._load_policies_safe())
            loop.create_task(self._init_analytics_safe())
        except RuntimeError:
            pass

    async def _load_policies_safe(self) -> None:
        try:
            await self.tool.load_policies()
        except Exception:
            pass

    async def _init_analytics_safe(self) -> None:
        try:
            opts = self._analytics_opts
            analytics = await create_analytics(
                api_key=opts.api_key,
                host=opts.host,
                disabled=opts.disabled,
            )
            if self._shutdown:
                await analytics.shutdown()
                return
            self._analytics = analytics
            await analytics.init(self._client, self._name, {
                "default_ttl": self._default_ttl,
                "has_cost_table": bool(self._cost_table),
            })
            if not self._shutdown and opts.stats_interval_s > 0:
                self._stats_task = asyncio.create_task(self._stats_loop(opts.stats_interval_s))
        except Exception:
            pass

    async def _stats_loop(self, interval_s: float) -> None:
        while not self._shutdown:
            try:
                await asyncio.sleep(interval_s)
                if self._shutdown:
                    break
                s = await self.stats()
                self._analytics.capture("stats_snapshot", {
                    "llm_hits": s.llm.hits,
                    "llm_misses": s.llm.misses,
                    "llm_hit_rate": s.llm.hit_rate,
                    "tool_hits": s.tool.hits,
                    "tool_misses": s.tool.misses,
                    "tool_hit_rate": s.tool.hit_rate,
                    "session_reads": s.session.reads,
                    "session_writes": s.session.writes,
                    "cost_saved_micros": s.cost_saved_micros,
                    "tool_count": len(s.per_tool),
                })
            except asyncio.CancelledError:
                break
            except Exception:
                pass

    async def stats(self) -> AgentCacheStats:
        try:
            raw: dict[bytes | str, bytes | str] = await self._client.hgetall(self._stats_key) or {}
        except Exception as exc:
            raise ValkeyCommandError("HGETALL", exc) from exc

        def decode(v: bytes | str) -> str:
            return v.decode() if isinstance(v, bytes) else v

        def get_int(field: str) -> int:
            val = raw.get(field) or raw.get(field.encode())
            return int(decode(val)) if val else 0

        llm_hits = get_int("llm:hits")
        llm_misses = get_int("llm:misses")
        tool_hits = get_int("tool:hits")
        tool_misses = get_int("tool:misses")

        per_tool: dict[str, ToolStats] = {}
        pattern = re.compile(r"^tool:([^:]+):(hits|misses|cost_saved_micros)$")

        for raw_key, raw_val in raw.items():
            key = decode(raw_key)
            match = pattern.match(key)
            if not match:
                continue
            tool_name, stat_type = match.group(1), match.group(2)
            num = int(decode(raw_val))
            if tool_name not in per_tool:
                policy = self.tool.get_policy(tool_name)
                per_tool[tool_name] = ToolStats(
                    hits=0, misses=0, ttl=policy.ttl if policy else None, cost_saved_micros=0
                )
            entry = per_tool[tool_name]
            if stat_type == "hits":
                entry.hits = num
            elif stat_type == "misses":
                entry.misses = num
            elif stat_type == "cost_saved_micros":
                entry.cost_saved_micros = num

        return AgentCacheStats(
            llm=TierStats(hits=llm_hits, misses=llm_misses),
            tool=TierStats(hits=tool_hits, misses=tool_misses),
            session=SessionStats(reads=get_int("session:reads"), writes=get_int("session:writes")),
            cost_saved_micros=get_int("cost_saved_micros"),
            per_tool=per_tool,
        )

    async def tool_effectiveness(self) -> list[ToolEffectivenessEntry]:
        stats = await self.stats()
        entries: list[ToolEffectivenessEntry] = []

        tool_tier = self._tool_tier_ttl
        tool_tier_ttl = tool_tier.ttl if tool_tier else None

        for tool_name, tool_stats in stats.per_tool.items():
            cost_saved = tool_stats.cost_saved_micros / 1_000_000
            policy = self.tool.get_policy(tool_name)
            effective_ttl = (policy.ttl if policy else None) or tool_tier_ttl or self._default_ttl

            if tool_stats.hit_rate > 0.8:
                recommendation = (
                    "increase_ttl"
                    if effective_ttl is not None and effective_ttl < 3600
                    else "optimal"
                )
            elif tool_stats.hit_rate >= 0.4:
                recommendation = "optimal"
            else:
                recommendation = "decrease_ttl_or_disable"

            entries.append(ToolEffectivenessEntry(
                tool=tool_name,
                hit_rate=tool_stats.hit_rate,
                cost_saved=cost_saved,
                recommendation=recommendation,
            ))

        entries.sort(key=lambda e: e.cost_saved, reverse=True)
        return entries

    async def flush(self) -> None:
        pattern = f"{escape_glob_pattern(self._name)}:*"
        try:
            async def on_keys(keys: list[str], client: Any) -> None:
                pipe = client.pipeline(transaction=False)
                for k in keys:
                    pipe.delete(k)
                try:
                    results = await pipe.execute()
                except Exception as exc:
                    raise ValkeyCommandError("DEL", exc) from exc
                for err in results:
                    if isinstance(err, Exception):
                        raise ValkeyCommandError("DEL", err)

            await cluster_scan(self._client, pattern, on_keys)
        finally:
            self.session.reset_tracker()
            self.tool.reset_policies()
            self._analytics.capture("cache_flush")

    async def shutdown(self) -> None:
        self._shutdown = True
        if self._stats_task is not None:
            self._stats_task.cancel()
            self._stats_task = None
        await self._analytics.shutdown()
