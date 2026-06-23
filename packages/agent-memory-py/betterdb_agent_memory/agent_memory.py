from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

from betterdb_agent_cache import AgentCache, AgentCacheOptions

from .memory_store import MemoryStore
from .telemetry import MemoryTelemetryOptions
from .types import AgentMemoryConfig, EmbedFn, _empty_memory_config

DEFAULT_NAME = "betterdb_ac"


@dataclass(kw_only=True)
class AgentMemoryOptions(AgentCacheOptions):
    """Options for the batteries-included :class:`AgentMemory` facade.

    Extends :class:`AgentCacheOptions` (the three short-term cache tiers) with
    the long-term memory tier: an ``embed_fn`` to vectorize content plus an
    optional ``memory`` sub-config.
    """

    embed_fn: EmbedFn
    memory: AgentMemoryConfig = field(default_factory=_empty_memory_config)


class AgentMemory:
    """Agent cache (llm/tool/session) plus a long-term :class:`MemoryStore` tier."""

    def __init__(self, options: AgentMemoryOptions) -> None:
        if not callable(getattr(options, "embed_fn", None)):
            raise ValueError("AgentMemory requires an embed_fn to back the memory tier")

        # The name lives on the shared options object and defaults identically in
        # both tiers, so the cache and memory key prefixes can never drift apart.
        name = options.name
        self._cache = AgentCache(options)
        self.llm = self._cache.llm
        self.tool = self._cache.tool
        self.session = self._cache.session

        memory = options.memory
        registry = options.telemetry.registry
        self.memory = MemoryStore(
            client=options.client,
            name=name,
            embed_fn=options.embed_fn,
            default_threshold=memory.default_threshold,
            weights=memory.recall.weights if memory.recall is not None else None,
            half_life_seconds=(
                memory.recall.half_life_seconds if memory.recall is not None else None
            ),
            max_items_per_scope=memory.max_items_per_scope,
            # The facade is the batteries-included product: discover the memory
            # tier alongside the cache tiers by default, unless explicitly disabled.
            discovery=memory.discovery,
            config_refresh=memory.config_refresh,
            telemetry=MemoryTelemetryOptions(registry=registry) if registry else None,
        )

    async def initialize(self) -> None:
        # Create the memory index before discovery so a freshly constructed facade
        # is immediately usable for remember/recall without the caller hand-rolling
        # the FT index. A create failure surfaces — the tier is unusable without it.
        await self.memory.ensure_index()
        # Surface a discovery name-collision from either tier instead of swallowing it.
        await asyncio.gather(
            self._cache.ensure_discovery_ready(),
            self.memory.ensure_discovery_ready(),
        )

    async def close(self) -> None:
        # Tear down both tiers even if one fails, so timers and heartbeats can't leak.
        try:
            await self.memory.close()
        finally:
            await self._cache.shutdown()
